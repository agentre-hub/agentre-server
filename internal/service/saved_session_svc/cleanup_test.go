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
)

const (
	cvOld1    = "00000000-0000-7000-8000-000000000001"
	cvOld2    = "00000000-0000-7000-8000-000000000002"
	cvRunning = "00000000-0000-7000-8000-000000000003"
	cvWaiting = "00000000-0000-7000-8000-000000000004"
	cvGone    = "00000000-0000-7000-8000-000000000005"
	cvRemoved = "00000000-0000-7000-8000-000000000006"
)

type cleanupFixture struct {
	*savedFixture
	summary *mock_agent_session_repo.MockCleanupRepo
	online  map[string]bool
	members map[string]bool
}

func setupCleanupTest(t *testing.T) *cleanupFixture {
	t.Helper()
	f := &cleanupFixture{savedFixture: setupSavedSessionTest(t), online: map[string]bool{}}
	ctrl := gomock.NewController(t)
	f.summary = mock_agent_session_repo.NewMockCleanupRepo(ctrl)
	agent_session_repo.RegisterCleanup(f.summary)
	prevProbe, prevMembers := presenceProbe, projectMembers
	presenceProbe = func(_ context.Context, _ int64, fps []string) ([]bool, error) {
		out := make([]bool, len(fps))
		for i, fp := range fps {
			out[i] = f.online[fp]
		}
		return out, nil
	}
	projectMembers = func(_ context.Context, _ int64, _ string) (map[string]bool, error) {
		return f.members, nil
	}
	t.Cleanup(func() { presenceProbe, projectMembers = prevProbe, prevMembers })
	// 账号里的在用设备：桌面一台、agentred 一台；fp-removed 已不在账号里。
	f.device.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*device_entity.Device{
		{ID: 1, UserID: 7, Fingerprint: "fp-desktop-1", Name: "MacBook", Kind: device_entity.KindDesktop, Status: 1},
		{ID: 2, UserID: 7, Fingerprint: "fp-agentred-1", Name: "host", DisplayName: "build box", Kind: device_entity.KindAgentred, Status: 1},
	}, nil).AnyTimes()
	return f
}

func sum(id, machine, lifecycle string, waiting bool) *agent_session_entity.SessionSummary {
	return &agent_session_entity.SessionSummary{
		UserID: 7, ConversationID: id, MachineFingerprint: machine,
		LifecycleState: lifecycle, WaitingForInput: waiting,
	}
}

// 预览：时间 / Agent 判据原样交给仓储；进行中与等待中的不进清单，计入 retained；
// 逐机器计数带名字（备注名优先）与在线态；已不在账号里的机器不出现在分解里，
// 但它名下的对话照样计入总数。
func TestPreviewCleanup_ExcludesRunningAndWaiting_CountsPerMachineWithOnline(t *testing.T) {
	f := setupCleanupTest(t)
	f.online["fp-agentred-1"] = true
	f.summary.EXPECT().ListCleanupCandidates(gomock.Any(), agent_session_repo.CleanupCandidateQuery{
		UserID: 7, BeforeMs: 5000, AgentSyncID: "agent-1",
	}).Return([]*agent_session_entity.SessionSummary{
		sum(cvOld1, "fp-agentred-1", "idle", false),
		sum(cvOld2, "fp-agentred-1", "failed", false),
		sum(cvRunning, "fp-agentred-1", "running", false),
		sum(cvWaiting, "fp-desktop-1", "idle", true),
		sum(cvRemoved, "fp-removed", "idle", false),
	}, nil)

	got, err := f.svc.PreviewCleanup(context.Background(), 7, CleanupFilter{BeforeMs: 5000, AgentSyncID: "agent-1"})

	require.NoError(t, err)
	assert.Equal(t, 3, got.Count)
	assert.Equal(t, 2, got.Retained)
	assert.ElementsMatch(t, []string{cvOld1, cvOld2, cvRemoved}, got.ConversationIDs)
	assert.Equal(t, []CleanupMachine{
		{Fingerprint: "fp-agentred-1", Name: "build box", Online: true, Count: 2},
	}, got.Machines, "已移除的机器不单列；离线与在线各自如实")
}

func TestPreviewCleanup_OfflineMachineReportedOffline(t *testing.T) {
	f := setupCleanupTest(t)
	f.summary.EXPECT().ListCleanupCandidates(gomock.Any(), gomock.Any()).Return(
		[]*agent_session_entity.SessionSummary{sum(cvOld1, "fp-desktop-1", "idle", false)}, nil)

	got, err := f.svc.PreviewCleanup(context.Background(), 7, CleanupFilter{})

	require.NoError(t, err)
	assert.Equal(t, []CleanupMachine{{Fingerprint: "fp-desktop-1", Name: "MacBook", Online: false, Count: 1}}, got.Machines)
}

// 项目判据：只留项目归属里的对话。没在项目里的既不计数也不算 retained。
func TestPreviewCleanup_ProjectFilter_KeepsOnlyMembers(t *testing.T) {
	f := setupCleanupTest(t)
	f.members = map[string]bool{cvOld1: true, cvRunning: true}
	f.summary.EXPECT().ListCleanupCandidates(gomock.Any(), agent_session_repo.CleanupCandidateQuery{UserID: 7}).Return(
		[]*agent_session_entity.SessionSummary{
			sum(cvOld1, "fp-desktop-1", "idle", false),
			sum(cvOld2, "fp-desktop-1", "idle", false),
			sum(cvRunning, "fp-desktop-1", "running", false),
		}, nil)

	got, err := f.svc.PreviewCleanup(context.Background(), 7, CleanupFilter{ProjectSyncID: "proj-1"})

	require.NoError(t, err)
	assert.Equal(t, []string{cvOld1}, got.ConversationIDs)
	assert.Equal(t, 1, got.Count)
	assert.Equal(t, 1, got.Retained)
}

func TestPreviewCleanup_RepoError_Surfaces(t *testing.T) {
	f := setupCleanupTest(t)
	f.summary.EXPECT().ListCleanupCandidates(gomock.Any(), gomock.Any()).Return(nil, errors.New("db down"))
	_, err := f.svc.PreviewCleanup(context.Background(), 7, CleanupFilter{})
	require.Error(t, err)
}

// 在线态读不出来不挡预览：那一栏如实答离线，数量照给。
func TestPreviewCleanup_PresenceFails_MachinesOfflineAndNoError(t *testing.T) {
	f := setupCleanupTest(t)
	presenceProbe = func(context.Context, int64, []string) ([]bool, error) {
		return []bool{true}, errors.New("redis down")
	}
	f.summary.EXPECT().ListCleanupCandidates(gomock.Any(), gomock.Any()).Return(
		[]*agent_session_entity.SessionSummary{sum(cvOld1, "fp-desktop-1", "idle", false)}, nil)

	got, err := f.svc.PreviewCleanup(context.Background(), 7, CleanupFilter{})

	require.NoError(t, err)
	require.Len(t, got.Machines, 1)
	assert.False(t, got.Machines[0].Online)
}

func expectDeletableRow(f *cleanupFixture, id, machine string) {
	f.follow.EXPECT().FindByIdentity(gomock.Any(), int64(7), id).Return(
		&agent_session_entity.SessionSave{UserID: 7, ConversationID: id, DeviceFingerprint: machine, PeerFingerprint: machine}, nil)
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), id).Return(nil)
}

// 执行：逐条重新判断。现在进行中 / 等待中的保留（retained）；已不在名单里的跳过；
// 其余经 Delete 删除——执行端那份在线就一并删，离线则记入 pending（按机器汇总）。
// 一条失败不拖累其余，并给出原因码。
func TestCleanup_RechecksEachAndDeletesThroughDelete(t *testing.T) {
	f := setupCleanupTest(t)
	f.peer.errByFP = map[string]error{"fp-agentred-1": ErrMachineOffline}
	f.summary.EXPECT().ListSavedByConversationIDs(gomock.Any(), int64(7),
		[]string{cvOld1, cvRunning, cvWaiting, cvGone, cvOld2}).Return(
		[]*agent_session_entity.SessionSummary{
			sum(cvOld1, "fp-desktop-1", "idle", false),
			sum(cvRunning, "fp-desktop-1", "running", false),
			sum(cvWaiting, "fp-desktop-1", "idle", true),
			sum(cvOld2, "fp-agentred-1", "idle", false),
		}, nil)
	expectDeletableRow(f, cvOld1, "fp-desktop-1")
	expectDeletableRow(f, cvOld2, "fp-agentred-1")
	f.todo.EXPECT().AddDeleteTodo(gomock.Any(), gomock.Any()).Return(nil)

	got, err := f.svc.Cleanup(context.Background(), 7, 0,
		[]string{cvOld1, cvRunning, cvWaiting, cvGone, cvOld1, cvOld2})

	require.NoError(t, err)
	assert.Equal(t, 2, got.Deleted)
	assert.Equal(t, 2, got.Retained)
	assert.Empty(t, got.Failed)
	assert.Equal(t, []CleanupPendingMachine{{Fingerprint: "fp-agentred-1", Name: "build box", Count: 1}}, got.Pending)
	var purged []string
	for _, p := range f.mirror.purged {
		purged = append(purged, p.ConversationID)
	}
	assert.ElementsMatch(t, []string{cvOld1, cvOld2}, purged, "进行中 / 等待中 / 已不在名单的一条都没碰")
}

func TestCleanup_OneFailureDoesNotStopTheRest(t *testing.T) {
	f := setupCleanupTest(t)
	f.mirror.purgeErr = nil
	f.peer.errByFP = map[string]error{"fp-agentred-1": ErrMachineProtocolViolation}
	f.summary.EXPECT().ListSavedByConversationIDs(gomock.Any(), int64(7), []string{cvOld2, cvOld1}).Return(
		[]*agent_session_entity.SessionSummary{
			sum(cvOld2, "fp-agentred-1", "idle", false),
			sum(cvOld1, "fp-desktop-1", "idle", false),
		}, nil)
	expectDeletableRow(f, cvOld2, "fp-agentred-1")
	expectDeletableRow(f, cvOld1, "fp-desktop-1")

	got, err := f.svc.Cleanup(context.Background(), 7, 0, []string{cvOld2, cvOld1})

	require.NoError(t, err)
	assert.Equal(t, 1, got.Deleted)
	assert.Equal(t, []CleanupFailure{{ConversationID: cvOld2, Reason: CleanupReasonMachineProtocol}}, got.Failed)
}

func TestCleanup_DeleteInternalError_ReasonIsGeneric(t *testing.T) {
	f := setupCleanupTest(t)
	f.summary.EXPECT().ListSavedByConversationIDs(gomock.Any(), int64(7), []string{cvOld1}).Return(
		[]*agent_session_entity.SessionSummary{sum(cvOld1, "fp-desktop-1", "idle", false)}, nil)
	f.follow.EXPECT().FindByIdentity(gomock.Any(), int64(7), cvOld1).Return(nil, errors.New("db down"))

	got, err := f.svc.Cleanup(context.Background(), 7, 0, []string{cvOld1})

	require.NoError(t, err)
	assert.Equal(t, []CleanupFailure{{ConversationID: cvOld1, Reason: CleanupReasonInternal}}, got.Failed)
	assert.Zero(t, got.Deleted)
}

// 发起清理的设备（设备 JWT 调用）一并交给 Delete，好让它不被回头通知。
func TestCleanup_PassesCallerDeviceToDelete(t *testing.T) {
	f := setupCleanupTest(t)
	f.summary.EXPECT().ListSavedByConversationIDs(gomock.Any(), int64(7), []string{cvOld1}).Return(
		[]*agent_session_entity.SessionSummary{sum(cvOld1, "fp-desktop-1", "idle", false)}, nil)
	expectDeletableRow(f, cvOld1, "fp-desktop-1")
	f.device.EXPECT().Find(gomock.Any(), int64(1)).Return(
		&device_entity.Device{ID: 1, UserID: 7, Fingerprint: "fp-desktop-1"}, nil)

	got, err := f.svc.Cleanup(context.Background(), 7, 1, []string{cvOld1})

	require.NoError(t, err)
	assert.Equal(t, 1, got.Deleted)
	assert.Empty(t, f.peer.deleted, "调用方就是承载端：它本机已删，不回头通知")
}

func TestCleanup_RecheckReadFails_ReturnsError(t *testing.T) {
	f := setupCleanupTest(t)
	f.summary.EXPECT().ListSavedByConversationIDs(gomock.Any(), int64(7), gomock.Any()).Return(nil, errors.New("db down"))
	_, err := f.svc.Cleanup(context.Background(), 7, 0, []string{cvOld1})
	require.Error(t, err)
}

// 发起端是账号里另一台桌面时，控制台删除也要让它删掉本机那份（「从控制台删」），所以它
// 同样是「涉及的机器」：预览按它名下的对话单列一行（在线态如实）。发起端不是本账号的
// 桌面（浏览器等）、或就是承载端时，不多出一行；保留下来的对话不计入任何机器。
func TestPreviewCleanup_InitiatorDesktopListedAsInvolvedMachine(t *testing.T) {
	f := setupCleanupTest(t)
	f.online["fp-agentred-1"] = true
	withPeer := func(s *agent_session_entity.SessionSummary, peer string) *agent_session_entity.SessionSummary {
		s.PeerFingerprint = peer
		return s
	}
	f.summary.EXPECT().ListCleanupCandidates(gomock.Any(), gomock.Any()).Return(
		[]*agent_session_entity.SessionSummary{
			withPeer(sum(cvOld1, "fp-agentred-1", "idle", false), "fp-desktop-1"),
			withPeer(sum(cvOld2, "fp-agentred-1", "idle", false), "fp-browser"),
			withPeer(sum(cvRunning, "fp-agentred-1", "running", false), "fp-desktop-1"),
			withPeer(sum(cvGone, "fp-desktop-1", "idle", false), "fp-desktop-1"),
		}, nil)

	got, err := f.svc.PreviewCleanup(context.Background(), 7, CleanupFilter{})

	require.NoError(t, err)
	assert.Equal(t, 3, got.Count)
	assert.Equal(t, []CleanupMachine{
		{Fingerprint: "fp-agentred-1", Name: "build box", Online: true, Count: 2},
		{Fingerprint: "fp-desktop-1", Name: "MacBook", Online: false, Count: 2},
	}, got.Machines)
}

// 执行时发起端桌面离线：server 给它记了待办，结果里它和承载端一样列为「下次上线时删除」。
func TestCleanup_InitiatorDesktopOffline_ReportedPending(t *testing.T) {
	f := setupCleanupTest(t)
	f.peer.errByFP = map[string]error{"fp-desktop-1": ErrMachineOffline}
	f.summary.EXPECT().ListSavedByConversationIDs(gomock.Any(), int64(7), []string{cvOld1}).Return(
		[]*agent_session_entity.SessionSummary{sum(cvOld1, "fp-agentred-1", "idle", false)}, nil)
	f.follow.EXPECT().FindByIdentity(gomock.Any(), int64(7), cvOld1).Return(
		&agent_session_entity.SessionSave{UserID: 7, ConversationID: cvOld1,
			DeviceFingerprint: "fp-agentred-1", PeerFingerprint: "fp-desktop-1"}, nil)
	f.follow.EXPECT().Delete(gomock.Any(), int64(7), cvOld1).Return(nil)
	f.device.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-desktop-1").Return(
		&device_entity.Device{ID: 1, UserID: 7, Fingerprint: "fp-desktop-1", Kind: device_entity.KindDesktop, Status: 1}, nil)
	f.todo.EXPECT().AddDeleteTodo(gomock.Any(), gomock.Any()).Return(nil)

	got, err := f.svc.Cleanup(context.Background(), 7, 0, []string{cvOld1})

	require.NoError(t, err)
	assert.Equal(t, 1, got.Deleted)
	assert.Equal(t, []CleanupPendingMachine{{Fingerprint: "fp-desktop-1", Name: "MacBook", Count: 1}}, got.Pending)
}
