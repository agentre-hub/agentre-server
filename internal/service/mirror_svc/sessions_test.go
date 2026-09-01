package mirror_svc

import (
	"context"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
)

// ── 假的保存名单与假的待办表:两者都按真表的语义存状态,断言看的是状态 ──────────

type fakeSaves struct {
	mu   sync.Mutex
	rows []agent_session_entity.SessionSave
}

// newFakeSaves 造一份保存名单并当场装配进去:名单是镜像范围的唯一来源。
func newFakeSaves(rows ...agent_session_entity.SessionSave) *fakeSaves {
	f := &fakeSaves{rows: rows}
	agent_session_repo.RegisterSave(f)
	return f
}

// saved 造一条保存记录:发起端就是承载它的那台机器自己 —— 桌面端的全部,以及
// 加列迁移回填过的每一行。
func saved(userID int64, fingerprint, conversationID string) agent_session_entity.SessionSave {
	return agent_session_entity.SessionSave{
		UserID: userID, ConversationID: conversationID,
		DeviceFingerprint: fingerprint, PeerFingerprint: fingerprint, FollowedAt: 1000,
	}
}

// savedFromPeer 造一条**别的端发起、这台机器承载**的保存记录(web 控制台派发出去的
// 那些)。两个指纹不是同一个值 —— 身份只有 conversation_id 一个,但「去连哪一台」
// 与「谁发起的」仍是两个不同的问题。
func savedFromPeer(userID int64, machine, initiator, conversationID string) agent_session_entity.SessionSave {
	row := saved(userID, machine, conversationID)
	row.PeerFingerprint = initiator
	return row
}

func (f *fakeSaves) Save(_ context.Context, row *agent_session_entity.SessionSave) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows = append(f.rows, *row)
	return nil
}

func (f *fakeSaves) Delete(
	_ context.Context, userID int64, conversationID string,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	kept := f.rows[:0]
	for _, row := range f.rows {
		if row.UserID == userID && row.ConversationID == conversationID {
			continue
		}
		kept = append(kept, row)
	}
	f.rows = kept
	return nil
}

func (f *fakeSaves) FindByIdentity(
	_ context.Context, userID int64, conversationID string,
) (*agent_session_entity.SessionSave, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.rows {
		if row.UserID == userID && row.ConversationID == conversationID {
			copied := row
			return &copied, nil
		}
	}
	return nil, nil
}

func (f *fakeSaves) ListByUser(_ context.Context, userID int64) ([]*agent_session_entity.SessionSave, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*agent_session_entity.SessionSave
	for _, row := range f.rows {
		if row.UserID != userID {
			continue
		}
		copied := row
		out = append(out, &copied)
	}
	return out, nil
}

func (f *fakeSaves) ListMachines(_ context.Context) ([]agent_session_repo.Machine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := map[agent_session_repo.Machine]bool{}
	var out []agent_session_repo.Machine
	for _, row := range f.rows {
		m := agent_session_repo.Machine{UserID: row.UserID, Fingerprint: row.DeviceFingerprint}
		if seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Fingerprint < out[j].Fingerprint })
	return out, nil
}

type fakeTodos struct {
	mu   sync.Mutex
	rows []agent_session_entity.DeleteTodo
}

func newFakeTodos(rows ...agent_session_entity.DeleteTodo) *fakeTodos {
	return &fakeTodos{rows: rows}
}

func todo(userID int64, fingerprint, conversationID string) agent_session_entity.DeleteTodo {
	return agent_session_entity.DeleteTodo{
		UserID: userID, ConversationID: conversationID, PeerFingerprint: fingerprint,
	}
}

func (f *fakeTodos) AddDeleteTodo(_ context.Context, row *agent_session_entity.DeleteTodo) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows = append(f.rows, *row)
	return nil
}

func (f *fakeTodos) ListDeleteTodosByPeer(
	_ context.Context, userID int64, fingerprint string,
) ([]*agent_session_entity.DeleteTodo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*agent_session_entity.DeleteTodo
	for _, row := range f.rows {
		if row.UserID == userID && row.PeerFingerprint == fingerprint {
			copied := row
			out = append(out, &copied)
		}
	}
	return out, nil
}

func (f *fakeTodos) RemoveDeleteTodo(_ context.Context, userID int64, conversationID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	kept := f.rows[:0]
	for _, row := range f.rows {
		if row.UserID == userID && row.ConversationID == conversationID {
			continue
		}
		kept = append(kept, row)
	}
	f.rows = kept
	return nil
}

func (f *fakeTodos) RemoveDeleteTodosByPeer(_ context.Context, userID int64, fingerprint string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	kept := f.rows[:0]
	for _, row := range f.rows {
		if row.UserID == userID && row.PeerFingerprint == fingerprint {
			continue
		}
		kept = append(kept, row)
	}
	f.rows = kept
	return nil
}

func (f *fakeTodos) ListPendingMachines(_ context.Context) ([]agent_session_repo.PendingMachine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := map[agent_session_repo.PendingMachine]bool{}
	var out []agent_session_repo.PendingMachine
	for _, row := range f.rows {
		m := agent_session_repo.PendingMachine{UserID: row.UserID, PeerFingerprint: row.PeerFingerprint}
		if seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PeerFingerprint < out[j].PeerFingerprint })
	return out, nil
}

func (f *fakeTodos) pending() []agent_session_entity.DeleteTodo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agent_session_entity.DeleteTodo(nil), f.rows...)
}

// ── 保存:那条对话的镜像当场开起来 ───────────────────────────────────────────

// Given 账号刚在一台在线的机器上保存了一条对话(名单里已经有它,库里一个字都还没有);
// When 保存路径要求镜像开始;Then 这台机器被跟起来,那条对话的转录当场落库。
func TestBegin_SavedConversationOnOnlineMachine_StartsMirroringIt(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves(saved(testUserID, testMachine, conv42))
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	rig.peer.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1), journalRow(conv42, 2)}
	a := rig.replica(t, replicaA)

	require.NoError(t, NewSessions(a.sup).Begin(context.Background(), testUserID, testMachine, conv42))

	assert.True(t, a.sup.follows(testUserID, testMachine), "保存之后这台机器该被跟着")
	assert.Equal(t, []int64{1, 2}, rig.store.rowSeqs(conv42))
}

// Given 一条从 web 控制台派发出去的对话:承载它的是这台机器,而执行端把它键在
// **浏览器**的中继标识下(agentred 的 daemon_sessions.peer_fingerprint 存的就是它,
// session.list 也照样报回来);When 保存路径要求镜像开始;Then 它照样被镜像下来,
// 且落在**发起端**那把身份键上。
//
// 此前这条永远进不来:名单里那一列既当「去连哪台机器」又当身份键的 owner 那一半,
// 而这两者对 web 派发根本不是同一个值 —— Sync 的 wanted 判定于是永远不相等,每一轮
// 巡检都把它当成「你没保存过的、别人的对话」跳过去。用户那一侧看到的是:对话在机器
// 上真的建起来了、账号里也真的保存了,左栏却一行都没有。
func TestBegin_WebDispatchedConversation_MirroredUnderItsInitiator(t *testing.T) {
	const browser = "991b9464868dfb6340bd09eeef14f196"
	rig := newResidentRig(t)
	newFakeSaves(savedFromPeer(testUserID, testMachine, browser, conv42))
	session := machineSession(conv42, "跑一下失败的测试")
	session.PeerFingerprint = browser
	rig.peer.sessions = []*agentrewire.SessionSummary{session}
	rig.peer.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1), journalRow(conv42, 2)}
	a := rig.replica(t, replicaA)

	require.NoError(t, NewSessions(a.sup).Begin(context.Background(), testUserID, testMachine, conv42))

	assert.True(t, a.sup.follows(testUserID, testMachine), "连的仍然是承载它的那台机器")
	assert.Equal(t, []int64{1, 2}, rig.store.rowSeqs(conv42),
		"转录该落在发起端那把键上 —— 镜像内容与执行端解会话用的是同一把")
}

// Given 这台机器现在联系不上;When 保存路径要求镜像开始;
// Then 如实报错 —— 名单里那一条留着,巡检回头替它接上,但调用方不能被告知「已经在存了」。
func TestBegin_MachineOffline_ReportsFailure(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves(saved(testUserID, testMachine, conv42))
	a := rig.replica(t, replicaA)
	a.net.setOnline(false)

	err := NewSessions(a.sup).Begin(context.Background(), testUserID, testMachine, conv42)

	require.Error(t, err)
	assert.False(t, a.sup.follows(testUserID, testMachine))
}

// ── 删除:server 上那一份连内容一起没了,而且不会被写回来 ──────────────────────

// Given 一条已经镜像下来的对话(摘要与转录都在库里),这台机器正被本副本跟着;
// When 删除清掉 server 那一份;Then 摘要与转录一行不剩,并且此后这条对话的实时通知
// **不再落库** —— 只清库不停镜像的话,下一帧就把它写回来了。
func TestPurge_ClearsStoredContentAndStopsMirroringThatConversation(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves(saved(testUserID, testMachine, conv42))
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "要删掉的")}
	rig.peer.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1)}
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)
	require.Equal(t, []int64{1}, rig.store.rowSeqs(conv42))

	require.NoError(t, NewSessions(a.sup).Purge(ctx, testUserID, testMachine, conv42))

	assert.Empty(t, rig.store.rowSeqs(conv42), "转录要跟着一起清掉")
	assert.Empty(t, rig.store.summaryOf(testUserID, conv42), "摘要也没了,索引里当场看不到它")
	a.net.emit(t, notification(conv42, 2, "删完还在说"))
	assert.Never(t, func() bool { return len(rig.store.rowSeqs(conv42)) > 0 },
		200*time.Millisecond, 5*time.Millisecond, "删掉之后的实时帧一个字都不该再落库")
}

// Given 一条从来没镜像过的对话;When 删除;Then 幂等成功 —— 删一条早已不在的对话不是错误。
func TestPurge_NothingStored_IsIdempotent(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	a := rig.replica(t, replicaA)

	require.NoError(t, NewSessions(a.sup).Purge(context.Background(), testUserID, testMachine, conv42))
}

// ── 把删除传到执行端 ────────────────────────────────────────────────────────

// Given 执行那条对话的机器在线;When 把删除传过去;Then 它收到 typed session.delete,
// 带着这条对话的 conversation_id,而且**不点名对端** —— 这条连接通到的就是它,点名会被拒。
func TestDeleteOnPeer_OnlineMachine_SendsSessionDelete(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	a := rig.replica(t, replicaA)

	require.NoError(t, NewSessions(a.sup).DeleteOnPeer(context.Background(), testUserID, testMachine, conv42))

	deletes := rig.peer.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_DELETE)
	require.Len(t, deletes, 1)
	p := deletes[0].(*agentrewire.SessionDeleteRequest)
	assert.Equal(t, conv42, p.GetConversationId())
	assert.Empty(t, p.GetPeerFingerprint(), "连接通到的就是这台机器,点名它自己会被拒")
}

// Given 那台机器现在联系不上;When 把删除传过去;Then 报「机器离线」——
// 调用方据此留一条待办,等它回来补删(决策 6)。
func TestDeleteOnPeer_MachineOffline_ReportsOffline(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	a := rig.replica(t, replicaA)
	a.net.setOnline(false)

	err := NewSessions(a.sup).DeleteOnPeer(context.Background(), testUserID, testMachine, conv42)

	require.ErrorIs(t, err, ErrMachineOffline)
}

// Given 执行端太老、根本不认识这个 typed RPC method;When 把删除传过去;
// Then 报「不支持」——它必须与「这一次没删成」分开:后者等机器回来再删一遍就成了,
// 前者重试多少次都是同一个结果,留待办等于对着一台永远答不了的机器重放。
func TestDeleteOnPeer_MethodNotFound_PreservesProtocolError(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	rig.peer.deleteErr = &relaywire.Error{Code: relaywire.CodeMethodNotFound, Message: "Method not found"}
	a := rig.replica(t, replicaA)

	err := NewSessions(a.sup).DeleteOnPeer(context.Background(), testUserID, testMachine, conv42)

	var wireErr *relaywire.Error
	require.ErrorAs(t, err, &wireErr)
	assert.Equal(t, relaywire.CodeMethodNotFound, wireErr.Code)
}

// ── 设备被撤销:挂在它上面、永远执行不了的待办一并清掉 ────────────────────────

// Given 一台机器上压着两条删除待办、别的机器上也有一条,而这台机器上还有一条已经
// 镜像下来的对话;
// When 这台设备被撤销,连带清理跑过来;Then 只有这台机器上的待办没了 —— 它已经不归
// 这个账号管,那些指令永远执行不了(决策 7);别的机器一条都不许动,而**账号里那条
// 对话原封不动地留着**:摘要与转录都读得到,它只是从此只读。
func TestPurgeMachineDeleteTodos_ClearsTodosOfThatMachineAndKeepsItsConversations(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves(saved(testUserID, testMachine, conv42))
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "退役机器上的老对话")}
	rig.peer.journal[conv42] = []*agentrewire.JournaledNotification{journalRow(conv42, 1), journalRow(conv42, 2)}
	todos := newFakeTodos(
		todo(testUserID, testMachine, conv43),
		todo(testUserID, testMachine, conv44),
		todo(testUserID, "fp-other-machine", conv7),
	)
	agent_session_repo.RegisterDeleteTodo(todos)
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	claimed, err := a.sup.Follow(ctx, testUserID, testMachine, savedOn(conv42))
	require.NoError(t, err)
	require.True(t, claimed)

	require.NoError(t, NewSessions(a.sup).PurgeMachineDeleteTodos(ctx, testUserID, testMachine))

	assert.Equal(t, []agent_session_entity.DeleteTodo{todo(testUserID, "fp-other-machine", conv7)}, todos.pending())
	assert.Equal(t, []int64{1, 2}, rig.store.rowSeqs(conv42), "撤销设备不动账号里的对话")
	assert.NotEmpty(t, rig.store.summaryOf(testUserID, conv42), "索引里它还在,只是此后只读")
}

// ── 攒下的删除待办:那台机器回来时补做 ───────────────────────────────────────

// Given 两条对话是在机器离线时删掉的(server 那份当场就没了,各留下一条待办),
// 而这台机器现在回来了;
// When 巡检补做待办;Then 两条都被送到那台机器上删掉,待办随之勾掉。
//
// 没有这一步,「删了就是删了」在**最常见的那个情形**下只兑现一半:本轮删除的主场景
// 恰恰是机器离线(决策 6 就是为它才允许先删 server 那份),而待办要是没人重放,
// 执行端上那一份就永远留着。
func TestReplayPendingDeletes_MachineBack_DeletesOnPeerAndClearsTodos(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	todos := newFakeTodos(
		todo(testUserID, testMachine, conv42),
		todo(testUserID, testMachine, conv43),
		todo(testUserID, "fp-other-machine", conv7), // 那台还没回来
	)
	agent_session_repo.RegisterDeleteTodo(todos)
	a := rig.replica(t, replicaA)
	a.net.failConnect("fp-other-machine")

	err := NewSessions(a.sup).ReplayPendingDeletes(context.Background())

	require.Error(t, err, "连不上的那台要如实上交,别让这一轮看起来一切正常")
	var sent []string
	for _, request := range rig.peer.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_DELETE) {
		p := request.(*agentrewire.SessionDeleteRequest)
		sent = append(sent, p.GetConversationId())
	}
	sort.Strings(sent)
	want := []string{conv42, conv43}
	sort.Strings(want)
	assert.Equal(t, want, sent, "机器回来了,它欠的每一条删除都要补做")
	assert.Equal(t, []agent_session_entity.DeleteTodo{todo(testUserID, "fp-other-machine", conv7)},
		todos.pending(), "做完的勾掉,别的机器上那条一条都不许动")
}

// Given 那台机器还没回来;When 巡检补做;Then 一次连接都不发起,待办原样留着 ——
// 它下次上线时才轮得到它。
func TestReplayPendingDeletes_MachineStillOffline_KeepsTodos(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	todos := newFakeTodos(todo(testUserID, testMachine, conv42))
	agent_session_repo.RegisterDeleteTodo(todos)
	a := rig.replica(t, replicaA)
	a.net.setOnline(false)

	require.NoError(t, NewSessions(a.sup).ReplayPendingDeletes(context.Background()),
		"机器还没回来不是故障")

	connects, _, _ := a.net.counts()
	assert.Zero(t, connects, "离线的机器一次连接都不该发起")
	assert.Equal(t, []agent_session_entity.DeleteTodo{todo(testUserID, testMachine, conv42)}, todos.pending())
}

// Given 执行端太老、这辈子都不认识 typed session.delete;When 巡检补做;
// Then 待办勾掉、不再重放 —— 重试多少次都是同一个结果,留着只会对着一台永远答不了
// 的机器重放到天荒地老(与 saved_session_svc 那一侧同一条判据)。
func TestReplayPendingDeletes_MethodNotFound_DropsTodoAndReportsProtocolError(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	rig.peer.deleteErr = &relaywire.Error{Code: relaywire.CodeMethodNotFound, Message: "Method not found"}
	todos := newFakeTodos(todo(testUserID, testMachine, conv42))
	agent_session_repo.RegisterDeleteTodo(todos)
	a := rig.replica(t, replicaA)

	err := NewSessions(a.sup).ReplayPendingDeletes(context.Background())

	require.Error(t, err, "当前协议缺少必需方法是实现错误")
	assert.Empty(t, todos.pending(), "协议实现错误不可通过定时重试恢复")
}

// Given 这一次没删成(那一端报了个别的错);When 巡检补做;
// Then 待办留着,下一轮再来 —— 这与「对面太老」必须分开。
func TestReplayPendingDeletes_PeerFailedThisTime_KeepsTodoForTheNextPass(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	rig.peer.deleteErr = &relaywire.Error{Code: -32000, Message: "disk is gone"}
	todos := newFakeTodos(todo(testUserID, testMachine, conv42))
	agent_session_repo.RegisterDeleteTodo(todos)
	a := rig.replica(t, replicaA)

	err := NewSessions(a.sup).ReplayPendingDeletes(context.Background())

	require.Error(t, err, "没删成要如实上交")
	assert.Equal(t, []agent_session_entity.DeleteTodo{todo(testUserID, testMachine, conv42)}, todos.pending(),
		"等它下一轮再删一遍就成了,不能当成永远执行不了")
}

// Given 一条对话在机器离线时被删掉(待办还压着),机器回来之后用户又把**同一条**
// 重新保存进了账号;
// When 巡检补做待办;Then 那条删除不发出去,待办直接勾掉 —— 账号此刻的保存名单
// 才是权威(与 Mirror.pruneUnwanted 同一条原则),照着一条已经被用户收回的删除
// 打过去,毁掉的是他刚刚保存的那条对话。
func TestReplayPendingDeletes_ConversationSavedAgain_DoesNotDeleteIt(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves(saved(testUserID, testMachine, conv42))
	todos := newFakeTodos(todo(testUserID, testMachine, conv42))
	agent_session_repo.RegisterDeleteTodo(todos)
	a := rig.replica(t, replicaA)

	require.NoError(t, NewSessions(a.sup).ReplayPendingDeletes(context.Background()))

	assert.Empty(t, rig.peer.callsOf(agentrewire.RpcMethod_RPC_METHOD_SESSION_DELETE),
		"用户已经把它重新保存了,这条删除不该再发出去")
	assert.Empty(t, todos.pending(), "收回的删除意图也不该一直排在那儿")
}
