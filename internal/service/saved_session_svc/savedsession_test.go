package saved_session_svc

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo/mock_agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
)

// stubMirror 是镜像那一侧的假实现：记下每一次调用的次序与目标，并可以让开始 /
// 清除失败。真实实现在 mirror_svc（后续任务接线），本层只依赖这个窄接口。
type stubMirror struct {
	calls    *[]string
	begun    []SessionRef
	purged   []SessionRef
	beginErr error
	purgeErr error
}

// 两条对话的 conversation_id（决策 1 的规范形式）。
const (
	conversationA = "3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"
	conversationB = "5b8c9d2e-1f30-7c55-b214-9d7e3a6b0c11"
)

func (s *stubMirror) Begin(_ context.Context, ref SessionRef) error {
	*s.calls = append(*s.calls, "mirror:begin")
	if s.beginErr != nil {
		return s.beginErr
	}
	s.begun = append(s.begun, ref)
	return nil
}

func (s *stubMirror) Purge(_ context.Context, ref SessionRef) error {
	*s.calls = append(*s.calls, "mirror:purge")
	if s.purgeErr != nil {
		return s.purgeErr
	}
	s.purged = append(s.purged, ref)
	return nil
}

// stubPeer 是执行端那一侧的假实现：err 决定这台机器怎么回话——nil 是删掉了，
// ErrMachineOffline 是联系不上；协议方法缺失由 ErrMachineProtocolViolation 表达。
type stubPeer struct {
	calls   *[]string
	deleted []SessionRef
	err     error
	// errByFP 按目标机器覆盖 err：同一次删除要拨两台机器时，让它们各答各的。
	errByFP map[string]error
}

func (s *stubPeer) DeleteOnMachine(_ context.Context, ref SessionRef) error {
	*s.calls = append(*s.calls, "peer:delete:"+ref.MachineFingerprint)
	if e, ok := s.errByFP[ref.MachineFingerprint]; ok {
		if e != nil {
			return e
		}
		s.deleted = append(s.deleted, ref)
		return nil
	}
	if s.err != nil {
		return s.err
	}
	s.deleted = append(s.deleted, ref)
	return nil
}

type savedFixture struct {
	calls  []string
	follow *mock_agent_session_repo.MockSaveRepo
	todo   *mock_agent_session_repo.MockDeleteTodoRepo
	device *mock_device_repo.MockDeviceRepo
	mirror *stubMirror
	peer   *stubPeer
	svc    *savedSessionSvc
}

func setupSavedSessionTest(t *testing.T) *savedFixture {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	f := &savedFixture{
		follow: mock_agent_session_repo.NewMockSaveRepo(ctrl),
		todo:   mock_agent_session_repo.NewMockDeleteTodoRepo(ctrl),
		device: mock_device_repo.NewMockDeviceRepo(ctrl),
	}
	f.mirror = &stubMirror{calls: &f.calls}
	f.peer = &stubPeer{calls: &f.calls}
	// 删除路径先按身份查出承载它的机器（调用方可能只知道身份）。这是一次读，
	// 各条用例量的都不是它，所以在这里一次给足：交回一条「发起端就是这台机器
	// 自己」的记录，也就是桌面端那一档。
	f.follow.EXPECT().
		FindByIdentity(gomock.Any(), int64(7), conversationA).
		Return(&agent_session_entity.SessionSave{
			UserID: 7, ConversationID: conversationA,
			DeviceFingerprint: "fp-desktop-1", PeerFingerprint: "fp-desktop-1",
		}, nil).
		AnyTimes()
	agent_session_repo.RegisterSave(f.follow)
	agent_session_repo.RegisterDeleteTodo(f.todo)
	device_repo.RegisterDevice(f.device)
	SetSessionMirror(f.mirror)
	SetMachineSessionDeleter(f.peer)
	t.Cleanup(func() {
		SetSessionMirror(nil)
		SetMachineSessionDeleter(nil)
	})
	f.svc = newSavedSessionSvc()
	return f
}

func ref7() SessionRef {
	return SessionRef{UserID: 7, MachineFingerprint: "fp-desktop-1", ConversationID: conversationA}
}

// 保存：一条还没在账号里的对话进入账号，镜像随即对它开始（规格「保存与删除」）。
// 顺序是有意的——先进名单再开镜像：范围就是隐私开关（决策 2），内容绝不能先于
// 「用户保存过它」这件事落库。
func TestSave_EntersAccountThenMirroringBegins(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.follow.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, e *agent_session_entity.SessionSave) error {
			f.calls = append(f.calls, "account:add")
			assert.Equal(t, int64(7), e.UserID)
			assert.Equal(t, "fp-desktop-1", e.DeviceFingerprint)
			assert.Equal(t, conversationA, e.ConversationID)
			assert.Positive(t, e.FollowedAt)
			return nil
		},
	)

	require.NoError(t, f.svc.Save(context.Background(), ref7()))
	assert.Equal(t, []SessionRef{ref7()}, f.mirror.begun)
	assert.Equal(t, []string{"account:add", "mirror:begin"}, f.calls)
}

// 保存时镜像开不起来：如实报错，不能对调用方声称「已经在存了」。名单那一条留着，
// 后续的巡检会替它接上。
func TestSave_MirrorRefusesToStart_SurfacesError(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.mirror.beginErr = errors.New("relay unavailable")
	f.follow.EXPECT().Save(gomock.Any(), gomock.Any()).Return(nil)

	require.Error(t, f.svc.Save(context.Background(), ref7()))
}

// Given 一条 web 控制台派发出去的对话：身份的发起端那一半是**浏览器**，承载它的是
// agentred 那台机器；调用方（索引里的一行）手上只有身份，它压根不认识那台机器；
// When 删除；Then 服务端自己按身份查出承载它的机器，据它去通知执行端。
//
// 不查的话，「去哪台机器补删」就只能沿用调用方给的值 —— 那是一个浏览器指纹，
// 拨过去必然失败，执行端上那一份于是永远留着。
func TestDelete_WebDispatchedConversation_ResolvesItsMachineFromTheAccount(t *testing.T) {
	const browser = "991b9464868dfb6340bd09eeef14f196"
	f := setupSavedSessionTest(t)
	f.follow.EXPECT().
		FindByIdentity(gomock.Any(), int64(7), conversationB).
		Return(&agent_session_entity.SessionSave{
			UserID: 7, ConversationID: conversationB,
			DeviceFingerprint: "fp-agentred-1", PeerFingerprint: browser,
		}, nil)
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationB).Return(nil)
	// 发起端是浏览器：不是已登记的桌面，不通知。
	f.device.EXPECT().FindByFingerprint(gomock.Any(), int64(7), browser).Return(nil, nil)

	outcome, err := f.svc.Delete(context.Background(), SessionRef{
		UserID: 7, ConversationID: conversationB,
	})

	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome)
	require.Len(t, f.peer.deleted, 1)
	assert.Equal(t, "fp-agentred-1", f.peer.deleted[0].MachineFingerprint,
		"通知执行端要拨的是承载它的机器，不是发起它的浏览器")
	require.Len(t, f.mirror.purged, 1)
	assert.Equal(t, conversationB, f.mirror.purged[0].ConversationID,
		"清镜像内容按的是 conversation_id —— 四张表就是照它存的")
	assert.Equal(t, "fp-agentred-1", f.mirror.purged[0].MachineFingerprint,
		"摘连接要认得承载它的那台机器，而那是服务端自己查出来的")
}

// 删除 + 机器在线：server 那份与执行端那份一起没了，不留待办。
func TestDelete_PeerOnline_BothCopiesGone(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationA).DoAndReturn(
		func(_ context.Context, _ int64, _ string) error {
			f.calls = append(f.calls, "account:remove")
			return nil
		},
	)

	outcome, err := f.svc.Delete(context.Background(), ref7())
	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome)
	assert.Equal(t, []SessionRef{ref7()}, f.mirror.purged)
	assert.Equal(t, []SessionRef{ref7()}, f.peer.deleted)
	// 内容先清、名单后撤：反过来一旦清理失败，库里就会留下一条「没人保存过」的
	// 对话的转录——决策 2 的隐私边界正是破在这里。执行端最后说，它答什么都不
	// 改变 server 这边已经删干净的事实。
	assert.Equal(t, []string{"mirror:purge", "account:remove", "peer:delete:fp-desktop-1"}, f.calls)
	// 不留待办：这一份已经删掉了，没有什么要等那台机器回来做。
}

// 删除 + 机器离线：server 那份**当场**清掉（索引里立刻消失，没有「已删除但还在」
// 的中间态），那台机器记一条待办，它下次上线时补删（决策 6）。
func TestDelete_PeerOffline_ServerCopyGoneNowAndTodoRecorded(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.peer.err = ErrMachineOffline
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationA).DoAndReturn(
		func(_ context.Context, _ int64, _ string) error {
			f.calls = append(f.calls, "account:remove")
			return nil
		},
	)
	f.todo.EXPECT().AddDeleteTodo(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, todo *agent_session_entity.DeleteTodo) error {
			f.calls = append(f.calls, "todo:add")
			assert.Equal(t, int64(7), todo.UserID)
			assert.Equal(t, conversationA, todo.ConversationID)
			assert.Equal(t, "fp-desktop-1", todo.DeviceFingerprint)
			assert.Positive(t, todo.Createtime)
			return nil
		},
	)

	outcome, err := f.svc.Delete(context.Background(), ref7())
	require.NoError(t, err)
	assert.Equal(t, MachineDeletePending, outcome)
	assert.Equal(t, []SessionRef{ref7()}, f.mirror.purged)
	assert.Empty(t, f.peer.deleted)
	assert.Equal(t, []string{"mirror:purge", "account:remove", "peer:delete:fp-desktop-1", "todo:add"}, f.calls)
}

// 执行端太老、这辈子都不认识 runtime.session.delete（RPC method-not-found -32601）：如实降级
// 成 unsupported，**不留待办**——留下就是对着一台永远答不了的机器重放到天荒地老。
func TestDelete_PeerProtocolViolation_ReturnsErrorWithoutTodo(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.peer.err = ErrMachineProtocolViolation
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationA).Return(nil)

	outcome, err := f.svc.Delete(context.Background(), ref7())
	require.ErrorIs(t, err, ErrMachineProtocolViolation)
	assert.Empty(t, outcome)
	// server 那份照样删干净了；没有 AddDeleteTodo（mock 未登记该调用，一旦调用即红）。
	assert.Equal(t, []SessionRef{ref7()}, f.mirror.purged)
}

// 执行端这一次没删成（在线但报错）：与「太老」分开——等它下次回来再删一遍就成了，
// 因此照样留待办。
func TestDelete_PeerFailedThisTime_LeavesTodo(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.peer.err = errors.New("write to relay failed")
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationA).Return(nil)
	f.todo.EXPECT().AddDeleteTodo(gomock.Any(), gomock.Any()).Return(nil)

	outcome, err := f.svc.Delete(context.Background(), ref7())
	require.NoError(t, err)
	assert.Equal(t, MachineDeletePending, outcome)
}

// 待办没记下来：删除没走完就得如实报错——不然执行端那一份会被静默地永远留着。
// 重试是安全的（两边都幂等）。
func TestDelete_TodoNotRecorded_ReportsError(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.peer.err = ErrMachineOffline
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationA).Return(nil)
	f.todo.EXPECT().AddDeleteTodo(gomock.Any(), gomock.Any()).Return(errors.New("db down"))

	_, err := f.svc.Delete(context.Background(), ref7())
	require.Error(t, err)
}

// 删两次不是错误：第二次时 server 那份早已没了、执行端也早已没了，两边都是 no-op，
// 照样回成功（幂等，与 wire 的 SessionDeleteResult.Deleted 是后置条件同一口径）。
func TestDelete_Twice_IsNotAnError(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationA).Return(nil).Times(2)

	outcome, err := f.svc.Delete(context.Background(), ref7())
	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome)

	outcome, err = f.svc.Delete(context.Background(), ref7())
	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome)
}

// server 那份没清掉：删除到此为止并如实报错——名单那一条留着（不然库里会剩下一条
// 无人认领的对话内容），也不去动执行端那一份。
func TestDelete_ServerCopyNotPurged_StopsAndReports(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.mirror.purgeErr = errors.New("db down")
	// 名单不撤、执行端不通知、待办不记：三个 mock / 桩都未登记这些调用。

	_, err := f.svc.Delete(context.Background(), ref7())
	require.Error(t, err)
	assert.Equal(t, []string{"mirror:purge"}, f.calls)
	assert.Empty(t, f.peer.deleted)
}

// ---- 任务 9：发起端桌面也要收到删除；调用方自己不回头通知 ----

// expectRow 让 conversationB 的名单行是：执行端 agentred、发起端 initiator。
func expectRowB(f *savedFixture, initiator string) {
	f.follow.EXPECT().FindByIdentity(gomock.Any(), int64(7), conversationB).Return(
		&agent_session_entity.SessionSave{
			UserID: 7, ConversationID: conversationB,
			DeviceFingerprint: "fp-agentred-1", PeerFingerprint: initiator,
		}, nil)
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationB).Return(nil)
}

func expectDevice(f *savedFixture, fp, kind string, status int) {
	f.device.EXPECT().FindByFingerprint(gomock.Any(), int64(7), fp).Return(
		&device_entity.Device{ID: 2, UserID: 7, Fingerprint: fp, Kind: kind, Status: status}, nil)
}

func refB() SessionRef { return SessionRef{UserID: 7, ConversationID: conversationB} }

func TestDelete_InitiatorDesktop_AlsoNotifiedAfterCarrier(t *testing.T) {
	f := setupSavedSessionTest(t)
	expectRowB(f, "fp-desktop-2")
	expectDevice(f, "fp-desktop-2", device_entity.KindDesktop, 1)

	outcome, err := f.svc.Delete(context.Background(), refB())
	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome)
	assert.Equal(t, []string{"mirror:purge", "peer:delete:fp-agentred-1", "peer:delete:fp-desktop-2"}, f.calls)
}

func TestDelete_InitiatorDesktopOffline_TodoForThatMachineOnly_ResponseDescribesCarrier(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.peer.errByFP = map[string]error{"fp-desktop-2": ErrMachineOffline}
	expectRowB(f, "fp-desktop-2")
	expectDevice(f, "fp-desktop-2", device_entity.KindDesktop, 1)
	f.todo.EXPECT().AddDeleteTodo(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, todo *agent_session_entity.DeleteTodo) error {
			assert.Equal(t, "fp-desktop-2", todo.DeviceFingerprint)
			assert.Equal(t, conversationB, todo.ConversationID)
			return nil
		})

	outcome, err := f.svc.Delete(context.Background(), refB())
	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome, "应答只说承载端那一份")
}

func TestDelete_InitiatorTodoNotRecorded_ReportsError(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.peer.errByFP = map[string]error{"fp-desktop-2": ErrMachineOffline}
	expectRowB(f, "fp-desktop-2")
	expectDevice(f, "fp-desktop-2", device_entity.KindDesktop, 1)
	f.todo.EXPECT().AddDeleteTodo(gomock.Any(), gomock.Any()).Return(errors.New("db down"))

	_, err := f.svc.Delete(context.Background(), refB())
	require.Error(t, err)
}

func TestDelete_InitiatorNotADesktop_SkippedSilently(t *testing.T) {
	cases := map[string]func(f *savedFixture){
		"browser peer (web device)": func(f *savedFixture) { expectDevice(f, "fp-browser", device_entity.KindWeb, 1) },
		"agentred":                  func(f *savedFixture) { expectDevice(f, "fp-browser", device_entity.KindAgentred, 1) },
		"not a registered device": func(f *savedFixture) {
			f.device.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-browser").Return(nil, nil)
		},
		"removed device": func(f *savedFixture) { expectDevice(f, "fp-browser", device_entity.KindDesktop, 0) },
	}
	for name, arrange := range cases {
		t.Run(name, func(t *testing.T) {
			f := setupSavedSessionTest(t)
			expectRowB(f, "fp-browser")
			arrange(f)
			outcome, err := f.svc.Delete(context.Background(), refB())
			require.NoError(t, err)
			assert.Equal(t, MachineDeleted, outcome)
			assert.Equal(t, []string{"mirror:purge", "peer:delete:fp-agentred-1"}, f.calls)
		})
	}
}

func TestDelete_CallerIsInitiator_NotNotifiedBack(t *testing.T) {
	f := setupSavedSessionTest(t)
	expectRowB(f, "fp-desktop-2")
	f.device.EXPECT().Find(gomock.Any(), int64(2)).Return(
		&device_entity.Device{ID: 2, UserID: 7, Fingerprint: "fp-desktop-2", Kind: device_entity.KindDesktop, Status: 1}, nil)

	ref := refB()
	ref.CallerDeviceID = 2
	outcome, err := f.svc.Delete(context.Background(), ref)
	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome)
	assert.Equal(t, []string{"mirror:purge", "peer:delete:fp-agentred-1"}, f.calls)
}

func TestDelete_CallerIsCarrier_NotNotifiedBackAndOutcomeDeleted(t *testing.T) {
	f := setupSavedSessionTest(t) // 默认名单行：承载端 = 发起端 = fp-desktop-1
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationA).Return(nil)
	f.device.EXPECT().Find(gomock.Any(), int64(1)).Return(
		&device_entity.Device{ID: 1, UserID: 7, Fingerprint: "fp-desktop-1", Kind: device_entity.KindDesktop, Status: 1}, nil)

	ref := ref7()
	ref.CallerDeviceID = 1
	outcome, err := f.svc.Delete(context.Background(), ref)
	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome)
	assert.Equal(t, []string{"mirror:purge"}, f.calls)
}

func noRowB(f *savedFixture) {
	f.follow.EXPECT().FindByIdentity(gomock.Any(), int64(7), conversationB).Return(nil, nil)
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), conversationB).Return(nil)
}

func TestDelete_NoRow_MachineFingerprintOfOwnDeviceIsTheCarrier(t *testing.T) {
	f := setupSavedSessionTest(t)
	noRowB(f)
	expectDevice(f, "fp-agentred-1", device_entity.KindAgentred, 1)

	ref := refB()
	ref.MachineFingerprint = "fp-agentred-1"
	outcome, err := f.svc.Delete(context.Background(), ref)
	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome)
	assert.Equal(t, []string{"mirror:purge", "peer:delete:fp-agentred-1"}, f.calls)
}

func TestDelete_NoRow_MachineFingerprintNotInAccountIsIgnored(t *testing.T) {
	f := setupSavedSessionTest(t)
	noRowB(f)
	f.device.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-someone-else").Return(nil, nil)

	ref := refB()
	ref.MachineFingerprint = "fp-someone-else"
	_, err := f.svc.Delete(context.Background(), ref)
	require.NoError(t, err)
	for _, c := range f.calls {
		assert.NotContains(t, c, "fp-someone-else", "别的账号的机器不能被这条请求点到")
	}
}

// 决策 17：没有名单行、也没有可用的执行端指纹时，没有任何一台机器是已知的承载端。
// 调用方设备（它已经删了自己那份）顶上；连设备调用方都没有（浏览器、未知 / 已移除
// 的指纹）就没有人可通知。三种都答「已删除」，不拨号、不记待办——空指纹的待办
// 重放 cron 永远清不掉。对端设成离线，是为了让误拨 / 误记待办立刻在这里暴露。
func assertDeletedWithoutCarrier(t *testing.T, f *savedFixture, ref SessionRef) {
	t.Helper()
	f.peer.err = ErrMachineOffline // 误拨就会走到 AddDeleteTodo，而 todo mock 没有任何预期
	outcome, err := f.svc.Delete(context.Background(), ref)
	require.NoError(t, err)
	assert.Equal(t, MachineDeleted, outcome)
	assert.Equal(t, []string{"mirror:purge"}, f.calls, "不拨任何机器")
	assert.Empty(t, f.peer.deleted)
}

func TestDelete_NoRow_DeviceCaller_IsTheCarrier_NoDialNoTodo(t *testing.T) {
	f := setupSavedSessionTest(t)
	noRowB(f)
	f.device.EXPECT().Find(gomock.Any(), int64(1)).Return(
		&device_entity.Device{ID: 1, UserID: 7, Fingerprint: "fp-desktop-1", Kind: device_entity.KindDesktop, Status: 1}, nil)

	ref := refB()
	ref.CallerDeviceID = 1
	assertDeletedWithoutCarrier(t, f, ref)
}

func TestDelete_NoRow_UnknownHint_NoDialNoTodo(t *testing.T) {
	f := setupSavedSessionTest(t)
	noRowB(f)
	f.device.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-someone-else").Return(nil, nil)

	ref := refB()
	ref.MachineFingerprint = "fp-someone-else"
	assertDeletedWithoutCarrier(t, f, ref)
}

func TestDelete_NoRow_RemovedHint_NoDialNoTodo(t *testing.T) {
	f := setupSavedSessionTest(t)
	noRowB(f)
	expectDevice(f, "fp-removed", device_entity.KindAgentred, 0)

	ref := refB()
	ref.MachineFingerprint = "fp-removed"
	assertDeletedWithoutCarrier(t, f, ref)
}

func TestDelete_NoRow_BrowserCallerNoDevice_NoDialNoTodo(t *testing.T) {
	f := setupSavedSessionTest(t)
	noRowB(f)

	assertDeletedWithoutCarrier(t, f, refB())
}

// 有名单行时的老行为不变：承载端离线仍记它的待办（指纹非空）。
func TestDelete_RowWithCarrier_Offline_StillQueuesTodoForCarrier(t *testing.T) {
	f := setupSavedSessionTest(t)
	f.peer.err = ErrMachineOffline
	expectRowB(f, "fp-agentred-1")
	f.todo.EXPECT().AddDeleteTodo(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, td *agent_session_entity.DeleteTodo) error {
			assert.Equal(t, "fp-agentred-1", td.DeviceFingerprint)
			return nil
		})

	outcome, err := f.svc.Delete(context.Background(), refB())
	require.NoError(t, err)
	assert.Equal(t, MachineDeletePending, outcome)
}

func TestDelete_RowExists_MachineFingerprintHintIsNotConsulted(t *testing.T) {
	f := setupSavedSessionTest(t)
	expectRowB(f, "fp-agentred-1") // 发起端 = 承载端；没有 FindByFingerprint 的预期，一调用即红

	ref := refB()
	ref.MachineFingerprint = "fp-hint"
	_, err := f.svc.Delete(context.Background(), ref)
	require.NoError(t, err)
	assert.Equal(t, []string{"mirror:purge", "peer:delete:fp-agentred-1"}, f.calls)
}
