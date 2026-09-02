package mirror_svc

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/api/device"
	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/pkg/wireversion"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// ── 假的「一台 daemon + 它那条中继」──────────────────────────────────────────
//
// 它兑现 relay_svc 的三个动作,并且**照真 daemon 的样子逐通道鉴权**:中继上每条虚拟
// 通道在 daemon 那侧都是一条独立的 rpc.Conn(agentre/internal/daemon/daemon.go
// serveRelayChannels),bindConn 跑在鉴权之前,而 wrapGuarded 对每个非 auth.* 方法都
// 过 requireAuth。没握手就发 session.* 一律 Unauthorized —— 少了握手这一步,下面每个
// 用例都会红。

type fakeChannel struct {
	writer          relay_svc.FrameWriter
	authed          bool
	credential      string
	fingerprint     string
	protocolVersion string
	methods         []agentrewire.RpcMethod
}

type fakeDaemonNet struct {
	mu       sync.Mutex
	peer     *fakeRelay // 会话清单 / 通知日志 / 高水位,复用镜像逻辑那一层的假中继
	online   bool
	broken   map[string]bool // 这些机器在线,但连接建不起来
	channels map[string]*fakeChannel
	order    []string // 通道建立顺序
	connects int
	attaches int
	detaches int
}

func newFakeDaemonNet(peer *fakeRelay) *fakeDaemonNet {
	return &fakeDaemonNet{
		peer: peer, online: true,
		broken: map[string]bool{}, channels: map[string]*fakeChannel{},
	}
}

func (f *fakeDaemonNet) ConnectClient(_ context.Context, accountID int64, fingerprint string) (relay_svc.Route, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.online {
		return relay_svc.Route{}, relay_svc.ErrDaemonOffline
	}
	if f.broken[fingerprint] {
		// 「在线但连不上」:与离线分开的那一类失败(中继报错、路由过期)。
		return relay_svc.Route{}, fmt.Errorf("%w: relay is having a bad day", relay_svc.ErrForwardFailed)
	}
	f.connects++
	return relay_svc.Route{AccountID: accountID, Fingerprint: fingerprint, InstanceID: "fake-instance"}, nil
}

func (f *fakeDaemonNet) IsDaemonOnline(context.Context, int64, string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.online, nil
}

func (f *fakeDaemonNet) AttachClient(_ context.Context, _ relay_svc.Route, writer relay_svc.FrameWriter) (string, func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attaches++
	id := fmt.Sprintf("ch-%d", f.attaches)
	f.channels[id] = &fakeChannel{writer: writer}
	f.order = append(f.order, id)
	var once sync.Once
	return id, func() {
		once.Do(func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.detaches++
			delete(f.channels, id)
		})
	}, nil
}

func (f *fakeDaemonNet) ForwardClient(ctx context.Context, _ relay_svc.Route, channelID string, _ int, frame []byte) error {
	f.mu.Lock()
	ch := f.channels[channelID]
	f.mu.Unlock()
	if ch == nil {
		return fmt.Errorf("%w: unknown channel %s", relay_svc.ErrForwardFailed, channelID)
	}
	if len(frame) == 0 {
		return nil // 通道关闭信号
	}
	frameEnvelope, err := relaywire.DecodeFrame(frame)
	if err != nil || frameEnvelope.GetRequest() == nil {
		return nil
	}
	request := frameEnvelope.GetRequest()
	method := agentrewire.RpcMethod(request.GetMethodId())
	f.mu.Lock()
	ch.methods = append(ch.methods, method)
	f.mu.Unlock()
	response := &agentrewire.RpcFrame{Id: frameEnvelope.GetId()}
	switch {
	case method == agentrewire.RpcMethod_RPC_METHOD_AUTH_ACCOUNT:
		p := &agentrewire.AuthAccountRequest{}
		// AuthAccountRequest 已经没有可以自报身份的字段(决策 8):对端身份只从已验签
		// 凭据的 pfp claim 取,所以这里能校验的只剩「有没有凭据」。
		if proto.Unmarshal(request.GetEncodedPayload(), p) != nil || p.GetCredential() == "" {
			response.Body = &agentrewire.RpcFrame_Error{Error: &agentrewire.RpcError{
				Code: -32602, Message: "invalid params",
			}}
			break
		}
		f.mu.Lock()
		ch.protocolVersion = p.GetProtocolVersion()
		f.mu.Unlock()
		// 真对端(agentred 的 protobuf registry / 桌面端的 peer registry)在看凭据之前
		// 先按**精确匹配**校验协议版本,并且把空串判成「对端太旧」——proto3 下缺字段与
		// 显式空串同为零值。假对端照抄这条,否则「握手少带一个字段」在这里永远是绿的。
		if p.GetProtocolVersion() != wireversion.Protocol {
			response.Body = &agentrewire.RpcFrame_Error{Error: &agentrewire.RpcError{
				Code: -32006, Message: "protocol version mismatch",
			}}
			break
		}
		f.mu.Lock()
		ch.authed, ch.credential = true, p.GetCredential()
		f.mu.Unlock()
		encoded, marshalErr := proto.Marshal(&agentrewire.AuthAccountResponse{Ok: true, InstanceUuid: "fake"})
		if marshalErr != nil {
			return marshalErr
		}
		response.Body = &agentrewire.RpcFrame_Response{Response: &agentrewire.Response{
			MethodId: request.GetMethodId(), EncodedPayload: encoded,
		}}
	case !ch.authed:
		// daemon 的 requireAuth:没握手的通道上,补齐族一个方法都不受理。
		response.Body = &agentrewire.RpcFrame_Error{Error: &agentrewire.RpcError{Code: -32001, Message: "Unauthorized"}}
	default:
		result, callErr := f.dispatch(ctx, method, request.GetEncodedPayload())
		if callErr != nil {
			// 对端自己给出的错误码原样转回(老 daemon 对未知方法回 -32601);
			// 一律折成 -32000 会让调用方分不出「这一次没删成」与「它这辈子都不认识
			// 这个方法」。
			var wireErr *relaywire.Error
			if errors.As(callErr, &wireErr) {
				response.Body = &agentrewire.RpcFrame_Error{Error: &agentrewire.RpcError{
					Code: wireErr.Code, Message: wireErr.Message, Details: wireErr.Details,
				}}
			} else {
				response.Body = &agentrewire.RpcFrame_Error{Error: &agentrewire.RpcError{
					Code: -32000, Message: callErr.Error(),
				}}
			}
			break
		}
		encoded, marshalErr := proto.Marshal(result)
		if marshalErr != nil {
			return marshalErr
		}
		response.Body = &agentrewire.RpcFrame_Response{Response: &agentrewire.Response{
			MethodId: request.GetMethodId(), EncodedPayload: encoded,
		}}
	}
	encoded, err := relaywire.EncodeFrame(response)
	if err != nil {
		return err
	}
	return ch.writer.WriteMessage(websocket.BinaryMessage, encoded)
}

func (f *fakeDaemonNet) dispatch(
	ctx context.Context, method agentrewire.RpcMethod, payload []byte,
) (proto.Message, error) {
	switch method {
	case agentrewire.RpcMethod_RPC_METHOD_SESSION_LIST:
		request := &agentrewire.SessionListRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.SessionList(ctx, request)
	case agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH:
		request := &agentrewire.SessionAttachRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.SessionAttach(ctx, request)
	case agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL:
		request := &agentrewire.SessionPullRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.SessionPull(ctx, request)
	case agentrewire.RpcMethod_RPC_METHOD_SESSION_DELETE:
		request := &agentrewire.SessionDeleteRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.SessionDelete(ctx, request)
	case agentrewire.RpcMethod_RPC_METHOD_ACTIVITY_ROLLUP:
		request := &agentrewire.ActivityRollupRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.ActivityRollup(ctx, request)
	case agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_SCAN:
		request := &agentrewire.TranscriptImportScanRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.TranscriptImportScan(ctx, request)
	case agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_OPEN:
		request := &agentrewire.TranscriptImportOpenRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.TranscriptImportOpen(ctx, request)
	case agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_TURNS:
		request := &agentrewire.TranscriptImportTurnsRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.TranscriptImportTurns(ctx, request)
	case agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_EXECUTE:
		request := &agentrewire.TranscriptImportExecuteRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.TranscriptImportExecute(ctx, request)
	default:
		return nil, &relaywire.Error{Code: relaywire.CodeMethodNotFound, Message: "Method not found"}
	}
}

// emit 让 daemon 朝已经握过手的通道推一条实时通知。
func (f *fakeDaemonNet) emit(t *testing.T, notification *agentrewire.RpcNotification) {
	t.Helper()
	encoded, err := relaywire.EncodeFrame(&agentrewire.RpcFrame{Body: &agentrewire.RpcFrame_Notification{
		Notification: notification,
	}})
	require.NoError(t, err)
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ch := range f.channels {
		if ch.authed {
			require.NoError(t, ch.writer.WriteMessage(websocket.BinaryMessage, encoded))
		}
	}
}

// failConnect 让某台机器「在线但连不上」。
func (f *fakeDaemonNet) failConnect(fingerprint string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.broken[fingerprint] = true
}

func (f *fakeDaemonNet) setOnline(online bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.online = online
}

func (f *fakeDaemonNet) counts() (int, int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connects, f.attaches, f.detaches
}

// firstChannel 交出最早建立的那条通道的握手实况(方法顺序 / 凭据 / 自报指纹)。
func (f *fakeDaemonNet) firstChannel(t *testing.T) fakeChannel {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.order, "一条通道都没建起来")
	ch, ok := f.channels[f.order[0]]
	require.True(t, ok, "第一条通道已经被摘掉了")
	return fakeChannel{authed: ch.authed, credential: ch.credential,
		fingerprint: ch.fingerprint, protocolVersion: ch.protocolVersion,
		methods: append([]agentrewire.RpcMethod(nil), ch.methods...)}
}

// ── 共享的假库:两个副本读写同一份数据,幂等键与真表一致 ──────────────────────

type frameWrite struct {
	conversationID string
	seq            int64
}

type fakeStore struct {
	mu        sync.Mutex
	summaries map[string]agent_session_entity.SessionSummary
	rows      map[string]agent_session_entity.JournalFrame
	// writes 是每一次**写入尝试**,不是落库的行:接手方要是从 0 重拉,唯一键会把它
	// 折成无操作、库里看不出异样,只有这里数得出来。
	writes []frameWrite
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		summaries: map[string]agent_session_entity.SessionSummary{},
		rows:      map[string]agent_session_entity.JournalFrame{},
	}
}

func identityOfRow(userID int64, conversationID string) string {
	return fmt.Sprintf("%d|%s", userID, conversationID)
}

func (s *fakeStore) UpsertSummary(_ context.Context, row *agent_session_entity.SessionSummary) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.summaries[identityOfRow(row.UserID, row.ConversationID)] = *row
	return nil
}

// lifecycleOf 是库里那一行此刻的生命周期。读不出来时回空串 —— 它跑在 Eventually
// 的条件 goroutine 上，那里不能 FailNow。
func (s *fakeStore) lifecycleOf(userID int64, conversationID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.summaries[identityOfRow(userID, conversationID)].LifecycleState
}

func (s *fakeStore) ListSummariesByUser(_ context.Context, userID int64) ([]*agent_session_entity.SessionSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*agent_session_entity.SessionSummary, 0, len(s.summaries))
	for _, row := range s.summaries {
		if row.UserID != userID {
			continue
		}
		copied := row
		out = append(out, &copied)
	}
	return out, nil
}

// WriteFrames 照真表的样子落库:唯一键是 (账号, 发起端, 会话, seq),批量写是
// ON CONFLICT **DO NOTHING** —— 已经在库里的那一行原样保留,新写入的内容不覆盖它。
// 这一条不能写成「后写覆盖」:会话标识在执行端被复用时,新旧两条对话的帧撞的正是
// 同一个键,覆盖语义会让缺陷在测试里自己消失。
// 下面五个是 SummaryRepo 为「索引按组分页」新加的读路径
// （2026-08-19-session-index-pagination.md 决策 1 / 6 / 10）。镜像器一个都不调——
// 它只写摘要、按账号读回自己的游标（mirror.go 的 summaryStore 就是这么窄的）。
// 这里只是把 RegisterSummary 要的完整接口补齐；真被调到时返回零值会让断言当场对不上，
// 而不是悄悄给出一份看起来合理的假数据。
func (s *fakeStore) ListSummariesPage(
	_ context.Context, _ agent_session_repo.SummaryPageQuery,
) ([]*agent_session_entity.SessionSummary, error) {
	return nil, nil
}

func (s *fakeStore) CountSummaries(_ context.Context, _ agent_session_repo.SummaryQuery) (int64, error) {
	return 0, nil
}

func (s *fakeStore) CountSummariesByAgent(
	_ context.Context, _ agent_session_repo.SummaryQuery,
) (map[string]int64, error) {
	return nil, nil
}

func (s *fakeStore) CountSummariesByPeer(
	_ context.Context, _ agent_session_repo.SummaryQuery,
) (map[string]int64, error) {
	return nil, nil
}

func (s *fakeStore) CountSummariesByProjectKey(
	_ context.Context, _ agent_session_repo.SummaryQuery,
) ([]agent_session_repo.SummaryProjectKeyCount, error) {
	return nil, nil
}

// MarkSummaryRead 不参与镜像那几条路径（它是索引「未读」那一档的写侧）。
func (s *fakeStore) MarkSummaryRead(
	_ context.Context, _ int64, _ string, _ int64,
) error {
	return nil
}

func (s *fakeStore) WriteFrames(_ context.Context, frames []*agent_session_entity.JournalFrame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, row := range frames {
		s.writes = append(s.writes, frameWrite{conversationID: row.ConversationID, seq: row.Seq})
		key := fmt.Sprintf("%s|%d", identityOfRow(row.UserID, row.ConversationID), row.Seq)
		if _, exists := s.rows[key]; exists {
			continue
		}
		s.rows[key] = *row
	}
	return nil
}

func (s *fakeStore) ListFramesBySeq(
	_ context.Context, userID int64, conversationID string, fromSeq int64, limit int,
) ([]*agent_session_entity.JournalFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*agent_session_entity.JournalFrame, 0, len(s.rows))
	for _, row := range s.rows {
		if row.UserID != userID || row.ConversationID != conversationID || row.Seq <= fromSeq {
			continue
		}
		copied := row
		out = append(out, &copied)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// ListFramesBefore 是反向读：seq 严格小于上界（0 = 从最新往回），按 seq 降序取
// limit 条。本包不读它（镜像写入侧只正向补齐），但桩要实现全接口才注册得进去。
func (s *fakeStore) ListFramesBefore(
	_ context.Context, userID int64, conversationID string, beforeSeq int64, limit int,
) ([]*agent_session_entity.JournalFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*agent_session_entity.JournalFrame, 0, len(s.rows))
	for _, row := range s.rows {
		if row.UserID != userID || row.ConversationID != conversationID {
			continue
		}
		if beforeSeq > 0 && row.Seq >= beforeSeq {
			continue
		}
		copied := row
		out = append(out, &copied)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq > out[j].Seq })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// writtenSeqs 是全部写入尝试的 seq,按发生顺序。
func (s *fakeStore) writtenSeqs() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]int64, 0, len(s.writes))
	for _, w := range s.writes {
		out = append(out, w.seq)
	}
	return out
}

// DeleteFrames / DeleteSummary 照真表的样子清掉这条对话在这个身份键下的行:
// 别的对话、别的账号一行都不碰。
func (s *fakeStore) DeleteFrames(_ context.Context, userID int64, conversationID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, row := range s.rows {
		if row.UserID == userID && row.ConversationID == conversationID {
			delete(s.rows, key)
		}
	}
	return nil
}

func (s *fakeStore) DeleteSummary(_ context.Context, userID int64, conversationID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.summaries, identityOfRow(userID, conversationID))
	return nil
}

// framesOf 是某条会话此刻真正躺在库里的帧,按 seq 升序 —— 内容一并交出,
// 「库里剩下的是哪条对话」只有看 params 才答得出来。
func (s *fakeStore) framesOf(conversationID string) []agent_session_entity.JournalFrame {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []agent_session_entity.JournalFrame
	for _, row := range s.rows {
		if row.ConversationID == conversationID {
			out = append(out, row)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

// summaryOf 是某条对话此刻的摘要行,没有时交出空切片 —— 「索引里还看不看得到它」
// 问的就是这个。
func (s *fakeStore) summaryOf(userID int64, conversationID string) []agent_session_entity.SessionSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.summaries[identityOfRow(userID, conversationID)]
	if !ok {
		return nil
	}
	return []agent_session_entity.SessionSummary{row}
}

// rowSeqs 是某条会话真正落库的行,按 seq 升序。
func (s *fakeStore) rowSeqs(conversationID string) []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []int64
	for _, row := range s.rows {
		if row.ConversationID == conversationID {
			out = append(out, row.Seq)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// ── 假签名器:凭据由本进程当场签,不缓存 ─────────────────────────────────────

type signedCredential struct {
	claims jwt.Claims
	ttl    time.Duration
	token  string
}

type fakeSigner struct {
	mu     sync.Mutex
	signed []signedCredential
}

func (f *fakeSigner) Sign(c jwt.Claims, ttl time.Duration) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	token := fmt.Sprintf("credential-%d-%d", c.UID, len(f.signed)+1)
	f.signed = append(f.signed, signedCredential{claims: c, ttl: ttl, token: token})
	return token, fmt.Sprintf("jti-%d", len(f.signed)), nil
}

func (f *fakeSigner) issued() []signedCredential {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]signedCredential(nil), f.signed...)
}

// ── rig ────────────────────────────────────────────────────────────────────

type residentRig struct {
	rdb   *goredis.Client
	peer  *fakeRelay
	store *fakeStore
	// reviveEvery 默认长到在一次用例里不会响：Revive 会为接不上的会话补发
	// list / attach / pull，而好几条用例数的正是那些请求。要它的用例自己调快。
	reviveEvery time.Duration
}

type replica struct {
	sup    *Supervisor
	net    *fakeDaemonNet
	signer *fakeSigner
}

func newResidentRig(t *testing.T) *residentRig {
	t.Helper()
	rdb := leaseRedis(t)
	store := newFakeStore()
	agent_session_repo.RegisterSummary(store)
	agent_session_repo.RegisterJournalFrame(store)
	return &residentRig{rdb: rdb, peer: newFakeRelay(), store: store, reviveEvery: time.Hour}
}

// replica 造一个「server 副本」:自己的 InstanceID、自己的中继与签名器,
// 共用同一台 daemon 与同一份库 —— 多副本部署就是这个形状。
func (r *residentRig) replica(t *testing.T, instanceID string) *replica {
	t.Helper()
	net := newFakeDaemonNet(r.peer)
	signer := &fakeSigner{}
	sup := NewSupervisor(Config{
		InstanceID:  instanceID,
		LeaseTTL:    time.Minute,
		RenewEvery:  5 * time.Millisecond,
		ReviveEvery: r.reviveEvery,
	}, net, signer, r.rdb)
	t.Cleanup(func() { sup.Stop(context.Background()) })
	return &replica{sup: sup, net: net, signer: signer}
}

// machineSession 造一条这台机器上的会话。真 daemon 在账号鉴权的连接上会给**每一行**
// 都标上发起端指纹(它只在 row.PeerFingerprint == 调用方自己的指纹时才省略,而镜像
// 的合成指纹不可能等于任何真设备的指纹),这里照那个样子造。
func machineSession(sid string, title string) *agentrewire.SessionSummary {
	s := runningSession(sid, title)
	s.PeerFingerprint = testMachine
	return s
}

func savedOn(conversationIDs ...string) []SavedSession {
	out := make([]SavedSession, 0, len(conversationIDs))
	for _, id := range conversationIDs {
		out = append(out, SavedSession{ConversationID: id})
	}
	return out
}

func lastPullCursor(t *testing.T, peer *fakeRelay) int64 {
	t.Helper()
	pulls := peer.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL)
	require.NotEmpty(t, pulls)
	p := pulls[len(pulls)-1].(*agentrewire.SessionPullRequest)
	return p.GetCursor()
}

// ── 在线且承载已保存对话的机器,各有一条连接 ─────────────────────────────────

// Given 一台在线的机器上有一条已保存的对话;When 反复要求跟住它;
// Then 只建一条中继连接、只接一次,而那条对话的转录照样镜像下来。
func TestFollow_OnlineMachineWithSavedSessions_KeepsExactlyOneConnection(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	rig.peer.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1), journalRow(conv42, 2)}
	a := rig.replica(t, replicaA)
	ctx := context.Background()

	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)
	again, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)

	assert.True(t, again, "已经在跟的机器,再要求一次仍然算跟着")
	connects, attaches, _ := a.net.counts()
	assert.Equal(t, 1, connects, "一台机器只该有一条中继连接")
	assert.Equal(t, 1, attaches)
	assert.Equal(t, []int64{1, 2}, rig.store.rowSeqs(conv42))
	assert.True(t, a.sup.follows(testUserID, testMachine))
}

// Given daemon 对每条虚拟通道各自鉴权(非 auth.* 一律 requireAuth);
// When 跟住一台机器;Then 这条通道上的第一个方法是 auth.account,出示的是本进程当场
// 签的短效账号凭据与合成指纹 —— 少了这一步,补齐族全被 Unauthorized 拒掉。
func TestFollow_AuthenticatesTheChannelBeforeAnySessionCall(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)

	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	ch := a.net.firstChannel(t)
	require.NotEmpty(t, ch.methods)
	assert.Equal(t, agentrewire.RpcMethod_RPC_METHOD_AUTH_ACCOUNT, ch.methods[0], "握手必须排在 session.* 之前")
	assert.Contains(t, ch.methods, agentrewire.RpcMethod_RPC_METHOD_SESSION_LIST)
	issued := a.signer.issued()
	require.Len(t, issued, 1, "一条连接签一张票,不缓存")
	assert.Equal(t, issued[0].token, ch.credential)
	assert.Equal(t, testUserID, issued[0].claims.UID)
	assert.Equal(t, "relay_client", issued[0].claims.Kind, "与浏览器换的那张中继票同一种身份")
	assert.Zero(t, issued[0].claims.DID, "镜像不是一台设备,不占 devices 行")
	assert.Positive(t, issued[0].ttl)
	assert.LessOrEqual(t, issued[0].ttl, 2*time.Minute, "票短命是它唯一的边界:jti 没人跟踪")
	// pfp 是这枚凭据说了算的对端身份(决策 8)。新版 agentred 在 HandleAccount 里
	// 缺它就以 ErrUnauthorized 拒掉整条连接 —— 不签它,服务端的常驻镜像一台机器
	// 都连不上,而这件事在假对端上看不出来:凭据对它是不透明的。所以断言签的是什么。
	assert.Equal(t, a.sup.clientFingerprint(), issued[0].claims.PFP,
		"凭据必须签上本副本的对端身份,否则新版 agentred 拒掉整条镜像连接")
}

// Given 对端在 auth.account 上按精确匹配校验 wire 协议版本,空版本一律判成「对端太旧」
// (proto3 下缺字段与显式空串同为零值);When 镜像连上一台机器;Then 握手里必须自报本次
// 构建所说的那个版本 —— 少了它,这条通道从第一个方法就被拒,整台机器都镜像不下来。
func TestFollow_HandshakeAdvertisesTheWireProtocolVersion(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)

	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	ch := a.net.firstChannel(t)
	assert.Equal(t, wireversion.Protocol, ch.protocolVersion)
	assert.NotEmpty(t, ch.protocolVersion, "空版本会被对端判成「对端太旧」")
}

// Given 每次连接都要出示凭据;When 同一个副本先放开一台机器、再重新跟住它;
// Then 第二条连接用的是**新签**的一张票,而不是攥着上一张。
func TestFollow_EachConnectionSignsAFreshCredential(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	ctx := context.Background()

	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)
	a.sup.Unfollow(ctx, testUserID, testMachine)
	claimed, err = a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	issued := a.signer.issued()
	require.Len(t, issued, 2)
	assert.NotEqual(t, issued[0].token, issued[1].token)
	connects, _, detaches := a.net.counts()
	assert.Equal(t, 2, connects)
	assert.Equal(t, 1, detaches, "放开一台机器要把那条通道摘干净")
}

// 合成指纹绝不能撞上账号里任何一台真设备的指纹:撞上了,daemon 会把镜像当成那台机器
// 的对端(ResolveSessionPeer 省略 origin 时解出的就是调用方自己),等于冒名顶替。
// 判据取「比设备注册允许的最大长度还长」——那条上限由 /v1/oauth/device/authorize 的
// binding 机械保证,是真设备的指纹在结构上做不到的事;这里直接从那条 tag 读,不抄常量。
func TestSupervisor_ClientFingerprintCannotCollideWithARealDevice(t *testing.T) {
	maxLength := deviceFingerprintMaxLength(t)

	for _, instanceID := range []string{"", replicaA, strings.Repeat("x", 300)} {
		fingerprint := NewSupervisor(Config{InstanceID: instanceID}, nil, nil, nil).clientFingerprint()
		assert.Greater(t, len(fingerprint), maxLength,
			"合成指纹 %q 落在真设备注册得进来的长度区间里", fingerprint)
	}

	one := NewSupervisor(Config{InstanceID: replicaA}, nil, nil, nil)
	assert.Equal(t, one.clientFingerprint(), one.clientFingerprint(), "同一个副本自始至终是同一个对端")
	other := NewSupervisor(Config{InstanceID: replicaB}, nil, nil, nil)
	assert.NotEqual(t, one.clientFingerprint(), other.clientFingerprint(), "两个副本不能互相冒充")
	blank := NewSupervisor(Config{}, nil, nil, nil)
	assert.NotEqual(t, NewSupervisor(Config{}, nil, nil, nil).clientFingerprint(), blank.clientFingerprint(),
		"没配 InstanceID 时也不能让两个副本共用同一个身份")
}

func deviceFingerprintMaxLength(t *testing.T) int {
	t.Helper()
	field, ok := reflect.TypeOf(device.DeviceAuthorizeRequest{}).FieldByName("Fingerprint")
	require.True(t, ok)
	for _, rule := range strings.Split(field.Tag.Get("binding"), ",") {
		if after, found := strings.CutPrefix(rule, "max="); found {
			maxLength, err := strconv.Atoi(after)
			require.NoError(t, err)
			return maxLength
		}
	}
	t.Fatal("设备注册的指纹长度上限没了:合成指纹「结构上撞不上真设备」这条性质就此失去依据")
	return 0
}

// Given 这台机器上一条已保存的对话都没有;When 要求跟住它;
// Then 既不连也不占租约 —— 镜像的范围只有账号里保存过的那些对话。
func TestFollow_MachineWithNothingSaved_NeitherConnectsNorClaims(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "没保存的")}
	a := rig.replica(t, replicaA)

	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, nil)

	require.NoError(t, err)
	assert.False(t, claimed)
	connects, _, _ := a.net.counts()
	assert.Zero(t, connects)
	assert.Zero(t, rig.claims(t, testUserID, testMachine))
}

// Given 机器在认领之后、连接之前掉线;When 跟住它失败;
// Then 租约不留在手里 —— 否则这台机器回来时谁也接不了手。
func TestFollow_MachineOffline_LeavesNoClaimBehind(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	a.net.setOnline(false)

	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))

	require.Error(t, err)
	assert.False(t, claimed)
	assert.Zero(t, rig.claims(t, testUserID, testMachine), "连不上还占着租约 = 这台机器从此没人跟")
	assert.False(t, a.sup.follows(testUserID, testMachine))
}

// ── 同一台机器同一时刻只被一个副本跟 ────────────────────────────────────────

// Given 副本 A 正跟着这台机器;When 副本 B 也被要求跟它;
// Then B 一条连接都不建 —— 两个副本同时接入 = 同一条对话被镜像两次。
func TestFollow_MachineAlreadyFollowedByAnotherReplica_DoesNotConnect(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	rig.peer.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1)}
	a := rig.replica(t, replicaA)
	b := rig.replica(t, replicaB)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	claimedByB, err := b.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))

	require.NoError(t, err, "被别的副本跟着不是故障")
	assert.False(t, claimedByB)
	connects, attaches, _ := b.net.counts()
	assert.Zero(t, connects)
	assert.Zero(t, attaches)
	assert.Equal(t, []int64{1}, rig.store.writtenSeqs(), "第二个副本一行都不该再写")
}

// Given 副本 A 正跟着这台机器,而它的租约被另一个副本接手了(A 那份过期在先);
// When A 的续期轮到;Then A 当场收工、把通道摘掉,并且**不**把别人的租约删掉。
func TestFollower_LeaseTakenByAnotherReplica_LetsGoWithoutStealingItBack(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	key := machineLeaseKey(machineKey{userID: testUserID, fingerprint: testMachine})
	require.NoError(t, rig.rdb.Set(ctx, key, replicaB, time.Minute).Err())

	require.Eventually(t, func() bool {
		_, _, detaches := a.net.counts()
		return detaches == 1 && !a.sup.follows(testUserID, testMachine)
	}, time.Second, 5*time.Millisecond, "租约丢了还接着镜像 = 同一条对话被两个副本各写一遍")
	holder, err := rig.rdb.Get(ctx, key).Result()
	require.NoError(t, err, "收工时把别人的租约删掉了")
	assert.Equal(t, replicaB, holder)
}

// Given 机器下线了;When 续期轮到;Then 收工并放掉租约 —— 它回来时任何副本都接得上。
func TestFollower_MachineWentOffline_ReleasesTheClaim(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	a.net.setOnline(false)

	require.Eventually(t, func() bool {
		_, _, detaches := a.net.counts()
		return detaches == 1 && !a.sup.follows(testUserID, testMachine) &&
			rig.claims(t, testUserID, testMachine) == 0
	}, time.Second, 5*time.Millisecond)
}

// ── 副本重启后由别的副本接手,且不产生重复的转录行 ───────────────────────────

// Given 副本 A 已经把 1..3 镜像下来,然后 A 退出(进程重启的正常路径:租约当场让出);
// When 副本 B 接手,而这期间机器上又长出 4、5;
// Then B 从**本 server 存的游标 3** 起拉,只补 4、5 —— 全程每条 seq 只被写一次。
func TestFollow_TakeoverAfterReplicaStops_ResumesFromStoredCursor(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	rig.peer.journal[conv42] = []*agentrewire.JournaledNotification{
		journalRow(conv42, 1), journalRow(conv42, 2), journalRow(conv42, 3),
	}
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)
	require.Equal(t, []int64{1, 2, 3}, rig.store.writtenSeqs())

	a.sup.Stop(ctx)
	rig.peer.journal[conv42] = append(rig.peer.journal[conv42], journalRow(conv42, 4), journalRow(conv42, 5))
	b := rig.replica(t, replicaB)
	claimedByB, err := b.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))

	require.NoError(t, err)
	require.True(t, claimedByB, "副本退出后必须有人接得了手")
	assert.Equal(t, int64(3), lastPullCursor(t, rig.peer),
		"接手要走自己存的游标,从 0 重来会把整段转录再走一遍")
	assert.Equal(t, []int64{1, 2, 3, 4, 5}, rig.store.writtenSeqs(), "接手不得重复写已经镜像过的那一段")
	assert.Equal(t, []int64{1, 2, 3, 4, 5}, rig.store.rowSeqs(conv42), "也不得漏掉一段")

	stillFollowing, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.ErrorIs(t, err, ErrStopped, "已经收工的副本不得再认领机器")
	assert.False(t, stillFollowing)
}

// ── 跟住的是「它的那些会话」──────────────────────────────────────────────

// Given 已经跟着这台机器;When 一条实时通知到达;Then 它按 seq 落库。
func TestFollow_LiveNotification_IsMirroredWhileFollowing(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	a.net.emit(t, notification(conv42, 1, "接着说"))

	require.Eventually(t, func() bool {
		return len(rig.store.rowSeqs(conv42)) == 1
	}, time.Second, 5*time.Millisecond, "接入期间的实时通知没落库")
}

// Given 已经跟着这台机器,此后账号里又保存了它上面的第二条对话;
// When 带着新的保存名单再要求一次;Then 在同一条连接上把新那条补齐,不另起一条连接。
func TestFollow_SavedSetGrows_ResyncsOnTheSameConnection(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{
		machineSession(conv42, "写个爬虫"), machineSession(conv77, "刚保存的"),
	}
	rig.peer.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1)}
	rig.peer.journal[conv77] = []*agentrewire.JournaledNotification{journalRow(conv77, 1)}
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)
	require.Empty(t, rig.store.rowSeqs(conv77))

	claimed, err = a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42, conv77))
	require.NoError(t, err)
	require.True(t, claimed)

	require.Eventually(t, func() bool {
		return len(rig.store.rowSeqs(conv77)) == 1
	}, time.Second, 5*time.Millisecond, "新保存的对话要在同一条连接上跟起来")
	connects, _, _ := a.net.counts()
	assert.Equal(t, 1, connects, "保存集变了不该重连")
}

// claims 数这台机器此刻有几份租约(0 或 1)。读不出来时报错但不中止 —— 它也跑在
// Eventually 的条件 goroutine 上,那里不能 FailNow。
func (r *residentRig) claims(t *testing.T, userID int64, fingerprint string) int64 {
	t.Helper()
	n, err := r.rdb.Exists(context.Background(),
		machineLeaseKey(machineKey{userID: userID, fingerprint: fingerprint})).Result()
	if err != nil {
		t.Errorf("读不出租约: %v", err)
		return 0
	}
	return n
}

// ── 接不上的会话由常驻循环定期再试 ─────────────────────────────────────────

// Given 跟着的这台机器上唯一那条已保存对话是 interrupted 的（daemon 对它的 attach
// 一律回 ErrNoActiveTurn，所以镜像不在它的订阅者集合里）;
// When 用户在别处对它发了一条消息、对端把它推回 running;
// Then 常驻循环自己把它接回来，库里那一行跟着不再是 interrupted。
//
// 这是 interrupted 自锁的出口（见 Mirror.Revive）：不定期再试的话，接不上 = 收不到
// 实时帧 = 没有任何东西能把那一行推离 interrupted，而 agentred 每次重启都会把非终态
// 会话整批标成 interrupted —— 左栏那一列状态点会全部永久红着。
func TestFollower_InterruptedSessionCameBack_IsPickedUpByTheResidentLoop(t *testing.T) {
	rig := newResidentRig(t)
	stuck := machineSession(conv42, "上次没跑完的")
	stuck.LifecycleState = relaywire.SessionLifecycleInterrupted
	rig.peer.sessions = []*agentrewire.SessionSummary{stuck}
	rig.peer.setAttachErr(errors.New("no active turn"))
	rig.reviveEvery = 5 * time.Millisecond

	a := rig.replica(t, replicaA)
	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)
	require.Equal(t, relaywire.SessionLifecycleInterrupted, rig.store.lifecycleOf(testUserID, conv42))

	rig.peer.setSessions([]*agentrewire.SessionSummary{machineSession(conv42, "上次没跑完的")})
	rig.peer.setAttachErr(nil)

	require.Eventually(t, func() bool {
		return rig.store.lifecycleOf(testUserID, conv42) == relaywire.SessionLifecycleRunning
	}, 2*time.Second, 5*time.Millisecond, "复活的会话没有被常驻循环接回来")
	assert.NotEmpty(t, rig.peer.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH))
}
