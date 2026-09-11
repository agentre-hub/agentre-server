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
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/rpcerror"

	"github.com/agentre-hub/agentre-server/internal/api/device"
	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/pkg/wireversion"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
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
	peer     *fakeRelay // 会话清单 / 持久帧 / 高水位,复用镜像逻辑那一层的假中继
	online   bool
	broken   map[string]bool // 这些机器在线,但连接建不起来
	channels map[string]*fakeChannel
	order    []string // 通道建立顺序
	connects int
	attaches int
	detaches int
	// links 数这台 daemon 换过几条中继链路,当前那条的身份由它派生 —— 真中继在
	// PrepareDaemon 里逐连接现取一个,登记进在线态键(relay_svc.Route.ConnID)。
	links int
	// daemonVersion 是 auth.account 握手成功时应答里带出的自报构建版本
	// （AuthAccountResponse.daemon_version，wire 0.3.0）。空串等同于真 daemon 未注入
	// 构建变量的情形。
	daemonVersion string
	// daemonCommit 是握手应答里带出的自报短 commit
	// （AuthAccountResponse.daemon_commit，wire 0.3.0）。空串等同于真 daemon 未注入
	// 构建变量的情形 —— 消费端据此把它显示为开发构建、永不劝升（决策 5）。
	daemonCommit string
	// rejectHandshake 为真时,握手一律以 -32006(协议版本不匹配)拒绝,不看实际协议
	// 版本是否匹配 —— 用来在测试里复现「对端判定版本不合」而不必真的造两个不同构建。
	rejectHandshake bool
	// forwardBudget 是最近一帧转发到达中继时还剩多少期限,见 lastForwardBudget。
	forwardBudget time.Duration
}

func newFakeDaemonNet(peer *fakeRelay) *fakeDaemonNet {
	return &fakeDaemonNet{
		peer: peer, online: true, links: 1,
		broken: map[string]bool{}, channels: map[string]*fakeChannel{},
	}
}

func (f *fakeDaemonNet) DaemonConnID(_ context.Context, _ int64, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.online {
		return "", relay_svc.ErrDaemonOffline
	}
	return fmt.Sprintf("daemon-link-%d", f.links), nil
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
	if deadline, ok := ctx.Deadline(); ok {
		f.forwardBudget = time.Until(deadline)
	}
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
		reject := f.rejectHandshake
		daemonVersion, daemonCommit := f.daemonVersion, f.daemonCommit
		f.mu.Unlock()
		// 真对端(agentred 的 protobuf registry / 桌面端的 peer registry)在看凭据之前
		// 先按**精确匹配**校验协议版本,并且把空串判成「对端太旧」——proto3 下缺字段与
		// 显式空串同为零值。假对端照抄这条,否则「握手少带一个字段」在这里永远是绿的。
		// rejectHandshake 让测试能在两边协议版本本来就相等时,仍然复现「对端判定版本
		// 不合」这一支(daemon 侧真正的构建太旧,而不是这次请求缺字段)。
		if reject || p.GetProtocolVersion() != wireversion.Protocol {
			response.Body = &agentrewire.RpcFrame_Error{Error: &agentrewire.RpcError{
				Code: -32006, Message: "protocol version mismatch",
			}}
			break
		}
		f.mu.Lock()
		ch.authed, ch.credential = true, p.GetCredential()
		f.mu.Unlock()
		encoded, marshalErr := proto.Marshal(&agentrewire.AuthAccountResponse{
			Ok: true, InstanceUuid: "fake", DaemonVersion: daemonVersion,
			DaemonCommit: daemonCommit,
		})
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
			var wireErr *rpcerror.Error
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
	case agentrewire.RpcMethod_RPC_METHOD_AGENTRED_SELF_UPDATE:
		request := &agentrewire.AgentredSelfUpdateRequest{}
		if err := proto.Unmarshal(payload, request); err != nil {
			return nil, err
		}
		return f.peer.AgentredSelfUpdate(ctx, request)
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
		return nil, &rpcerror.Error{Code: rpcerror.CodeMethodNotFound, Message: "Method not found"}
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

// setDaemonVersion 是这台假 daemon 此后在握手成功时自报的构建版本。
func (f *fakeDaemonNet) setDaemonVersion(version string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.daemonVersion = version
}

// setDaemonCommit 是这台假 daemon 此后在握手成功时自报的短 commit。
func (f *fakeDaemonNet) setDaemonCommit(commit string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.daemonCommit = commit
}

// rejectHandshakeForProtocolVersion 让这台假 daemon 此后的每一次握手都以 -32006 拒绝,
// 复现「对端判定版本不合」——真实场景里是 daemon 自己的构建太旧,与这次请求本身是否
// 带全字段无关。
func (f *fakeDaemonNet) rejectHandshakeForProtocolVersion() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rejectHandshake = true
}

// lastForwardBudget 是最近一帧转发到达中继时还剩多少期限。这条期限取自**连接**
// （relayFrameConn 拿它当 WriteFrame 的 ctx 预算），所以它就是「这条连接给了多少
// 预算」的可观察面。
func (f *fakeDaemonNet) lastForwardBudget() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.forwardBudget
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

// lastChannel 交出最近建立的那条通道,与 firstChannel 同一份快照。
func (f *fakeDaemonNet) lastChannel(t *testing.T) fakeChannel {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.order, "一条通道都没建起来")
	ch, ok := f.channels[f.order[len(f.order)-1]]
	require.True(t, ok, "最后一条通道已经被摘掉了")
	return fakeChannel{authed: ch.authed, credential: ch.credential,
		fingerprint: ch.fingerprint, protocolVersion: ch.protocolVersion,
		methods: append([]agentrewire.RpcMethod(nil), ch.methods...)}
}

// daemonRelinked 模拟 daemon 换了一条中继链路:进程重启,或者链路断开重连。
//
// 照真 daemon 的样子:通道 id 与鉴权状态都活在 daemon **那条链路**上,链路一换就都
// 没了。而中继按指纹寻址,旧通道 id 的帧照样投给新接上的那条 websocket
// (relay_svc.TestRedisForwarderNewDaemonAttachmentSupersedesOldConnection),daemon 对
// 没见过的通道 id **新建一条未鉴权通道**(agentre 的 Multiplexer.dispatch),于是那条
// 通道上除 auth.* 之外的方法一律 Unauthorized。在线态不受影响:容器重启比 OnlineTTL
// (30 秒)快得多,在线键根本没到期。
func (f *fakeDaemonNet) daemonRelinked() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.links++
	for _, ch := range f.channels {
		ch.authed, ch.credential = false, ""
	}
}

// ── 共享的假库:两个副本读写同一份数据,幂等键与真表一致 ──────────────────────

type frameWrite struct {
	conversationID string
	seq            int64
}

type fakeStore struct {
	mu        sync.Mutex
	summaries map[string]agent_session_entity.SessionSummary
	rows      map[string]agent_session_entity.DurableFrame
	// writes 是每一次**写入尝试**,不是落库的行:接手方要是从 0 重拉,唯一键会把它
	// 折成无操作、库里看不出异样,只有这里数得出来。
	writes []frameWrite

	// 下面三个记的是「最近一次这个方法被调用时,ctx 有没有截止时间」——常驻循环
	// (resident.go 的 follower.run)每轮从 select 分支调 Mirror.Apply / Sync /
	// Revive,这条 ctx 一路直传到这里,补上 Config.CallTimeout 之后这里就该看得见
	// 一个未来的截止时间;今天没有,也就在这里看不出来。
	lastWriteFramesHadDeadline   bool
	lastUpsertSummaryHadDeadline bool
	lastListSummariesHadDeadline bool

	// blockNextWrite 让下一次 WriteFrames 卡住直到 ctx 结束才返回,模拟一次网络
	// 黑洞式的慢库调用——没有超时的话它会一直悬着占住常驻循环那条 goroutine。
	blockNextWrite       bool
	blockedWriteReturned bool

	// deadlineFrameDeletes 数带着截止时间的 DeleteFrames 调用:请求路径上的清除不带,
	// 常驻循环兑现删除提示时的那次清除必须带。
	deadlineFrameDeletes int
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		summaries: map[string]agent_session_entity.SessionSummary{},
		rows:      map[string]agent_session_entity.DurableFrame{},
	}
}

func identityOfRow(userID int64, conversationID string) string {
	return fmt.Sprintf("%d|%s", userID, conversationID)
}

func (s *fakeStore) UpsertSummary(ctx context.Context, row *agent_session_entity.SessionSummary) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, s.lastUpsertSummaryHadDeadline = ctx.Deadline()
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

func (s *fakeStore) ListSummariesByUser(ctx context.Context, userID int64) ([]*agent_session_entity.SessionSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, s.lastListSummariesHadDeadline = ctx.Deadline()
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
func (s *fakeStore) ListImportedProviderSessions(
	_ context.Context, _ int64, _ string,
) (map[string]string, error) {
	return nil, nil
}

func (s *fakeStore) ListSummaryStats(
	_ context.Context, _ int64,
) ([]agent_session_repo.SummaryStatsRow, error) {
	return nil, nil
}

func (s *fakeStore) ListSummariesPage(
	_ context.Context, _ agent_session_repo.SummaryPageQuery,
) ([]*agent_session_entity.SessionSummary, error) {
	return nil, nil
}

func (s *fakeStore) CountAttention(
	_ context.Context, _ agent_session_repo.SummaryQuery,
) (agent_session_repo.AttentionCounts, error) {
	return agent_session_repo.AttentionCounts{}, nil
}

func (s *fakeStore) CountSummaries(_ context.Context, _ agent_session_repo.SummaryQuery) (int64, error) {
	return 0, nil
}

func (s *fakeStore) CountSummariesByAgent(
	_ context.Context, _ agent_session_repo.SummaryQuery,
) (map[string]int64, error) {
	return nil, nil
}

func (s *fakeStore) CountSummariesByMachine(
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

func (s *fakeStore) WriteFrames(ctx context.Context, frames []*agent_session_entity.DurableFrame) error {
	s.mu.Lock()
	_, s.lastWriteFramesHadDeadline = ctx.Deadline()
	shouldBlock := s.blockNextWrite
	if shouldBlock {
		s.blockNextWrite = false // 一次性:只卡住紧接着的那一次调用
	}
	s.mu.Unlock()
	if shouldBlock {
		// 模拟一次网络黑洞式的慢库调用:没有超时的话,这里会一直悬着——正是
		// resident.go 常驻循环那条 goroutine 今天会被卡住的方式。
		<-ctx.Done()
		s.mu.Lock()
		s.blockedWriteReturned = true
		s.mu.Unlock()
		return ctx.Err()
	}
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
) ([]*agent_session_entity.DurableFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*agent_session_entity.DurableFrame, 0, len(s.rows))
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
) ([]*agent_session_entity.DurableFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*agent_session_entity.DurableFrame, 0, len(s.rows))
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

// writeFramesHadDeadline / upsertSummaryHadDeadline / listSummariesHadDeadline
// 报最近一次那个方法被调用时,ctx 是不是带着截止时间。
func (s *fakeStore) writeFramesHadDeadline() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastWriteFramesHadDeadline
}

func (s *fakeStore) upsertSummaryHadDeadline() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastUpsertSummaryHadDeadline
}

func (s *fakeStore) listSummariesHadDeadline() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastListSummariesHadDeadline
}

// blockNextWriteUntilContextDone 让下一次 WriteFrames 卡住直到它的 ctx 结束才返回。
func (s *fakeStore) blockNextWriteUntilContextDone() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.blockNextWrite = true
	s.blockedWriteReturned = false
}

// blockedWriteHasReturned 报那次被卡住的调用有没有已经放行。
func (s *fakeStore) blockedWriteHasReturned() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.blockedWriteReturned
}

// DeleteFrames / DeleteSummary 照真表的样子清掉这条对话在这个身份键下的行:
// 别的对话、别的账号一行都不碰。
func (s *fakeStore) DeleteFrames(ctx context.Context, userID int64, conversationID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := ctx.Deadline(); ok {
		s.deadlineFrameDeletes++
	}
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
func (s *fakeStore) framesOf(conversationID string) []agent_session_entity.DurableFrame {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []agent_session_entity.DurableFrame
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

// ── 假签发器:凭据由本进程当场发,不缓存 ─────────────────────────────────────

type issuedCredential struct {
	accountID       int64
	peerFingerprint string
	token           string
}

type fakeIssuer struct {
	mu     sync.Mutex
	issues []issuedCredential
}

func (f *fakeIssuer) IssueServerMirror(_ context.Context, accountID int64, peerFingerprint string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	token := fmt.Sprintf("credential-%d-%d", accountID, len(f.issues)+1)
	f.issues = append(f.issues, issuedCredential{accountID: accountID, peerFingerprint: peerFingerprint, token: token})
	return token, nil
}

func (f *fakeIssuer) issued() []issuedCredential {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]issuedCredential(nil), f.issues...)
}

// ── rig ────────────────────────────────────────────────────────────────────

type residentRig struct {
	rdb   *goredis.Client
	peer  *fakeRelay
	store *fakeStore
	// reviveEvery 默认长到在一次用例里不会响：Revive 会为接不上的会话补发
	// list / attach / pull，而好几条用例数的正是那些请求。要它的用例自己调快。
	reviveEvery time.Duration
	// callTimeout 默认零值,走 Config.withDefaults 的 15s 缺省;要卡住的库调用在
	// 用例的等待窗口内放行,用例自己调短它。
	callTimeout time.Duration
}

type replica struct {
	sup    *Supervisor
	net    *fakeDaemonNet
	issuer *fakeIssuer
}

func newResidentRig(t *testing.T) *residentRig {
	t.Helper()
	rdb := leaseRedis(t)
	store := newFakeStore()
	agent_session_repo.RegisterSummary(store)
	agent_session_repo.RegisterDurableFrame(store)
	return &residentRig{rdb: rdb, peer: newFakeRelay(), store: store, reviveEvery: time.Hour}
}

// replica 造一个「server 副本」:自己的 InstanceID、自己的中继与凭据签发器,
// 共用同一台 daemon 与同一份库 —— 多副本部署就是这个形状。
func (r *residentRig) replica(t *testing.T, instanceID string) *replica {
	t.Helper()
	issuer := &fakeIssuer{}
	sup, net := r.supervisor(t, instanceID, issuer)
	return &replica{sup: sup, net: net, issuer: issuer}
}

// supervisor 按本 rig 的配置造一个副本的常驻镜像,凭据由 credentials 发。
func (r *residentRig) supervisor(t *testing.T, instanceID string, credentials CredentialIssuer) (*Supervisor, *fakeDaemonNet) {
	t.Helper()
	net := newFakeDaemonNet(r.peer)
	sup := NewSupervisor(Config{
		InstanceID:  instanceID,
		LeaseTTL:    time.Minute,
		RenewEvery:  5 * time.Millisecond,
		ReviveEvery: r.reviveEvery,
		CallTimeout: r.callTimeout,
	}, net, credentials, r.rdb)
	t.Cleanup(func() { sup.Stop(context.Background()) })
	return sup, net
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
	rig.peer.durable[conv42] = []*agentrewire.DurableNotification{durableRow(conv42, 1), durableRow(conv42, 2)}
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
// 取的短效账号凭据与合成指纹 —— 少了这一步,补齐族全被 Unauthorized 拒掉。
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
	issued := a.issuer.issued()
	require.Len(t, issued, 1, "一条连接发一张凭据,不缓存")
	assert.Equal(t, issued[0].token, ch.credential)
	assert.Equal(t, testUserID, issued[0].accountID)
	// pfp 是这枚凭据说了算的对端身份(决策 8)。agentred 在 HandleAccount 里缺它就以
	// ErrUnauthorized 拒掉整条连接 —— 不记它,服务端的常驻镜像一台机器都连不上,而这件事
	// 在假对端上看不出来:凭据对它是不透明的。所以断言记下的是什么。
	assert.Equal(t, a.sup.clientFingerprint(), issued[0].peerFingerprint,
		"凭据必须记下本副本的对端身份,否则 agentred 拒掉整条镜像连接")
}

// 镜像与端口转发共用 Supervisor 的拨号:凭据取自短效凭据存储,类型是 server_mirror ——
// 与浏览器换的中继票据分开,两者都认不成对方的入口;有效期与记录由存储负责。
func TestFollow_PresentsAServerMirrorCredentialFromTheStore(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	store := credstore.New(rig.rdb)
	sup, net := rig.supervisor(t, replicaA, store)
	ctx := context.Background()

	claimed, err := sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	got, err := store.Resolve(ctx, net.firstChannel(t).credential)
	require.NoError(t, err, "出示给对端的凭据必须是存储里记着的那一张")
	assert.Equal(t, credstore.KindServerMirror, got.Kind)
	assert.Equal(t, testUserID, got.AccountID)
	assert.Equal(t, sup.clientFingerprint(), got.PeerFingerprint)
	assert.Empty(t, got.SessionID, "server 自用凭据不挂在任何浏览器会话上")
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

// ── 握手成功后把自报版本刷回 devices.version(spec「控制台呈现与 latest 来源」,决策 14) ──

// Given 库里这台机器的 devices.version 是旧值;When 握手自报的版本与它不同;
// Then 按新值写回 —— 设备卡上的版本因此是实时的,不再是装机那天的化石(问题 4)。
func TestFollow_HandshakeReportsADifferentVersion_UpdatesStoredDeviceVersion(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	a.net.setDaemonVersion("0.5.0")

	ctrl := gomock.NewController(t)
	mockDevices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(mockDevices)
	t.Cleanup(func() { device_repo.RegisterDevice(nil) })
	mockDevices.EXPECT().FindByFingerprint(gomock.Any(), testUserID, testMachine).
		Return(&device_entity.Device{ID: 900, UserID: testUserID, Fingerprint: testMachine, Version: "0.4.0"}, nil)
	mockDevices.EXPECT().UpdateVersion(gomock.Any(), int64(900), "0.5.0", gomock.Any()).Return(nil)

	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))

	require.NoError(t, err)
	require.True(t, claimed)
}

// Given 库里这台机器的 devices.version 已经等于握手自报的版本;When 跟住它;
// Then 一行都不写 —— 断言落在「有没有调写方法」上,而不是「那一行有没有变」,后者对
// 一开始就没变过的行永远为真,证明不了这条判断真的生效过。
func TestFollow_HandshakeReportsTheSameVersion_WritesNothing(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	a.net.setDaemonVersion("0.5.0")

	ctrl := gomock.NewController(t)
	mockDevices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(mockDevices)
	t.Cleanup(func() { device_repo.RegisterDevice(nil) })
	mockDevices.EXPECT().FindByFingerprint(gomock.Any(), testUserID, testMachine).
		Return(&device_entity.Device{ID: 900, UserID: testUserID, Fingerprint: testMachine, Version: "0.5.0"}, nil)
	mockDevices.EXPECT().UpdateVersion(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).Times(0)

	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))

	require.NoError(t, err)
	require.True(t, claimed)
}

// Given 握手应答里带着这台机器自报的短 commit(spec「协议：版本窗口与自报版本」);
// When 跟住它;Then 这份构建被记成按 (账号, 机器) 的共享状态 —— 换一个副本读到的是
// 同一个答案,因为设备读端点未必落在跟着这台机器的那个副本上。commit 为空的本地构建
// 与「从没握过手」必须分得开:前者是 daemon 给的确定答案(开发构建,永不劝升 ——
// 决策 5),后者是没有答案。
func TestFollow_HandshakeReportsAShortCommit_RecordsItAsSharedBuildState(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	a.net.setDaemonVersion("0.5.0")
	a.net.setDaemonCommit("a1b2c3d")
	ctx := context.Background()

	before := a.sup.HandshakeStates(ctx, testUserID, []string{testMachine})[0]
	require.False(t, before.DaemonBuildKnown, "还没握过手就「知道」的话,后面那条断言证明不了任何事")

	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	onA := a.sup.HandshakeStates(ctx, testUserID, []string{testMachine})[0]
	assert.True(t, onA.DaemonBuildKnown)
	assert.Equal(t, "a1b2c3d", onA.DaemonCommit)

	b := rig.replica(t, replicaB)
	onB := b.sup.HandshakeStates(ctx, testUserID, []string{testMachine})[0]
	assert.True(t, onB.DaemonBuildKnown, "这台机器跑的是不是发布构建,是账号 + 机器这一级的事实")
	assert.Equal(t, "a1b2c3d", onB.DaemonCommit)
}

// Given 这台机器是未注入构建变量的本地构建,握手自报的短 commit 是空串;
// When 跟住它;Then 记下的是「知道,而且是空」—— 消费端据此显示为开发构建、永不劝升
// (决策 5),而不是退回「不知道」。
func TestFollow_HandshakeReportsAnEmptyCommit_StillRecordsThatItIsKnown(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	a.net.setDaemonVersion("1.0.0")
	a.net.setDaemonCommit("")
	ctx := context.Background()

	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	state := a.sup.HandshakeStates(ctx, testUserID, []string{testMachine})[0]
	assert.True(t, state.DaemonBuildKnown, "握过手就是知道了:空 commit 是 daemon 给的答案,不是没有答案")
	assert.Empty(t, state.DaemonCommit)
}

// ── 握手被协议拒绝时记成按 (账号, 机器) 的共享状态,并拉长退避 ─────────────────

// Given daemon 判定这次握手协议版本不合并拒绝;When 跟这台机器;
// Then Follow 报错、一条连接都建不起来,而「协议不匹配」被记成一份跨副本共享的状态——
// 换一个副本读,看到的是同一个答案(spec「控制台呈现与 latest 来源」一节最后一段)。
func TestFollow_HandshakeRejectedForProtocolVersion_RecordsSharedMismatchState(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	a.net.rejectHandshakeForProtocolVersion()

	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrProtocolVersionMismatch)
	assert.False(t, claimed)
	assert.True(t, a.sup.HandshakeStates(context.Background(), testUserID, []string{testMachine})[0].ProtocolMismatch)

	b := rig.replica(t, replicaB)
	assert.True(t, b.sup.HandshakeStates(context.Background(), testUserID, []string{testMachine})[0].ProtocolMismatch,
		"协议不匹配是账号 + 机器这一级的事实,不该只留在发现它的那个副本进程里")
}

// Given 上一次握手已经因协议不匹配被拒、退避已经记下;When 紧接着(对账周期那么快)
// 再跟这台机器一次;Then 这次不再重新拨号握手 —— 版本不匹配不是瞬时故障,不能按对账
// 周期(每分钟)的节奏重试。
func TestFollow_ProtocolMismatch_DoesNotRedialOnTheFastPath(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	a.net.rejectHandshakeForProtocolVersion()
	_, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))
	require.ErrorIs(t, err, ErrProtocolVersionMismatch)
	connectsAfterFirst, _, _ := a.net.counts()
	require.Equal(t, 1, connectsAfterFirst, "第一次尝试必须真的拨过一次号,不然测不出「第二次没有再拨」")

	_, err = a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv42))

	require.ErrorIs(t, err, ErrProtocolVersionMismatch)
	connectsAfterSecond, _, _ := a.net.counts()
	assert.Equal(t, connectsAfterFirst, connectsAfterSecond,
		"退避期内不该再对这台机器发起一次新的连接/握手")
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

	issued := a.issuer.issued()
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
	rig.peer.durable[conv42] = []*agentrewire.DurableNotification{durableRow(conv42, 1)}
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

// Given daemon 换了一条中继链路(进程重启或链路断开重连):它那侧的通道连同鉴权状态
// 一起没了,而在线态键比这次重连活得久,所以这台机器全程都是「在线」;
// When 续期轮到;Then 收工并放掉租约 —— 让下一轮巡检重新认领、重新握手。
//
// 不放手就是 2026-09-03 在 dev 上实测到的那个形态:keepalive 那两问(租约还在我手里
// 吗、机器在线吗)全答「是」,常驻循环对 RPC 错误只记一条日志、没有别的出口,而
// Follow 是幂等的 —— 巡检每轮都报 followed:1 offline:0 failed:0,镜像却一直坏着。
// 实测连续 9 小时每分钟一条 "session list: Unauthorized",期间保存的三条对话一条都
// 没镜像下来,已经镜像的那条停在 9 小时前的 seq 上,只有重启 server 才恢复。
func TestFollower_DaemonRelinked_ReleasesTheClaimSoTheNextPassCanHandshakeAgain(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	a.net.daemonRelinked()

	require.Eventually(t, func() bool {
		_, _, detaches := a.net.counts()
		return detaches == 1 && !a.sup.follows(testUserID, testMachine) &&
			rig.claims(t, testUserID, testMachine) == 0
	}, time.Second, 5*time.Millisecond,
		"daemon 换了链路,旧通道在它那侧已经不存在:再跟下去每个 session.* 都是 Unauthorized")

	// 下一轮巡检要能真的把它接回来,而不是把那条废掉的连接再交出去一次。
	again, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, again, "放手之后下一轮巡检必须认领得回来")
	connects, attaches, _ := a.net.counts()
	assert.Equal(t, 2, connects, "重新认领必须新建一条中继连接")
	assert.Equal(t, 2, attaches)
	assert.True(t, a.net.lastChannel(t).authed, "新连接上必须重新握手,否则换了通道也还是 Unauthorized")
}

// ── 副本重启后由别的副本接手,且不产生重复的转录行 ───────────────────────────

// Given 副本 A 已经把 1..3 镜像下来,然后 A 退出(进程重启的正常路径:租约当场让出);
// When 副本 B 接手,而这期间机器上又长出 4、5;
// Then B 从**本 server 存的游标 3** 起拉,只补 4、5 —— 全程每条 seq 只被写一次。
func TestFollow_TakeoverAfterReplicaStops_ResumesFromStoredCursor(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	rig.peer.durable[conv42] = []*agentrewire.DurableNotification{
		durableRow(conv42, 1), durableRow(conv42, 2), durableRow(conv42, 3),
	}
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)
	require.Equal(t, []int64{1, 2, 3}, rig.store.writtenSeqs())

	a.sup.Stop(ctx)
	rig.peer.durable[conv42] = append(rig.peer.durable[conv42], durableRow(conv42, 4), durableRow(conv42, 5))
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
	rig.peer.durable[conv42] = []*agentrewire.DurableNotification{durableRow(conv42, 1)}
	rig.peer.durable[conv77] = []*agentrewire.DurableNotification{durableRow(conv77, 1)}
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

// ── 常驻循环里对库的每一次调用都带 Config.CallTimeout 截止（要求 14）────────────
//
// follower.run 的 select 分支直接把循环的 ctx（go f.run(context.WithoutCancel(ctx))
// 派生自 Follow 调用方,这里就是 context.Background()）转手交给 Mirror.Apply / Sync /
// Revive,一路不带任何截止时间。网络黑洞式的慢库调用因此会一直悬着占住这条循环
// 的 goroutine,直到 OS 的 TCP 重传超时(Linux 上约 15 分钟)——maxOpenConns 只有
// 40,吃住一条就少一条。下面几个用例锚住 resident.go 补上的行为:每次从循环发起的
// 库调用都必须带着 Config.CallTimeout 的截止时间,而不是无限期悬着;截止只扣在库调用
// 上,对端的 attach / pull 仍按各自的 CallTimeout 走,不与整轮共用一个。

// Given 已经跟着一台机器;When 常驻循环处理一条实时通知(触发 Mirror.Apply);
// Then 落库那次调用带着的 ctx 有截止时间。
func TestFollower_LiveNotificationFromTheLoop_UsesADeadlineBoundContext(t *testing.T) {
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
	assert.True(t, rig.store.writeFramesHadDeadline(),
		"常驻循环里的 Apply 落库调用必须带 Config.CallTimeout 截止，否则一次网络黑洞会占住连接池里的一个连接直到 TCP 重传超时")
}

// Given 已经跟着一台机器,账号里又保存了它上面的第二条对话;When 常驻循环处理由此
// 触发的重同步(触发 Mirror.Sync);Then 那次调用带着的 ctx 有截止时间。
func TestFollower_ResyncFromTheLoop_UsesADeadlineBoundContext(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{
		machineSession(conv42, "写个爬虫"), machineSession(conv77, "刚保存的"),
	}
	rig.peer.durable[conv42] = []*agentrewire.DurableNotification{durableRow(conv42, 1)}
	rig.peer.durable[conv77] = []*agentrewire.DurableNotification{durableRow(conv77, 1)}
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
	assert.True(t, rig.store.listSummariesHadDeadline(),
		"常驻循环触发的重同步必须带 Config.CallTimeout 截止，否则一次网络黑洞会占住连接池里的一个连接直到 TCP 重传超时")
}

// Given 唯一那条已保存对话是 interrupted 的,复活由常驻循环的 Revive 定期发现;
// When 它被接回来;Then 补写摘要那次调用带着的 ctx 有截止时间。
func TestFollower_ReviveFromTheLoop_UsesADeadlineBoundContext(t *testing.T) {
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
	assert.True(t, rig.store.upsertSummaryHadDeadline(),
		"常驻循环里的 Revive 补写调用必须带 Config.CallTimeout 截止，否则一次网络黑洞会占住连接池里的一个连接直到 TCP 重传超时")
}

// Given 常驻循环里下一次落库调用会像网络黑洞一样卡住不返回;When 它被 CallTimeout
// 卡到期;Then 这次调用必须自己放行（收到 ctx 取消）,而不是无限期悬着——常驻循环
// 因此能继续消化后续事件,而不是被这一条对话的一次慢调用拖死。
//
// conv42 的持久帧从一开始就静态摆着(fakeRelay 没有并发安全的「运行期再改」入口,
// 常驻循环起来之后直接改 peer 状态会撞上竞态检测器)：它先不进第一次 Follow 的保存
// 名单,直到 blockNextWrite 已经架好,才通过保存名单变更把它带进来触发一次会卡住的
// resync 补齐；resync 出错时不会像 Apply 出错那样自动排下一次重同步(见 run 里两个
// 分支的差别),所以这次超时之后不会再有第二次目标不明的重试来跟测试里紧接着发的
// 那条实时通知抢跑,附带验证了 dropCursorAboveHighWater 不会被一次网络黑洞误伤。
func TestFollower_LoopCallBlocksPastCallTimeout_LoopStillProceedsAfterward(t *testing.T) {
	rig := newResidentRig(t)
	rig.callTimeout = 50 * time.Millisecond
	rig.peer.sessions = []*agentrewire.SessionSummary{
		machineSession(conv77, "占位,只为了先起循环"), machineSession(conv42, "写个爬虫"),
	}
	rig.peer.durable[conv42] = []*agentrewire.DurableNotification{durableRow(conv42, 1)}
	a := rig.replica(t, replicaA)
	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv77))
	require.NoError(t, err)
	require.True(t, claimed)
	require.Empty(t, rig.store.rowSeqs(conv42), "conv42 还没进保存名单,不该被镜像")

	rig.store.blockNextWriteUntilContextDone()
	claimed, err = a.sup.Follow(context.Background(), testUserID, testMachine, savedOn(conv77, conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	require.Eventually(t, func() bool {
		return rig.store.blockedWriteHasReturned()
	}, 2*time.Second, 5*time.Millisecond,
		"卡住的库调用应该在 CallTimeout 到期时收到 ctx 取消，而不是无限期悬着")
	require.Empty(t, rig.store.rowSeqs(conv42), "超时的那次补齐没有把这一帧写进去,游标因此没有前进")

	// 游标停在 0：接下来这条实时通知落在 cursor+1 这个直写分支上,而且它的 seq 与
	// 对端的静态高水位（durable 只有这一行）完全对齐,不会触发 dropCursorAboveHighWater。
	a.net.emit(t, notification(conv42, 1, "卡住之后还能继续"))
	require.Eventually(t, func() bool {
		return len(rig.store.rowSeqs(conv42)) == 1
	}, 2*time.Second, 5*time.Millisecond,
		"常驻循环在一次超时的库调用之后必须继续处理后续事件")
	assert.Equal(t, []int64{1}, rig.store.rowSeqs(conv42),
		"卡住的那一帧因超时没有落库；超时之后的下一次投递必须正常落库")
}

// Given 常驻循环触发一次重同步,要补的那条对话有好几页持久帧,对端每一页都要一会儿才
// 答 —— 每一次 RPC 都在 CallTimeout 之内,整次补齐加起来却超过它;When 循环跑这次
// 重同步;Then 每一页都落库。
//
// 截止扣在库调用上(决策 14「常驻镜像循环每次迭代的库调用带 Config.CallTimeout 截止」),
// 不扣在整轮迭代上:一轮补齐夹着对端的 attach 与翻页 pull,每一次 RPC 本来就各有
// CallTimeout,而页数不封顶。拿一个 CallTimeout 框住整轮,一条长对话的补齐会在中途被
// 截断,而重同步失败不会自动再排一次,剩下的帧就一直补不回来。
func TestFollower_ResyncCatchUpLongerThanOneCallTimeout_StillStoresEveryPage(t *testing.T) {
	rig := newResidentRig(t)
	rig.callTimeout = 400 * time.Millisecond
	rig.peer.sessions = []*agentrewire.SessionSummary{
		machineSession(conv77, "占位,只为了先起循环"), machineSession(conv42, "很长的对话"),
	}
	const pages = 8
	for seq := int64(1); seq <= pages; seq++ {
		rig.peer.durable[conv42] = append(rig.peer.durable[conv42], durableRow(conv42, seq))
	}
	rig.peer.pageSize = 1
	rig.peer.pullDelay = 100 * time.Millisecond
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv77))
	require.NoError(t, err)
	require.True(t, claimed)

	claimed, err = a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv77, conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	require.Eventually(t, func() bool {
		return len(rig.store.framesOf(conv42)) == pages
	}, 5*time.Second, 10*time.Millisecond,
		"每一页都在 CallTimeout 之内答了,整次补齐却被一个 CallTimeout 截断:剩下的帧补不回来")
}

// frameDeletesWithDeadline 报带着截止时间的 DeleteFrames 调用有几次。
func (s *fakeStore) frameDeletesWithDeadline() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deadlineFrameDeletes
}
