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
	"github.com/agentre-hub/agentre/pkg/wire/turnstate"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo/mock_agent_session_repo"
)

const (
	testUserID  = int64(7)
	testMachine = "fp-daemon-1"

	// 几条对话的 conversation_id（决策 1 的规范形式）。它们全局唯一：conv42 与
	// conv77 出现在两个不同的发起端名下时，仍然是两条互不相干的对话。
	conv42  = "3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"
	conv77  = "5b8c9d2e-1f30-7c55-b214-9d7e3a6b0c11"
	conv101 = "7d1e4f60-2a55-7e01-83c9-4b2f5d8a6e33"
	conv202 = "9a0b3c71-4d66-7f12-94da-5c3e6f9b7d44"
	conv43  = "b1c2d3e4-5f60-7a11-8b22-6d4f7a0c9e55"
	conv44  = "c2d3e4f5-6071-7b22-9c33-7e5a8b1d0f66"
	conv7   = "d3e4f506-7182-7c33-ad44-8f6b9c2e1007"
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
	journal map[string][]*agentrewire.JournaledNotification
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
	// deleted 是被删掉的对话标识,按到达顺序。
	deleted []string
	calls   []recordedCall
}

func newFakeRelay() *fakeRelay {
	return &fakeRelay{journal: map[string][]*agentrewire.JournaledNotification{}}
}

func (f *fakeRelay) latestSeq(sid string) int64 {
	rows := f.journal[sid]
	if len(rows) == 0 {
		return 0
	}
	return rows[len(rows)-1].GetSeq()
}

func (f *fakeRelay) lifecycle(sid string) string {
	for _, s := range f.sessions {
		if s.GetConversationId() == sid {
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
		ConversationId: request.GetConversationId(),
		LifecycleState: f.lifecycle(request.GetConversationId()),
		LatestSeq:      f.latestSeq(request.GetConversationId()),
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
	rows := f.journal[request.GetConversationId()]
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
	f.deleted = append(f.deleted, request.GetConversationId())
	delete(f.journal, request.GetConversationId())
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
		ConversationId: request.GetConversationId(), ProviderSessionId: request.GetLocator(), Turns: 1,
	}, nil
}

// setAttachErr / setSessions 让用例在**跟随已经跑起来之后**改变对端的答复
// （常驻循环在自己的 goroutine 上读它们，直接写字段会撞上竞态检测器）。
func (f *fakeRelay) setAttachErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attachErr = err
}

func (f *fakeRelay) setSessions(sessions []*agentrewire.SessionSummary) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions = sessions
}

// callCount 是这条假中继迄今收到的请求总数。「什么都不该发」只有它答得出来。
func (f *fakeRelay) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
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
	mFrames.EXPECT().DeleteFrames(gomock.Any(), testUserID, gomock.Any()).DoAndReturn(
		func(_ context.Context, userID int64, conversationID string) error {
			kept := r.frames[:0]
			for _, f := range r.frames {
				if f.UserID == userID && f.ConversationID == conversationID {
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

func (r *rig) lastLifecycle(t *testing.T) string {
	t.Helper()
	require.NotEmpty(t, r.upserts, "摘要从来没落过库")
	return r.upserts[len(r.upserts)-1].LifecycleState
}

func (r *rig) lastCursor(t *testing.T) int64 {
	t.Helper()
	require.NotEmpty(t, r.upserts, "游标从来没落过库")
	return r.upserts[len(r.upserts)-1].LatestSeq
}

// notification 造一条实时通知的载荷:实时帧的 params 里带 conversationId 与 seq。
func notification(sid string, seq int64, text string) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
		RuntimeEvent: &agentrewire.RuntimeEventNotification{ConversationId: sid, Seq: seq,
			Event: &agentrewire.RuntimeEventNotification_TextDelta{TextDelta: &agentrewire.TextDelta{Text: text}}},
	}}
}

// journalRow 造一行通知日志:日志里的 params 不带 seq(seq 是日志行自己的列)。
func runResultDone(sid string, seq int64) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RunResultDone{
		RunResultDone: &agentrewire.RunResultDoneNotification{ConversationId: sid, Seq: seq},
	}}
}

func autonomousTurnStarted(sid string, seq int64) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_AutonomousTurnStarted{
		AutonomousTurnStarted: &agentrewire.AutonomousTurnStartedNotification{ConversationId: sid, Seq: seq},
	}}
}

func turnStarted(sid string, seq int64) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_TurnStarted{
		TurnStarted: &agentrewire.TurnStartedNotification{ConversationId: sid, Seq: seq},
	}}
}

func autonomousTurnDone(sid string, seq int64) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_AutonomousTurnDone{
		AutonomousTurnDone: &agentrewire.RunResultDoneNotification{ConversationId: sid, Seq: seq},
	}}
}

func journalRow(sid string, seq int64) *agentrewire.JournaledNotification {
	return &agentrewire.JournaledNotification{Seq: seq, Payload: notification(sid, seq, fmt.Sprintf("j%d", seq))}
}

// journalText 造一行内容可辨认的通知日志:「库里剩下的是哪条对话」只有内容答得出来。
func journalText(sid string, seq int64, text string) *agentrewire.JournaledNotification {
	return &agentrewire.JournaledNotification{Seq: seq, Payload: notification(sid, seq, text)}
}

func storedSummary(fingerprint, conversationID string, cursor int64) *agent_session_entity.SessionSummary {
	return &agent_session_entity.SessionSummary{
		UserID: testUserID, ConversationID: conversationID,
		PeerFingerprint: fingerprint, LatestSeq: cursor,
	}
}

func runningSession(sid string, title string) *agentrewire.SessionSummary {
	return &agentrewire.SessionSummary{
		ConversationId: sid, Title: title, Cwd: "/home/me/proj", BackendType: "claudecode",
		LifecycleState: relaywire.SessionLifecycleRunning, LastMessageAt: 1700000000000,
	}
}

// ── 实时通知按 seq 落库 ─────────────────────────────────────────────────────

// Given 一条刚保存、对端日志还空着的对话;When 接入之后三条实时通知按序到达;
// Then 它们按 seq 各落一行(账号 + 发起端指纹 + 会话标识齐全,typed payload 原样),
// 并且本 server 自己的游标跟着推进落库 —— 下一次断连重连才知道从哪儿接着拉。
func TestApply_LiveNotifications_LandKeyedBySeq(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	for seq := int64(1); seq <= 3; seq++ {
		require.NoError(t, r.mirror.Apply(ctx, notification(conv42, seq, fmt.Sprintf("t%d", seq))))
	}

	require.Equal(t, []int64{1, 2, 3}, r.seqs())
	for _, f := range r.frames {
		assert.Equal(t, testUserID, f.UserID)
		assert.Equal(t, conv42, f.ConversationID)
		assert.Equal(t, testMachine, f.PeerFingerprint)
		stored := &agentrewire.RpcNotification{}
		require.NoError(t, proto.Unmarshal(f.Payload, stored))
		assert.True(t, proto.Equal(notification(conv42, f.Seq, fmt.Sprintf("t%d", f.Seq)), stored))
		assert.Positive(t, f.Createtime)
	}
	// 摘要写入按窗口攒批(见 touchSummary),这一轮最终的游标由尾补带出去。
	r.flush()
	assert.Equal(t, int64(3), r.lastCursor(t), "游标要落库,否则重连时无从知道自己镜像到哪儿了")
}

// ── 轮次终态：镜像的 lifecycle 跟着实时帧走 ────────────────────────────────

// Given 一条镜像中的对话此刻在跑;When 它这一轮的终态帧(runtime.runResultDone)到达;
// Then 落库的摘要必须已经是 idle。
//
// 元数据此前只由 Sync 改（清单快照）:一轮跑完之后没有任何东西让镜像重新问一次清单,
// 那一行就一直停在 running —— 左栏于是把一条早就结束的对话长期显示成「运行中」,
// 「运行中」这个 chip 也一直把它筛出来,直到别的事情碰巧触发了一次 Sync。
//
// 拿终态帧当判据不是猜:daemon 是**先**把行落回 idle、**再**发这一帧的
// （handlers.RuntimeHandlers.fanout 的注释写着这条次序,理由正是「客户端收到终态帧后
// 立刻查清单必须已经看到 idle」）。所以收到这一帧时,对端那边就是 idle。
func TestApply_TurnDone_MirrorsIdleWithoutWaitingForTheNextSync(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.Equal(t, relaywire.SessionLifecycleRunning, r.lastLifecycle(t))

	require.NoError(t, r.mirror.Apply(ctx, runResultDone(conv42, 1)))

	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleIdle, r.lastLifecycle(t),
		"一轮跑完了,镜像里那一行不能还停在 running")
}

// 自主续轮把会话推回 running,结束时再落回 idle —— 与 daemon 的两端推进同一条规则
// （forwardAutonomousTurn:started 之前 runningSession,done 之前 finishSession）。
func TestApply_AutonomousTurn_MovesLifecycleBothWays(t *testing.T) {
	r := newRig(t)
	idle := runningSession(conv42, "写个爬虫")
	idle.LifecycleState = relaywire.SessionLifecycleIdle
	r.relay.sessions = []*agentrewire.SessionSummary{idle}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))

	require.NoError(t, r.mirror.Apply(ctx, autonomousTurnStarted(conv42, 1)))
	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleRunning, r.lastLifecycle(t))

	require.NoError(t, r.mirror.Apply(ctx, autonomousTurnDone(conv42, 2)))
	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleIdle, r.lastLifecycle(t))
}

// Given 一条实时通知的 seq 不比游标大(重复投递);When 它到达;Then 不落库。
func TestApply_DuplicateNotification_Dropped(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1), journalRow(conv42, 2)}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.Equal(t, []int64{1, 2}, r.seqs())

	require.NoError(t, r.mirror.Apply(ctx, notification(conv42, 2, "重放")))

	assert.Equal(t, []int64{1, 2}, r.seqs(), "已经镜像过的 seq 不该再写一行")
}

// Given 游标停在 2,而对端已经长到 5(中间那两条在断连的缝里丢了);
// When 一条 seq=5 的实时通知到达;Then 按游标补洞:3、4、5 一条不落、一条不重、按序落库。
func TestApply_SeqGap_PullsTheHole(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1), journalRow(conv42, 2)}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	r.relay.journal[conv42] = append(r.relay.journal[conv42], journalRow(conv42, 3), journalRow(conv42, 4), journalRow(conv42, 5))

	require.NoError(t, r.mirror.Apply(ctx, notification(conv42, 5, "跳号")))

	assert.Equal(t, []int64{1, 2, 3, 4, 5}, r.seqs())
	assert.Equal(t, int64(5), r.lastCursor(t))
}

// Given 一条本账号没保存过的对话(它在对端的清单里,但不在保存名单里);
// When 它的实时通知到达;Then 一个字都不落库(决策 2 的隐私边界)。
// 清单里还有一条**别的发起端**的对话,它同样不在名单里:范围判定只认 conversation_id。
func TestApply_UnsavedSession_WritesNothing(t *testing.T) {
	r := newRig(t)
	other := runningSession(conv101, "别的发起端的对话")
	other.PeerFingerprint = "fp-browser-9"
	r.relay.sessions = []*agentrewire.SessionSummary{
		runningSession(conv42, "保存过的"), runningSession(conv77, "没保存的"), other,
	}
	r.relay.journal[conv77] = []*agentrewire.JournaledNotification{journalRow(conv77, 1)}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.NoError(t, r.mirror.Apply(ctx, notification(conv77, 1, "别人的话")))

	assert.Empty(t, r.frames, "没保存过的对话不产生任何镜像行")
	for _, s := range r.upserts {
		assert.Equal(t, conv42, s.ConversationID)
		assert.Equal(t, testMachine, s.PeerFingerprint)
	}
	// 没保存过的那两条既没被接入,也没被拉。
	for _, p := range r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH) {
		att := p.(*agentrewire.SessionAttachRequest)
		assert.Equal(t, conv42, att.GetConversationId(), "只该接入保存过的那条")
	}
}

// ── 断连后按自己的游标补齐 ──────────────────────────────────────────────────

// Given 库里存着「本 server 镜像到 seq=2」,而对端日志已经有 1..5;
// When 重新连上跑一次同步;Then pull 带着自己的游标 2 发出(不是 0、也不是对端的高水位),
// 3/4/5 按序落库,1/2 一条都不重写,翻页把整段补完。
func TestSync_Reconnect_PullsFromOwnStoredCursor(t *testing.T) {
	r := newRig(t, storedSummary(testMachine, conv42, 2))
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{
		journalRow(conv42, 1), journalRow(conv42, 2), journalRow(conv42, 3), journalRow(conv42, 4), journalRow(conv42, 5),
	}
	r.relay.pageSize = 2 // 逼出翻页

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

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
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

	require.NotEmpty(t, r.upserts)
	got := r.upserts[len(r.upserts)-1]
	assert.Equal(t, testUserID, got.UserID)
	assert.Equal(t, conv42, got.ConversationID)
	assert.Equal(t, testMachine, got.PeerFingerprint)
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
	desktop := runningSession(conv42, "写个爬虫")
	desktop.Cwd = ""
	desktop.ProjectSyncId = "01KZN9FVVD69NY8M0VCEAABNMZ"
	r.relay.sessions = []*agentrewire.SessionSummary{desktop}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

	require.NotEmpty(t, r.upserts)
	got := r.upserts[len(r.upserts)-1]
	assert.Equal(t, "01KZN9FVVD69NY8M0VCEAABNMZ", got.ProjectSyncID)
}

// 没报项目的对端(agentred、以及升级前的桌面端)落的是空串,不是别的什么值 ——
// 服务端据这个空串决定「这条要拿 cwd 去跟项目路径比」。
func TestSync_PeerThatNamesNoProject_StoresBlankNotGuess(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

	require.NotEmpty(t, r.upserts)
	assert.Empty(t, r.upserts[len(r.upserts)-1].ProjectSyncID)
}

// ── 已中断的会话只 pull 不 attach ───────────────────────────────────────────

// Given 一条生命周期是 interrupted 的会话(那一轮的子进程随上个 daemon 进程消亡了,
// daemon 对它的 attach 一律回 ErrNoActiveTurn);When 同步;
// Then 一次 attach 都不发,历史照样按 pull 补齐。
func TestSync_InterruptedSession_PulledNeverAttached(t *testing.T) {
	r := newRig(t)
	s := runningSession(conv42, "上次没跑完的")
	s.LifecycleState = relaywire.SessionLifecycleInterrupted
	s.LatestSeq = 3
	r.relay.sessions = []*agentrewire.SessionSummary{s}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{
		journalRow(conv42, 1), journalRow(conv42, 2), journalRow(conv42, 3),
	}
	// attach 一旦发出就会失败 —— 断言里也就分得清「没发」和「发了但被吞了」。
	r.relay.attachErr = errors.New("no active turn")

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

	assert.Empty(t, r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH), "中断态会话不接入")
	assert.Equal(t, []int64{1, 2, 3}, r.seqs(), "但历史照样拉得回来")
	assert.Equal(t, int64(3), r.lastCursor(t))
}

// Given 清单说这条还活着、接入却失败了(清单与接入之间它刚被中断);
// When 同步;Then 历史仍然按 pull 补齐,不因为接不上就整条丢掉。
func TestSync_AttachFails_StillMirrorsHistory(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "刚断的")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1), journalRow(conv42, 2)}
	r.relay.attachErr = errors.New("no active turn")

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

	assert.Equal(t, []int64{1, 2}, r.seqs())
}

// ── 高水位低于自己的游标 = 对端整条删过,游标必须复位 ────────────────────────

// 这是 context 点名的那次静默冻结的唯一防线(桌面端 reconnect.go 的
// dropCursorAboveHighWater 同一条规则):对端的通知日志倒退回去(整段被清、从 1 重排)
// 时,本 server 的游标却停在旧高水位,此后每条实时通知都满足 seq <= 游标被当成重复
// 丢弃:不跳号、不报错、会话再也不出字。
//
// Given 库里的游标是 100,而对端接入时交回的高水位只有 3;
// When 同步;Then 游标当场复位(并且**先落库再拉**,否则进程一重启越界的老值原样读回来,
// 同一个冻结重演一遍),1..3 重新补齐,其后的实时通知照常落库。
func TestSync_PeerHighWaterBelowStoredCursor_ResetsInsteadOfFreezing(t *testing.T) {
	r := newRig(t, storedSummary(testMachine, conv42, 100))
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "日志倒退之后的这一段")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{
		journalRow(conv42, 1), journalRow(conv42, 2), journalRow(conv42, 3),
	}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))

	pulls := r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL)
	require.NotEmpty(t, pulls)
	first := pulls[0].(*agentrewire.SessionPullRequest)
	assert.Equal(t, int64(0), first.GetCursor(), "高水位在游标之下 = 对端日志退了,游标必须复位")
	require.NotEmpty(t, r.upserts)
	assert.Equal(t, int64(0), r.upserts[0].LatestSeq,
		"复位要当场落库,否则下次进程启动把越界的老值读回来,冻结重演")
	assert.Equal(t, []int64{1, 2, 3}, r.seqs())

	// 冻结的直接观测点:复位之后的实时通知照常落库(不复位的话 seq=4 <= 100 会被当成重复丢弃)。
	require.NoError(t, r.mirror.Apply(ctx, notification(conv42, 4, "接着说")))
	assert.Equal(t, []int64{1, 2, 3, 4}, r.seqs(), "复位之后对话要继续出字")
	assert.Equal(t, int64(4), r.lastCursor(t))
}

// Given 执行端把这条对话整条删掉,又用同一个会话标识开了新的一条(标识是执行端本地
// 自增的,删掉之后会被复用),库里还留着旧对话在这个身份键下的 1..5,本 server 的游标
// 停在旧对话的高水位;
// When 重连同步 —— 高水位低于游标,游标复位、从 0 重拉;
// Then 库里这条对话只剩新对话的帧。
//
// 复位本身不够:对端的通知日志倒退之后,同一把键 (账号, 对话, seq) 上新旧两批帧一模
// 一样,而批量写是 ON CONFLICT DO NOTHING —— 旧帧原地胜出。症状因此不是冻结,是
// **页面上显示的是上一段的转录**,所以断言看的是活下来的那些帧的内容,不是有没有调用过谁。
func TestSync_PeerJournalRewound_OldTranscriptPurgedBeforeReplay(t *testing.T) {
	store := newFakeStore()
	agent_session_repo.RegisterSummary(store)
	agent_session_repo.RegisterJournalFrame(store)
	ctx := context.Background()

	old := make([]*agent_session_entity.JournalFrame, 0, 5)
	for seq := int64(1); seq <= 5; seq++ {
		payload, err := proto.Marshal(notification(conv42, seq, fmt.Sprintf("上一条对话第%d句", seq)))
		require.NoError(t, err)
		old = append(old, &agent_session_entity.JournalFrame{
			UserID: testUserID, ConversationID: conv42, PeerFingerprint: testMachine, Seq: seq,
			Payload: payload,
		})
	}
	require.NoError(t, store.WriteFrames(ctx, old))
	require.NoError(t, store.UpsertSummary(ctx, &agent_session_entity.SessionSummary{
		UserID: testUserID, ConversationID: conv42, PeerFingerprint: testMachine,
		Title: "上一条对话", LatestSeq: 5,
	}))

	relay := newFakeRelay()
	relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "日志倒退之后的这一段")}
	relay.journal[conv42] = []*agentrewire.JournaledNotification{
		journalText(conv42, 1, "新对话第一句"), journalText(conv42, 2, "新对话第二句"),
	}

	require.NoError(t, New(testUserID, testMachine, relay).Sync(ctx,
		[]SavedSession{{ConversationID: conv42}}))

	got := store.framesOf(conv42)
	require.Len(t, got, 2, "旧的那一段必须先清掉:唯一键与新的一模一样,DO NOTHING 会让它们原地活下来")
	for _, f := range got {
		stored := &agentrewire.RpcNotification{}
		require.NoError(t, proto.Unmarshal(f.Payload, stored))
		assert.Contains(t, stored.GetRuntimeEvent().GetTextDelta().GetText(), "新对话", "留在库里的必须是重放回来的那一段")
	}
}

// Given 对端的高水位正常地在游标之上(会话还在长);When 同步;
// Then 不许复位 —— 复位在这里等于把已经镜像过的整段再重放一遍。
func TestSync_PeerHighWaterAboveCursor_KeepsCursor(t *testing.T) {
	r := newRig(t, storedSummary(testMachine, conv42, 2))
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{
		journalRow(conv42, 1), journalRow(conv42, 2), journalRow(conv42, 3),
	}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

	pulls := r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL)
	require.NotEmpty(t, pulls)
	first := pulls[0].(*agentrewire.SessionPullRequest)
	assert.Equal(t, int64(2), first.GetCursor())
	assert.Equal(t, []int64{3}, r.seqs())
}

// ── 同一条连接上两个发起端的两条对话,实时帧不许张冠李戴 ─────────────────────

// Given 同一条连接上两条保存过的对话,发起端不同(一条本机、一条浏览器派发);
// When 两条的实时通知先后到达;Then 各落各的行,按各自的 conversation_id 归位。
//
// 这里替下来的是旧的「同号歧义」用例:会话号从前是各端本地自增的,跨发起端必然重号,
// 而实时帧的载荷里只有那个号,于是镜像只能宁可不写。conversation_id 全局唯一之后那种
// 歧义**由构造消失** —— 不是防得更好了,是没有了,所以这里断言的是正面行为。
func TestApply_TwoOriginsOnOneConnection_EachFrameLandsOnItsOwnConversation(t *testing.T) {
	other := runningSession(conv77, "浏览器派发的那条")
	other.PeerFingerprint = "fp-browser-9"
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "本机发起的"), other}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{
		{ConversationID: conv42},
		{ConversationID: conv77},
	}))

	require.NoError(t, r.mirror.Apply(ctx, notification(conv42, 1, "本机这条")))
	require.NoError(t, r.mirror.Apply(ctx, notification(conv77, 1, "浏览器那条")))

	byConversation := map[string]string{}
	for _, f := range r.frames {
		stored := &agentrewire.RpcNotification{}
		require.NoError(t, proto.Unmarshal(f.Payload, stored))
		byConversation[f.ConversationID] = stored.GetRuntimeEvent().GetTextDelta().GetText()
	}
	assert.Equal(t, map[string]string{conv42: "本机这条", conv77: "浏览器那条"}, byConversation)
	assert.Equal(t, testMachine, frameOwner(t, r.frames, conv42))
	assert.Equal(t, "fp-browser-9", frameOwner(t, r.frames, conv77),
		"来源标注仍如实记着发起端,只是它不再是身份")
}

// frameOwner 取某条对话那些帧上记的来源指纹。
func frameOwner(t *testing.T, frames []*agent_session_entity.JournalFrame, conversationID string) string {
	t.Helper()
	for _, f := range frames {
		if f.ConversationID == conversationID {
			return f.PeerFingerprint
		}
	}
	t.Fatalf("这条对话一帧都没落库:%s", conversationID)
	return ""
}

// ── 对端的错误如实上交 ──────────────────────────────────────────────────────

// Given 拉取失败;When 同步;Then 错误上交给调用方(由它决定重连 / 退避),不装作成功。
func TestSync_PullFails_ReturnsError(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	r.relay.pullErr = errors.New("relay is gone")

	err := r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "relay is gone")
}

// Given 这台机器上一条保存过的对话都没有;When 同步;Then 一次调用都不发。
func TestSync_NothingSaved_TouchesNothing(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "没保存的")}

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
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	signals := &recordingSignals{}
	r.mirror.signals = signals

	require.NoError(t, r.mirror.Apply(ctx, notification(conv42, 1, "第一条")))

	require.Equal(t, []int64{testUserID}, signals.seen())
}

// Given 一条重复投递的通知;When 它被丢掉;Then 一声不出 —— 什么都没变,发一条只会
// 让这个账号所有在线连接白拉一页。
func TestApply_DuplicateNotification_SaysNothing(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1), journalRow(conv42, 2)}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	signals := &recordingSignals{}
	r.mirror.signals = signals

	require.NoError(t, r.mirror.Apply(ctx, notification(conv42, 2, "重放")))

	require.Empty(t, signals.seen())
}

// Given 重连后的一轮补齐;When 它把落下的历史写进镜像;Then 同样出声 —— 断线期间
// 攒下的变更也得让在线的控制台知道,而不是只有实时那一路才算数。
func TestSync_CatchUp_SignalsTheAccount(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1)}
	signals := &recordingSignals{}
	r.mirror.signals = signals

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

	require.Equal(t, []int64{testUserID}, signals.seen())
}

// Given 对端报出了这条对话钉的 ModelTarget；When 镜像同步它；
// Then 那两格原样落库 —— 机器离线时详情页据此仍显示得出模型，而这正是「已保存」
// 承诺的一部分。空是有含义的值（跟随 Agent 绑定），所以不补默认、不猜。
func TestSync_StoresSessionModelTarget(t *testing.T) {
	r := newRig(t)
	s := runningSession(conv42, "写个爬虫")
	s.ProviderKey = "prov-anthropic"
	s.ModelKey = "sonnet-4-6"
	r.relay.sessions = []*agentrewire.SessionSummary{s}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

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
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}

	require.NoError(t, r.mirror.Sync(context.Background(),
		[]SavedSession{{ConversationID: conv42}}))

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
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.NoError(t, r.mirror.Apply(ctx, notification(conv42, 1, "t1")))
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

// 补齐回来的帧,时刻取**对端报的**那个,不是这台 server 收到它的时刻。
//
// 两者在补齐这条路上差得很远:补齐是成批的,一条离线两天的对话几百帧会在同一毫秒里
// 落库,拿收帧时刻当发生时刻,浏览器控制台上整段转录就显示成同一分钟。对端的日志行
// 自己记着每一帧发生在什么时候(agentred 的 daemon_notification_journal.createtime),
// 那才是唯一说得通的来源。
func TestPullFrames_TakeThePeersReportedCreatetime(t *testing.T) {
	r := newRig(t)
	r.mirror.now = func() int64 { return 1_800_000_000_000 }
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	first := journalText(conv42, 1, "第一句")
	first.Createtime = 1_700_000_000_111
	second := journalText(conv42, 2, "第二句")
	second.Createtime = 1_700_000_009_222
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{first, second}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))

	require.Len(t, r.frames, 2)
	assert.Equal(t, int64(1_700_000_000_111), r.frames[0].Createtime)
	assert.Equal(t, int64(1_700_000_009_222), r.frames[1].Createtime)
}

// 还没升级到会报时刻的对端交出 0。0 原样落库,**不就地补成当下** —— 那会给一条两天前
// 的对话盖上今天的时间。下游读 0 为「不知道」,时间戳如实不显示。
func TestPullFrames_UnreportedCreatetimeStaysZero(t *testing.T) {
	r := newRig(t)
	r.mirror.now = func() int64 { return 1_800_000_000_000 }
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{journalText(conv42, 1, "第一句")}
	ctx := context.Background()

	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))

	require.Len(t, r.frames, 1)
	assert.Zero(t, r.frames[0].Createtime)
}

// ── 接不上的会话要有第二次机会 ─────────────────────────────────────────────

// Given 一条 interrupted 的会话（同步那一刻接不上，因此镜像不在它的订阅者集合里）;
// When 它在对端复活了（清单不再说 interrupted）、Revive 跑一遍;
// Then 镜像重新接上它，此后的实时帧照常镜像，那一行的生命周期也跟着更新。
//
// 少了这一步，interrupted 是个**自锁**状态：接不上 = 收不到实时帧 = 没有任何东西
// 能把那一行推离 interrupted（followTurn 要帧，Sync 只在出错 / 积压 / 保存名单变动
// 时才跑）。agentred 每次重启都会把非终态会话整批标成 interrupted，于是左栏那一列
// 状态点全部永久红着，「最近活动」也永久停在最后一次同步的时刻。
func TestRevive_InterruptedSessionCameBack_ReattachesAndKeepsMirroring(t *testing.T) {
	r := newRig(t)
	s := runningSession(conv42, "上次没跑完的")
	s.LifecycleState = relaywire.SessionLifecycleInterrupted
	r.relay.sessions = []*agentrewire.SessionSummary{s}
	r.relay.attachErr = errors.New("no active turn")
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.Equal(t, relaywire.SessionLifecycleInterrupted, r.lastLifecycle(t))

	// 对端那边它又跑起来了（用户从控制台发了一条消息，daemon 把行推回 running）。
	alive := runningSession(conv42, "上次没跑完的")
	r.relay.sessions = []*agentrewire.SessionSummary{alive}
	r.relay.attachErr = nil

	require.NoError(t, r.mirror.Revive(ctx))

	assert.NotEmpty(t, r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH),
		"复活之后要重新接上，否则再也收不到一帧")
	assert.Equal(t, relaywire.SessionLifecycleRunning, r.lastLifecycle(t))

	require.NoError(t, r.mirror.Apply(ctx, runResultDone(conv42, 1)))
	r.flush()
	assert.Equal(t, []int64{1}, r.seqs(), "重新接上之后的实时帧照常落库")
	assert.Equal(t, relaywire.SessionLifecycleIdle, r.lastLifecycle(t))
}

// Given 全部会话都已经接上;When Revive 跑;Then 一个请求都不发 —— 它是常驻循环上
// 的定期动作，没有接不上的会话时必须是零开销，否则每台机器每分钟都在白问一次清单。
func TestRevive_NothingUnattached_MakesNoCalls(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	before := r.relay.callCount()

	require.NoError(t, r.mirror.Revive(ctx))

	assert.Equal(t, before, r.relay.callCount(), "没有接不上的会话时不该发任何请求")
}

// Given 那条会话在对端仍然是 interrupted;When Revive 跑;Then 只问清单、不试接入
// —— daemon 对它一律回 ErrNoActiveTurn，试一次只是白发一个注定失败的请求。
func TestRevive_StillInterrupted_ListsButDoesNotAttach(t *testing.T) {
	r := newRig(t)
	s := runningSession(conv42, "上次没跑完的")
	s.LifecycleState = relaywire.SessionLifecycleInterrupted
	r.relay.sessions = []*agentrewire.SessionSummary{s}
	r.relay.attachErr = errors.New("no active turn")
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	lists := len(r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_LIST))

	require.NoError(t, r.mirror.Revive(ctx))

	assert.Len(t, r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_LIST), lists+1,
		"要问一次清单才知道它是不是还中断着")
	assert.Empty(t, r.relay.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH),
		"还中断着就不必试那个注定失败的接入")
}

// ── 补洞路径上的轮次边界同样要推进生命周期 ─────────────────────────────────

// Given 一条在跑的会话;When 它的终态帧跳着号到达（seq > 游标 + 1，实时投递漏了
// 中间那几条）;Then 补完洞之后那一行必须已经是 idle。
//
// 补洞分支此前拉完就 saveSummary，而 saveSummary 写的是**清单快照**里的生命周期
// ——那一份还停在 running。于是「轮次跑完了」这件事只在实时帧恰好连号时才看得见，
// 漏一帧就把这条对话永久钉在「运行中」。
func TestApply_TurnDoneArrivesThroughAGap_StillLandsIdle(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	r.relay.journal[conv42] = []*agentrewire.JournaledNotification{
		journalRow(conv42, 1), journalRow(conv42, 2),
	}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.Equal(t, relaywire.SessionLifecycleRunning, r.lastLifecycle(t))

	// 游标停在 2（同步时拉回来的），终态帧是 4：中间的 3 漏了。
	require.NoError(t, r.mirror.Apply(ctx, runResultDone(conv42, 4)))

	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleIdle, r.lastLifecycle(t),
		"漏了一帧不该让这条对话永久停在「运行中」")
}

// Given 一条闲着的会话;When 用户在别处（控制台 / 手机）对它发了一条消息,
// daemon 发出这一轮的开始通知;Then 镜像那一行立刻变成 running。
//
// 此前镜像只认得轮次的**结束**：用户自己发起的那一轮在协议上没有开始通知，所以
// 「我刚发了一条消息」在左栏是看不出来的 —— 点是灰的，等这一轮跑完了才被推回
// idle（还是灰的）。整轮里那条对话从头到尾显示成闲着。
func TestApply_UserTurnStarted_MovesLifecycleToRunning(t *testing.T) {
	r := newRig(t)
	idle := runningSession(conv42, "写个爬虫")
	idle.LifecycleState = relaywire.SessionLifecycleIdle
	r.relay.sessions = []*agentrewire.SessionSummary{idle}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.Equal(t, relaywire.SessionLifecycleIdle, r.lastLifecycle(t))

	require.NoError(t, r.mirror.Apply(ctx, turnStarted(conv42, 1)))
	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleRunning, r.lastLifecycle(t))

	require.NoError(t, r.mirror.Apply(ctx, runResultDone(conv42, 2)))
	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleIdle, r.lastLifecycle(t), "跑完了还是要落回 idle")
}

// ── 审批与提问:等待输入同样跟着帧走 ────────────────────────────────────────

// lastWaiting 是摘要最后一次落库时的「正在等你处理」。
func (r *rig) lastWaiting(t *testing.T) bool {
	t.Helper()
	require.NotEmpty(t, r.upserts, "摘要从来没落过库")
	return r.upserts[len(r.upserts)-1].WaitingForInput
}

func toolPermissionRequest(sid string, seq int64, requestID string) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
		RuntimeEvent: &agentrewire.RuntimeEventNotification{
			ConversationId: sid, Seq: seq,
			Event: &agentrewire.RuntimeEventNotification_ToolPermissionRequest{
				ToolPermissionRequest: &agentrewire.ToolPermissionRequest{
					RequestId: requestID, ToolName: "Bash",
				},
			},
		},
	}}
}

func toolPermissionResolved(sid string, seq int64, requestID string) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
		RuntimeEvent: &agentrewire.RuntimeEventNotification{
			ConversationId: sid, Seq: seq,
			Event: &agentrewire.RuntimeEventNotification_ToolPermissionResolved{
				ToolPermissionResolved: &agentrewire.ToolPermissionResolved{
					RequestId: requestID, Allowed: true,
				},
			},
		},
	}}
}

func userAskRequest(sid string, seq int64, requestID string) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
		RuntimeEvent: &agentrewire.RuntimeEventNotification{
			ConversationId: sid, Seq: seq,
			Event: &agentrewire.RuntimeEventNotification_UserAskRequest{
				UserAskRequest: &agentrewire.UserAskRequest{RequestId: requestID},
			},
		},
	}}
}

func userAskResolved(sid string, seq int64, requestID string) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
		RuntimeEvent: &agentrewire.RuntimeEventNotification{
			ConversationId: sid, Seq: seq,
			Event: &agentrewire.RuntimeEventNotification_UserAskResolved{
				UserAskResolved: &agentrewire.UserAskResolved{RequestId: requestID},
			},
		},
	}}
}

// Given 一条在跑、还没有人在等的会话;When 它发出一次工具审批请求;
// Then 镜像那一行立刻是「正在等你处理」,审批落定之后又立刻不是。
//
// 「等待输入」的另一条来路是 Sync 的清单快照，而 Sync 只在出错 / 积压 / 保存名单
// 变动 / 换连接时才跑：常驻循环上没有任何定期的清单请求。于是一条卡在审批上的对话
// 在控制台的列表里始终是「运行中」，审批完成之后（如果快照恰好在等待时拍过）又会
// 始终停在「等你处理」。这一列必须和生命周期一样跟着帧走。
func TestApply_ToolPermission_TracksWaitingForInput(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.False(t, r.lastWaiting(t), "起手没有人在等")

	require.NoError(t, r.mirror.Apply(ctx, toolPermissionRequest(conv42, 1, "req-1")))
	r.flush()
	assert.True(t, r.lastWaiting(t), "审批请求发出来了，列表得说得出「等你处理」")

	require.NoError(t, r.mirror.Apply(ctx, toolPermissionResolved(conv42, 2, "req-1")))
	r.flush()
	assert.False(t, r.lastWaiting(t), "审批落定之后不该一直挂着")
}

// 提问（AskUserQuestion）与工具审批在 daemon 那侧是同一个判据的两半
// （waitingForInput = 待决审批数 + 待决提问数 > 0），镜像这一侧同样两半都认。
func TestApply_UserAsk_TracksWaitingForInput(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))

	require.NoError(t, r.mirror.Apply(ctx, userAskRequest(conv42, 1, "ask-1")))
	r.flush()
	assert.True(t, r.lastWaiting(t))

	require.NoError(t, r.mirror.Apply(ctx, userAskResolved(conv42, 2, "ask-1")))
	r.flush()
	assert.False(t, r.lastWaiting(t))
}

// Given 一条正等着审批的会话;When 这一轮结束了(用户中断 / 后端自己收场),而那次审批
// 从来没有一条落定帧;Then 镜像那一行不再说「等你处理」。
//
// waiter 是**进程内、按轮**的（daemon 的 R11：落库的等待标志会活过重启，变成一个
// 没人能回答的问题）。轮次一结束它就不可能还活着，所以终态帧就是这一列的兜底出口
// ——否则一次没有落定帧的中断会把那一行永久钉在「等你处理」。
func TestApply_TurnDone_ClearsWaitingForInput(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))

	require.NoError(t, r.mirror.Apply(ctx, toolPermissionRequest(conv42, 1, "req-1")))
	r.flush()
	require.True(t, r.lastWaiting(t))

	require.NoError(t, r.mirror.Apply(ctx, runResultDone(conv42, 2)))
	r.flush()
	assert.False(t, r.lastWaiting(t), "轮次结束了，那次审批不可能还有人能回答")
}

// Given 对端的清单快照说这条会话正在等输入;When 还没有任何 waiter 帧到达;
// Then 镜像照抄快照 —— 帧没说话时快照仍然是权威，本地不擅自清掉它。
func TestSync_WaitingFromSnapshot_SurvivesUnrelatedFrames(t *testing.T) {
	r := newRig(t)
	waiting := runningSession(conv42, "写个爬虫")
	waiting.WaitingForInput = true
	r.relay.sessions = []*agentrewire.SessionSummary{waiting}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.True(t, r.lastWaiting(t))

	// 一条与审批无关的实时帧不改这一列。
	require.NoError(t, r.mirror.Apply(ctx, notification(conv42, 1, "hi")))
	r.flush()
	assert.True(t, r.lastWaiting(t))
}

// ── 跑挂的那一轮:镜像那一行落 failed,而不是被推回 idle ──────────────────────

// runResultFailed 造一条**故障收场**的终态帧:带停止文案、没有中断 sentinel。
func runResultFailed(sid string, seq int64, msg string) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RunResultDone{
		RunResultDone: &agentrewire.RunResultDoneNotification{
			ConversationId: sid, Seq: seq, StopErrorMessage: msg,
		},
	}}
}

// runResultAborted 造一条**用户按了停止**的终态帧:同样带文案,但带中断 sentinel。
func runResultAborted(sid string, seq int64) *agentrewire.RpcNotification {
	return &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RunResultDone{
		RunResultDone: &agentrewire.RunResultDoneNotification{
			ConversationId: sid, Seq: seq,
			StopErrorMessage: "aborted", StopErrorCode: turnstate.AbortedCode,
		},
	}}
}

// Given 一条在跑的会话;When 它以故障收场;Then 镜像那一行是 failed。
//
// followTurn 此前把**每一条**终态帧都翻译成 idle:哪怕 agentred 刚把自己那一行落成
// failed,紧接着的这次镜像写入也会原地把它冲回 idle —— 跑挂在控制台的列表里因此照样
// 看不出来。判据走共享 module 的 turnstate.IsFailure,与 agentred 落行时用的是同一句话。
func TestApply_TurnFailed_LandsFailedLifecycle(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))
	require.Equal(t, relaywire.SessionLifecycleRunning, r.lastLifecycle(t))

	require.NoError(t, r.mirror.Apply(ctx, runResultFailed(conv42, 1, "exit status 1")))
	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleFailed, r.lastLifecycle(t),
		"跑挂的那一轮不能被推回 idle")
}

// Given 用户自己按了停止;When 那一轮收场;Then 镜像照旧落 idle。
//
// 中断在线上同样带停止文案,只有 sentinel 分得开。不认这一格的话,每点一次「停止」
// 都会在列表里留下一条红着的会话。
func TestApply_TurnAborted_StaysIdle(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))

	require.NoError(t, r.mirror.Apply(ctx, runResultAborted(conv42, 1)))
	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleIdle, r.lastLifecycle(t),
		"用户按的停止不是故障")
}

// Given 一条上一轮跑挂的会话;When 用户再发一轮;Then 它回到 running,跑完落回 idle。
// failed 只是一个关于上一轮的事实,不是终点 —— 与 interrupted 的分界正在这里。
func TestApply_AfterFailure_NextTurnClearsIt(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))

	require.NoError(t, r.mirror.Apply(ctx, runResultFailed(conv42, 1, "boom")))
	r.flush()
	require.Equal(t, relaywire.SessionLifecycleFailed, r.lastLifecycle(t))

	require.NoError(t, r.mirror.Apply(ctx, turnStarted(conv42, 2)))
	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleRunning, r.lastLifecycle(t))

	require.NoError(t, r.mirror.Apply(ctx, runResultDone(conv42, 3)))
	r.flush()
	assert.Equal(t, relaywire.SessionLifecycleIdle, r.lastLifecycle(t))
}

// 跑挂的那一轮同样把待决清空:waiter 是按轮的,轮结束它不可能还有人能回答。
func TestApply_TurnFailed_ClearsWaitingForInput(t *testing.T) {
	r := newRig(t)
	r.relay.sessions = []*agentrewire.SessionSummary{runningSession(conv42, "写个爬虫")}
	ctx := context.Background()
	require.NoError(t, r.mirror.Sync(ctx, []SavedSession{{ConversationID: conv42}}))

	require.NoError(t, r.mirror.Apply(ctx, toolPermissionRequest(conv42, 1, "req-1")))
	r.flush()
	require.True(t, r.lastWaiting(t))

	require.NoError(t, r.mirror.Apply(ctx, runResultFailed(conv42, 2, "boom")))
	r.flush()
	assert.False(t, r.lastWaiting(t))
}
