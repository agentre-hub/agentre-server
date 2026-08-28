package mirror_svc

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo/mock_agent_session_repo"
)

const (
	testUserID  = int64(7)
	testMachine = "fp-daemon-1"
)

// ── 假中继:按补齐三步应答(照 agentre 的 catchup_test.go restartConn 的形状)──

type recordedCall struct {
	method  agentrewire.RpcMethod
	request proto.Message
}

type fakeRelay struct {
	mu sync.Mutex
	// sessions 是 session.list 交出的清单。
	sessions []*agentrewire.SessionSummary
	// journal 是各条会话的通知日志(seq 升序),pull 从这里翻页。
	journal map[int64][]*agentrewire.JournaledNotification
	// pageSize>0 时 pull 每页最多这么多条,用来逼出 HasMore 翻页。
	pageSize int
	// attachErr 非 nil 时 attach 一律失败(中断态会话在真 daemon 上回 ErrNoActiveTurn)。
	attachErr error
	// pullErr 非 nil 时 pull 一律失败。
	pullErr error
	// deleteErr 非 nil 时 session.delete 一律以它作答(未知 method 回 -32601)。
	deleteErr error
	// candidates 是 transcriptimport.scan 交出的候选（都归 claudecode 那一档）。
	candidates []*agentrewire.TranscriptImportCandidate
	// transcriptImportErr 非 nil 时导入这一族一律以它作答。
	transcriptImportErr error
	// deleted 是被删掉的会话标识,按到达顺序。
	deleted []int64
	calls   []recordedCall
}

func newFakeRelay() *fakeRelay {
	return &fakeRelay{journal: map[int64][]*agentrewire.JournaledNotification{}}
}

func (f *fakeRelay) latestSeq(sid int64) int64 {
	rows := f.journal[sid]
	if len(rows) == 0 {
		return 0
	}
	return rows[len(rows)-1].GetSeq()
}

func (f *fakeRelay) lifecycle(sid int64) string {
	for _, s := range f.sessions {
		if s.GetSessionId() == sid {
			return s.GetLifecycleState()
		}
	}
	return relaywire.SessionLifecycleIdle
}

func (f *fakeRelay) SessionList(_ context.Context, request *agentrewire.SessionListRequest) (*agentrewire.SessionListResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{method: agentrewire.RpcMethod_RPC_METHOD_SESSION_LIST, request: request})
	return &agentrewire.SessionListResponse{Sessions: f.sessions}, nil
}

func (f *fakeRelay) SessionAttach(_ context.Context, request *agentrewire.SessionAttachRequest) (*agentrewire.SessionAttachResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{method: agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH, request: request})
	if f.attachErr != nil {
		return nil, f.attachErr
	}
	return &agentrewire.SessionAttachResponse{
		SessionId: request.GetSessionId(), LifecycleState: f.lifecycle(request.GetSessionId()),
		LatestSeq: f.latestSeq(request.GetSessionId()),
	}, nil
}

func (f *fakeRelay) SessionPull(_ context.Context, request *agentrewire.SessionPullRequest) (*agentrewire.SessionPullResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{method: agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL, request: request})
	if f.pullErr != nil {
		return nil, f.pullErr
	}
	out := &agentrewire.SessionPullResponse{Cursor: request.GetCursor()}
	rows := f.journal[request.GetSessionId()]
	if len(rows) > 0 {
		out.OldestSeq = rows[0].GetSeq()
	}
	for _, n := range rows {
		if n.GetSeq() <= request.GetCursor() {
			continue
		}
		if f.pageSize > 0 && len(out.Notifications) == f.pageSize {
			out.HasMore = true
			break
		}
		out.Notifications = append(out.Notifications, n)
		out.Cursor = n.GetSeq()
	}
	return out, nil
}

func (f *fakeRelay) SessionDelete(_ context.Context, request *agentrewire.SessionDeleteRequest) (*agentrewire.SessionDeleteResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{method: agentrewire.RpcMethod_RPC_METHOD_SESSION_DELETE, request: request})
	if f.deleteErr != nil {
		return nil, f.deleteErr
	}
	f.deleted = append(f.deleted, request.GetSessionId())
	delete(f.journal, request.GetSessionId())
	return &agentrewire.SessionDeleteResponse{Deleted: true}, nil
}

// ── transcriptimport.*:一台认识这一族的机器该有的最小答话 ──────────────────

func (f *fakeRelay) TranscriptImportScan(_ context.Context, request *agentrewire.TranscriptImportScanRequest) (*agentrewire.TranscriptImportScanResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{method: agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_SCAN, request: request})
	if f.transcriptImportErr != nil {
		return nil, f.transcriptImportErr
	}
	return &agentrewire.TranscriptImportScanResponse{
		Backends: []*agentrewire.TranscriptImportBackendResult{{
			Backend: "claudecode", Status: "ok", Candidates: f.candidates,
		}},
	}, nil
}

func (f *fakeRelay) TranscriptImportOpen(_ context.Context, request *agentrewire.TranscriptImportOpenRequest) (*agentrewire.TranscriptImportOpenResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{method: agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_OPEN, request: request})
	if f.transcriptImportErr != nil {
		return nil, f.transcriptImportErr
	}
	return &agentrewire.TranscriptImportOpenResponse{Meta: &agentrewire.TranscriptImportMeta{
		Backend: request.GetBackend(), ProviderSessionId: request.GetLocator(),
	}}, nil
}

func (f *fakeRelay) TranscriptImportTurns(_ context.Context, request *agentrewire.TranscriptImportTurnsRequest) (*agentrewire.TranscriptImportTurnsResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{method: agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_TURNS, request: request})
	if f.transcriptImportErr != nil {
		return nil, f.transcriptImportErr
	}
	return &agentrewire.TranscriptImportTurnsResponse{}, nil
}

func (f *fakeRelay) TranscriptImportExecute(_ context.Context, request *agentrewire.TranscriptImportExecuteRequest) (*agentrewire.TranscriptImportExecuteResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{method: agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_EXECUTE, request: request})
	if f.transcriptImportErr != nil {
		return nil, f.transcriptImportErr
	}
	return &agentrewire.TranscriptImportExecuteResponse{
		SessionId: request.GetSessionId(), ProviderSessionId: request.GetLocator(), Turns: 1,
	}, nil
}

func (f *fakeRelay) callsOf(method agentrewire.RpcMethod) []proto.Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []proto.Message
	for _, c := range f.calls {
		if c.method == method {
			out = append(out, c.request)
		}
	}
	return out
}

// ── rig:mockgen 仓储 + 假中继,一行都不碰数据库 ────────────────────────────

type rig struct {
	relay  *fakeRelay
	mirror *Mirror
	// frames 是落库的帧,按写入顺序。
	frames []*agent_session_entity.JournalFrame
	// upserts 是摘要写入,按写入顺序(值拷贝,便于看游标怎么变的)。
	upserts []agent_session_entity.SessionSummary
	// stored 是「库里已经有的」摘要 —— 本 server 上次镜像到哪儿的游标从这里读回。
	stored []*agent_session_entity.SessionSummary
	// clock 接管摘要攒批的尾补定时器。默认就装上,好让整个包里没有任何一次写入
	// 发生在测试 goroutine 之外 —— 断言因此不必和定时器抢。
	clock *fakeFlushClock
}

func newRig(t *testing.T, stored ...*agent_session_entity.SessionSummary) *rig {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	r := &rig{relay: newFakeRelay(), stored: stored, clock: &fakeFlushClock{}}

	mSummary := mock_agent_session_repo.NewMockSummaryRepo(ctrl)
	mFrames := mock_agent_session_repo.NewMockJournalFrameRepo(ctrl)
	// 账号作用域:只允许按本账号读。换成别的 userID 会被 gomock 判成未预期调用。
	mSummary.EXPECT().ListSummariesByUser(gomock.Any(), testUserID).DoAndReturn(
		func(_ context.Context, _ int64) ([]*agent_session_entity.SessionSummary, error) {
			return r.stored, nil
		},
	).AnyTimes()
	mSummary.EXPECT().UpsertSummary(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, s *agent_session_entity.SessionSummary) error {
			r.upserts = append(r.upserts, *s)
			return nil
		},
	).AnyTimes()
	mFrames.EXPECT().WriteFrames(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, frames []*agent_session_entity.JournalFrame) error {
			r.frames = append(r.frames, frames...)
			return nil
		},
	).AnyTimes()
	// 清帧照真表的效果办:被清掉的行从 r.frames 里消失,断言看到的因此是库里剩下的,
	// 而不是「谁被调用过」。
	mFrames.EXPECT().DeleteFrames(gomock.Any(), testUserID, gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, userID int64, fingerprint, sessionID string) error {
			kept := r.frames[:0]
			for _, f := range r.frames {
				if f.UserID == userID && f.PeerFingerprint == fingerprint && f.PeerSessionID == sessionID {
					continue
				}
				kept = append(kept, f)
			}
			r.frames = kept
			return nil
		},
	).AnyTimes()
	agent_session_repo.RegisterSummary(mSummary)
	agent_session_repo.RegisterJournalFrame(mFrames)

	r.mirror = New(testUserID, testMachine, r.relay)
	r.mirror.schedule = r.clock.schedule
	return r
}

// flush 让摘要攒批的窗口到点(尾补)。Apply 之后要断言最终游标的用例得先叫它一声。
func (r *rig) flush() { r.clock.fire() }

// upsertCount 是摘要落库的次数。攒批之后它不再等于帧数,正是要断言的东西。
func (r *rig) upsertCount() int { return len(r.upserts) }

func (r *rig) seqs() []int64 {
	out := make([]int64, 0, len(r.frames))
	for _, f := range r.frames {
		out = append(out, f.Seq)
	}
	return out
}

func (r *rig) lastCursor(t *testing.T) int64 {
	t.Helper()
	require.NotEmpty(t, r.upserts, "游标从来没落过库")
	return r.upserts[len(r.upserts)-1].LatestSeq
}

// notification 造一条实时通知的载荷:实时帧的 params 里带 sessionId 与 seq。
func notification(sid, seq int64, text string) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
		RuntimeEvent: &agentrewire.RuntimeEventNotification{SessionId: sid, Seq: seq,
			Event: &agentrewire.RuntimeEventNotification_TextDelta{TextDelta: &agentrewire.TextDelta{Text: text}}},
	}}
}

// journalRow 造一行通知日志:日志里的 params 不带 seq(seq 是日志行自己的列)。
func journalRow(sid, seq int64) *agentrewire.JournaledNotification {
	return &agentrewire.JournaledNotification{Seq: seq, Payload: notification(sid, seq, fmt.Sprintf("j%d", seq))}
}

// journalText 造一行内容可辨认的通知日志:「库里剩下的是哪条对话」只有内容答得出来。
func journalText(sid, seq int64, text string) *agentrewire.JournaledNotification {
	return &agentrewire.JournaledNotification{Seq: seq, Payload: notification(sid, seq, text)}
}

func storedSummary(fingerprint, sessionID string, cursor int64) *agent_session_entity.SessionSummary {
	return &agent_session_entity.SessionSummary{
		UserID: testUserID, PeerFingerprint: fingerprint, PeerSessionID: sessionID, LatestSeq: cursor,
	}
}

func runningSession(sid int64, title string) *agentrewire.SessionSummary {
	return &agentrewire.SessionSummary{
		SessionId: sid, Title: title, Cwd: "/home/me/proj", BackendType: "claudecode",
		LifecycleState: relaywire.SessionLifecycleRunning, LastMessageAt: 1700000000000,
	}
}

// ── 实时通知按 seq 落库 ─────────────────────────────────────────────────────

// Given 一条刚保存、对端日志还空着的对话;When 接入之后三条实时通知按序到达;
// Then 它们按 seq 各落一行(账号 + 发起端指纹 + 会话标识齐全,typed payload 原样),
// 并且本 server 自己的游标跟着推进落库 —— 下一次断连重连才知道从哪儿接着拉。
func TestApply_LiveNotifications_LandKeyedBySeq(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))
	for seq := int64(1); seq <= 3; seq++ {
		require.NoError(t, r.mirror.Apply(ctx, notification(42, seq, fmt.Sprintf("t%d", seq))))
	}

	require.Equal(t, []int64{1, 2, 3}, r.seqs())
	for _, f := range r.frames {
		assert.Equal(t, testUserID, f.UserID)
		assert.Equal(t, testMachine, f.PeerFingerprint)
		assert.Equal(t, "42", f.PeerSessionID)
		stored := &agentrewire.RpcNotification{}
		require.NoError(t, proto.Unmarshal(f.Payload, stored))
		assert.True(t, proto.Equal(notification(42, f.Seq, fmt.Sprintf("t%d", f.Seq)), stored))
		assert.Positive(t, f.Createtime)
	}
	// 摘要写入按窗口攒批(见 touchSummary),这一轮最终的游标由尾补带出去。
	r.flush()
	assert.Equal(t, int64(3), r.lastCursor(t), "游标要落库,否则重连时无从知道自己镜像到哪儿了")
}

// Given 一条实时通知的 seq 不比游标大(重复投递);When 它到达;Then 不落库。
func TestApply_DuplicateNotification_Dropped(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1), journalRow(42, 2)}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))
	require.Equal(t, []int64{1, 2}, r.seqs())

	require.NoError(t, r.mirror.Apply(ctx, notification(42, 2, "重放")))

	assert.Equal(t, []int64{1, 2}, r.seqs(), "已经镜像过的 seq 不该再写一行")
}

// Given 游标停在 2,而对端已经长到 5(中间那两条在断连的缝里丢了);
// When 一条 seq=5 的实时通知到达;Then 按游标补洞:3、4、5 一条不落、一条不重、按序落库。
func TestApply_SeqGap_PullsTheHole(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1), journalRow(42, 2)}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))
	r.relay.journal[42] = append(r.relay.journal[42], journalRow(42, 3), journalRow(42, 4), journalRow(42, 5))

	require.NoError(t, r.mirror.Apply(ctx, notification(42, 5, "跳号")))

	assert.Equal(t, []int64{1, 2, 3, 4, 5}, r.seqs())
	assert.Equal(t, int64(5), r.lastCursor(t))
}

// Given 一条本账号没保存过的对话(它在对端的清单里,但不在保存名单里);
// When 它的实时通知到达;Then 一个字都不落库(决策 2 的隐私边界)。
// 同一条断言也盖住会话标识跨机重号:保存的是本机那条 42,别的发起端那条 42 不算。
func TestApply_UnsavedSession_WritesNothing(t *testing.T) {
	r := newRig(t)
	other := runningSession(42, "别的发起端的同号会话")
	other.PeerFingerprint = "fp-browser-9"
	r.relay.sessions = []*agentrewire.SessionSummary{
		runningSession(42, "保存过的"), runningSession(77, "没保存的"), other,
	}
	r.relay.journal[77] = []*agentrewire.JournaledNotification{journalRow(77, 1)}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))
	require.NoError(t, r.mirror.Apply(ctx, notification(77, 1, "别人的话")))

	assert.Empty(t, r.frames, "没保存过的对话不产生任何镜像行")
	for _, s := range r.upserts {
		assert.Equal(t, "42", s.PeerSessionID)
		assert.Equal(t, testMachine, s.PeerFingerprint)
	}
	// 别的发起端那条同号会话既没被接入,也没被拉。
	for _, p := range r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH) {
		att := p.(*agentrewire.SessionAttachRequest)
		assert.Empty(t, att.GetPeerFingerprint(), "只该接入本机发起的那条")
	}
}

// ── 断连后按自己的游标补齐 ──────────────────────────────────────────────────

// Given 库里存着「本 server 镜像到 seq=2」,而对端日志已经有 1..5;
// When 重新连上跑一次同步;Then pull 带着自己的游标 2 发出(不是 0、也不是对端的高水位),
// 3/4/5 按序落库,1/2 一条都不重写,翻页把整段补完。
func TestSync_Reconnect_PullsFromOwnStoredCursor(t *testing.T) {
	r := newRig(t, storedSummary(testMachine, "42", 2))
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{
		journalRow(42, 1), journalRow(42, 2), journalRow(42, 3), journalRow(42, 4), journalRow(42, 5),
	}
	r.relay.pageSize = 2 // 逼出翻页

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	assert.Equal(t, []int64{3, 4, 5}, r.seqs(), "不重不跳:只补自己缺的那一段")
	pulls := r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL)
	require.NotEmpty(t, pulls)
	first := pulls[0].(*agentrewire.SessionPullRequest)
	assert.Equal(t, int64(2), first.GetCursor(), "第一次拉取要从本 server 自己存的游标开始")
	assert.Equal(t, int64(5), r.lastCursor(t))
}

// Given 对端把会话标题等元数据一并交出;When 同步完成;
// Then 摘要按「账号 + 发起端指纹 + 会话标识」落库,内容原样(老 daemon 缺的字段留空不猜)。
func TestSync_StoresSummaryUnderOriginIdentity(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	require.NotEmpty(t, r.upserts)
	got := r.upserts[len(r.upserts)-1]
	assert.Equal(t, testUserID, got.UserID)
	assert.Equal(t, testMachine, got.PeerFingerprint)
	assert.Equal(t, "42", got.PeerSessionID)
	assert.Equal(t, "写个爬虫", got.Title)
	assert.Equal(t, "/home/me/proj", got.Cwd)
	assert.Equal(t, "claudecode", got.BackendType)
	assert.Equal(t, relaywire.SessionLifecycleRunning, got.LifecycleState)
	assert.Equal(t, int64(1700000000000), got.LastMessageAt)
	assert.Empty(t, got.AgentSyncID, "对端没报的字段留空,不猜、不填占位")
}

// Given 桌面端交出的摘要点名了这条对话属于哪个项目(它没有 cwd 可报,项目同步标识
// 才是它手里真实存在的那一维);When 同步;Then 那个标识原样落库。
//
// 不落这一列的话,桌面端的每一条对话在项目轴上都只能进「随手对话」:服务端判归属的
// 另一条路是拿 (指纹, cwd) 去比 agentred 的项目路径,而桌面端两头都对不上。
func TestSync_StoresProjectReportedByPeer(t *testing.T) {
	r := newRig(t)
	desktop := runningSession(42, "写个爬虫")
	desktop.Cwd = ""
	desktop.ProjectSyncId = "01KZN9FVVD69NY8M0VCEAABNMZ"
	r.relay.sessions = []*agentrewire.SessionSummary{desktop}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	require.NotEmpty(t, r.upserts)
	got := r.upserts[len(r.upserts)-1]
	assert.Equal(t, "01KZN9FVVD69NY8M0VCEAABNMZ", got.ProjectSyncID)
}

// 没报项目的对端(agentred、以及升级前的桌面端)落的是空串,不是别的什么值 ——
// 服务端据这个空串决定「这条要拿 cwd 去跟项目路径比」。
func TestSync_PeerThatNamesNoProject_StoresBlankNotGuess(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	require.NotEmpty(t, r.upserts)
	assert.Empty(t, r.upserts[len(r.upserts)-1].ProjectSyncID)
}

// ── 已中断的会话只 pull 不 attach ───────────────────────────────────────────

// Given 一条生命周期是 interrupted 的会话(那一轮的子进程随上个 daemon 进程消亡了,
// daemon 对它的 attach 一律回 ErrNoActiveTurn);When 同步;
// Then 一次 attach 都不发,历史照样按 pull 补齐。
func TestSync_InterruptedSession_PulledNeverAttached(t *testing.T) {
	r := newRig(t)
	s := runningSession(42, "上次没跑完的")
	s.LifecycleState = relaywire.SessionLifecycleInterrupted
	s.LatestSeq = 3
	r.relay.sessions = []*agentrewire.SessionSummary{s}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{
		journalRow(42, 1), journalRow(42, 2), journalRow(42, 3),
	}
	// attach 一旦发出就会失败 —— 断言里也就分得清「没发」和「发了但被吞了」。
	r.relay.attachErr = errors.New("no active turn")

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	assert.Empty(t, r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH), "中断态会话不接入")
	assert.Equal(t, []int64{1, 2, 3}, r.seqs(), "但历史照样拉得回来")
	assert.Equal(t, int64(3), r.lastCursor(t))
}

// Given 清单说这条还活着、接入却失败了(清单与接入之间它刚被中断);
// When 同步;Then 历史仍然按 pull 补齐,不因为接不上就整条丢掉。
func TestSync_AttachFails_StillMirrorsHistory(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "刚断的")}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1), journalRow(42, 2)}
	r.relay.attachErr = errors.New("no active turn")

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	assert.Equal(t, []int64{1, 2}, r.seqs())
}

// ── 高水位低于自己的游标 = 对端整条删过,游标必须复位 ────────────────────────

// 这是 context 点名的那次静默冻结的唯一防线(桌面端 reconnect.go 的
// dropCursorAboveHighWater 同一条规则):执行端把整条会话删掉会抹掉它的 seq 高水位,
// 而会话标识是各端本地自增、会被复用 —— 日志从 1 重排,本 server 的游标却停在旧高水位,
// 此后每条实时通知都满足 seq <= 游标被当成重复丢弃:不跳号、不报错、会话再也不出字。
//
// Given 库里的游标是 100,而对端接入时交回的高水位只有 3;
// When 同步;Then 游标当场复位(并且**先落库再拉**,否则进程一重启越界的老值原样读回来,
// 同一个冻结重演一遍),1..3 重新补齐,其后的实时通知照常落库。
func TestSync_PeerHighWaterBelowStoredCursor_ResetsInsteadOfFreezing(t *testing.T) {
	r := newRig(t, storedSummary(testMachine, "42", 100))
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "同号的新对话")}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{
		journalRow(42, 1), journalRow(42, 2), journalRow(42, 3),
	}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	pulls := r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL)
	require.NotEmpty(t, pulls)
	first := pulls[0].(*agentrewire.SessionPullRequest)
	assert.Equal(t, int64(0), first.GetCursor(), "高水位在游标之下 = 对端日志退了,游标必须复位")
	require.NotEmpty(t, r.upserts)
	assert.Equal(t, int64(0), r.upserts[0].LatestSeq,
		"复位要当场落库,否则下次进程启动把越界的老值读回来,冻结重演")
	assert.Equal(t, []int64{1, 2, 3}, r.seqs())

	// 冻结的直接观测点:复位之后的实时通知照常落库(不复位的话 seq=4 <= 100 会被当成重复丢弃)。
	require.NoError(t, r.mirror.Apply(ctx, notification(42, 4, "接着说")))
	assert.Equal(t, []int64{1, 2, 3, 4}, r.seqs(), "复位之后对话要继续出字")
	assert.Equal(t, int64(4), r.lastCursor(t))
}

// Given 执行端把这条对话整条删掉,又用同一个会话标识开了新的一条(标识是执行端本地
// 自增的,删掉之后会被复用),库里还留着旧对话在这个身份键下的 1..5,本 server 的游标
// 停在旧对话的高水位;
// When 重连同步 —— 高水位低于游标,游标复位、从 0 重拉;
// Then 库里这条对话只剩新对话的帧。
//
// 复位本身不够:帧的唯一键 (账号, 发起端, 会话, seq) 新旧两条对话一模一样,而批量写是
// ON CONFLICT DO NOTHING —— 旧帧原地胜出。症状因此不是冻结,是**页面上显示的是另一条
// 对话的转录**,所以断言看的是活下来的那些帧的内容,不是有没有调用过谁。
func TestSync_ReusedSessionID_OldTranscriptPurgedBeforeReplay(t *testing.T) {
	store := newFakeStore()
	agent_session_repo.RegisterSummary(store)
	agent_session_repo.RegisterJournalFrame(store)
	ctx := context.Background()

	old := make([]*agent_session_entity.JournalFrame, 0, 5)
	for seq := int64(1); seq <= 5; seq++ {
		payload, err := proto.Marshal(notification(42, seq, fmt.Sprintf("上一条对话第%d句", seq)))
		require.NoError(t, err)
		old = append(old, &agent_session_entity.JournalFrame{
			UserID: testUserID, PeerFingerprint: testMachine, PeerSessionID: "42", Seq: seq,
			Payload: payload,
		})
	}
	require.NoError(t, store.WriteFrames(ctx, old))
	require.NoError(t, store.UpsertSummary(ctx, &agent_session_entity.SessionSummary{
		UserID: testUserID, PeerFingerprint: testMachine, PeerSessionID: "42",
		Title: "上一条对话", LatestSeq: 5,
	}))

	relay := newFakeRelay()
	relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "复用了标识的新对话")}
	relay.journal[42] = []*agentrewire.JournaledNotification{
		journalText(42, 1, "新对话第一句"), journalText(42, 2, "新对话第二句"),
	}

	require.NoError(t, New(testUserID, testMachine, relay).Sync(ctx,
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	got := store.framesOf(testMachine, "42")
	require.Len(t, got, 2, "旧对话的帧必须先清掉:唯一键与新对话相同,DO NOTHING 会让它们原地活下来")
	for _, f := range got {
		stored := &agentrewire.RpcNotification{}
		require.NoError(t, proto.Unmarshal(f.Payload, stored))
		assert.Contains(t, stored.GetRuntimeEvent().GetTextDelta().GetText(), "新对话", "留在库里的必须是这条新对话的转录")
	}
}

// Given 对端的高水位正常地在游标之上(会话还在长);When 同步;
// Then 不许复位 —— 复位在这里等于把已经镜像过的整段再重放一遍。
func TestSync_PeerHighWaterAboveCursor_KeepsCursor(t *testing.T) {
	r := newRig(t, storedSummary(testMachine, "42", 2))
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{
		journalRow(42, 1), journalRow(42, 2), journalRow(42, 3),
	}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	pulls := r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL)
	require.NotEmpty(t, pulls)
	first := pulls[0].(*agentrewire.SessionPullRequest)
	assert.Equal(t, int64(2), first.GetCursor())
	assert.Equal(t, []int64{3}, r.seqs())
}

// ── 会话标识跨发起端重号时,实时帧不许张冠李戴 ───────────────────────────────

// Given 同一条连接上两条保存过的对话共用一个会话标识(标识是各端本地自增的,跨发起端
// 必然重号),而实时帧的载荷里只有 sessionId、没有发起端指纹;
// When 一条这个标识的实时通知到达;Then 宁可不落库也不猜是谁的 —— 两边的历史仍由
// 同步时的 pull 补齐。
func TestApply_AmbiguousSessionID_WritesNothingLive(t *testing.T) {
	other := runningSession(42, "浏览器发起的同号会话")
	other.PeerFingerprint = "fp-browser-9"
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "本机发起的"), other}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1)}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{
		{PeerFingerprint: testMachine, SessionID: "42"},
		{PeerFingerprint: "fp-browser-9", SessionID: "42"},
	}))
	before := len(r.frames)

	require.NoError(t, r.mirror.Apply(ctx, notification(42, 2, "谁的?")))

	assert.Len(t, r.frames, before, "分不清是谁的实时帧,一行都不该写")
}

// ── 对端的错误如实上交 ──────────────────────────────────────────────────────

// Given 拉取失败;When 同步;Then 错误上交给调用方(由它决定重连 / 退避),不装作成功。
func TestSync_PullFails_ReturnsError(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	r.relay.pullErr = errors.New("relay is gone")

	err := r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "relay is gone")
}

// Given 这台机器上一条保存过的对话都没有;When 同步;Then 一次调用都不发。
func TestSync_NothingSaved_TouchesNothing(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "没保存的")}

	require.NoError(t, r.mirror.Sync(context.Background(), nil))

	assert.Empty(t, r.relay.calls)
	assert.Empty(t, r.frames)
	assert.Empty(t, r.upserts)
}

// ── 镜像变了要出声 ─────────────────────────────────────────────────────────

// recordingSignals 只记「谁变了」，不攒批。攒批的形状由 notify_test.go 单独守；
// 这里要守的是另一件事：镜像**落库之后**到底出没出声。
type recordingSignals struct {
	mu       sync.Mutex
	accounts []int64
}

func (s *recordingSignals) changed(_ context.Context, userID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accounts = append(s.accounts, userID)
}

func (s *recordingSignals) seen() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int64(nil), s.accounts...)
}

// Given 一条实时通知落了库;When 它落库之后;Then 这个账号收到一条「镜像变了」。
// 没有这一条,控制台的会话索引要等 30 秒兜底轮询才看得到这条消息 —— 而它自己既不
// 连中继也没有别的消息来源。
func TestApply_LandedNotification_SignalsTheAccount(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))
	signals := &recordingSignals{}
	r.mirror.signals = signals

	require.NoError(t, r.mirror.Apply(ctx, notification(42, 1, "第一条")))

	require.Equal(t, []int64{testUserID}, signals.seen())
}

// Given 一条重复投递的通知;When 它被丢掉;Then 一声不出 —— 什么都没变,发一条只会
// 让这个账号所有在线连接白拉一页。
func TestApply_DuplicateNotification_SaysNothing(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1), journalRow(42, 2)}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))
	signals := &recordingSignals{}
	r.mirror.signals = signals

	require.NoError(t, r.mirror.Apply(ctx, notification(42, 2, "重放")))

	require.Empty(t, signals.seen())
}

// Given 重连后的一轮补齐;When 它把落下的历史写进镜像;Then 同样出声 —— 断线期间
// 攒下的变更也得让在线的控制台知道,而不是只有实时那一路才算数。
func TestSync_CatchUp_SignalsTheAccount(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	r.relay.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1)}
	signals := &recordingSignals{}
	r.mirror.signals = signals

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	require.Equal(t, []int64{testUserID}, signals.seen())
}

// Given 对端报出了这条对话钉的 ModelTarget；When 镜像同步它；
// Then 那两格原样落库 —— 机器离线时详情页据此仍显示得出模型，而这正是「已保存」
// 承诺的一部分。空是有含义的值（跟随 Agent 绑定），所以不补默认、不猜。
func TestSync_StoresSessionModelTarget(t *testing.T) {
	r := newRig(t)
	s := runningSession(42, "写个爬虫")
	s.ProviderKey = "prov-anthropic"
	s.ModelKey = "sonnet-4-6"
	r.relay.sessions = []*agentrewire.SessionSummary{s}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	require.NotEmpty(t, r.upserts)
	got := r.upserts[len(r.upserts)-1]
	assert.Equal(t, "prov-anthropic", got.ProviderKey)
	assert.Equal(t, "sonnet-4-6", got.ModelKey)
}

// 对端没报这两格（跟随 Agent 绑定，或者这台机器太老不认识它们）→ 如实留空。
// 服务端不替它挑一个默认：那会把「跟随绑定」写成一个具体模型，而用户没有任何
// 办法发现这一格是编出来的。
func TestSync_UnreportedModelTargetStaysBlank(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))

	require.NotEmpty(t, r.upserts)
	got := r.upserts[len(r.upserts)-1]
	assert.Empty(t, got.ProviderKey)
	assert.Empty(t, got.ModelKey)
}

// 落库时刻取自注入的时钟，不是就地 time.Now()。这不只是为了可断言：帧的
// Createtime 与摘要的落库时刻必须是**同一个**判据（未读判定 unread =
// updated_at > last_read_at 两端各取一次钟就会互相错位），冻住钟才断言得了这件事，
// 用真实时钟只能断言「都是正数」。
func TestWriteFrames_StampsTheInjectedClock(t *testing.T) {
	r := newRig(t)
	const frozen int64 = 1_700_000_000_000
	r.mirror.now = func() int64 { return frozen }
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(42, "写个爬虫")}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{PeerFingerprint: testMachine, SessionID: "42"}}))
	require.NoError(t, r.mirror.Apply(ctx, notification(42, 1, "t1")))
	r.flush()

	require.NotEmpty(t, r.frames)
	for _, f := range r.frames {
		assert.Equal(t, frozen, f.Createtime)
	}
	require.NotEmpty(t, r.upserts)
	for _, u := range r.upserts {
		assert.Equal(t, frozen, u.Updatetime, "摘要与帧必须落在同一个时刻上")
	}
}
