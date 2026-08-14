package workspace_svc

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/exec_order_entity"
	"agentre-server/internal/model/entity/sync_entity"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
	"agentre-server/internal/repository/exec_order_repo"
	"agentre-server/internal/repository/exec_order_repo/mock_exec_order_repo"
	"agentre-server/internal/repository/sync_repo"
	"agentre-server/internal/repository/sync_repo/mock_sync_repo"
)

// fakeOnlineChecker 让测试按指纹摆布在线态，不用起真的 relay_svc / redis。
type fakeOnlineChecker struct {
	online map[string]bool
}

func (f fakeOnlineChecker) IsDaemonOnline(_ context.Context, _ int64, fingerprint string) (bool, error) {
	return f.online[fingerprint], nil
}

func setupWorkspaceTest(t *testing.T) (
	context.Context, *mock_sync_repo.MockSyncObjectRepo, *mock_sync_repo.MockSyncLocalPathRepo,
	*mock_device_repo.MockDeviceRepo, WorkspaceSvc,
) {
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	mObj := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	mPath := mock_sync_repo.NewMockSyncLocalPathRepo(ctrl)
	mDev := mock_device_repo.NewMockDeviceRepo(ctrl)
	sync_repo.RegisterSyncObject(mObj)
	sync_repo.RegisterSyncLocalPath(mPath)
	device_repo.RegisterDevice(mDev)
	t.Cleanup(func() { SetOnlineChecker(nil) })
	return context.Background(), mObj, mPath, mDev, New()
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}

// 一个 Agent、三档执行目标：本机相对引用（web 派发按 R15d 跳过）→ 离线的 agentred
// → 在线的 agentred。要求顺序原样保留、离线档标不可用、第三档被选为「当前生效」。
func TestListAccountAgents_GivenOrderedTargets_ThenFirstAvailableNonLocalIsCurrent(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-online": true, "fp-offline": false}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1",
			Payload: mustJSON(t, map[string]any{"name": "前端 Agent", "avatar_color": "#3B6896", "department_sync_id": "dept-1"})},
		{Kind: sync_entity.KindDepartment, SyncID: "dept-1", Payload: mustJSON(t, map[string]any{"name": "工程"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-local", AgentredFingerprint: "",
			Payload: mustJSON(t, map[string]any{"type": "claude_code", "cli_path": "/usr/local/bin/claude"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-offline", AgentredFingerprint: "fp-offline",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-online", AgentredFingerprint: "fp-online",
			Payload: mustJSON(t, map[string]any{"type": "codex", "env_json": `{"SECRET":"x"}`})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "backend-local", "sort_order": 0})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t2",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "backend-offline", "sort_order": 1})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t3",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "backend-online", "sort_order": 2})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-offline", Status: 1},
		{ID: 21, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-online", Status: 1},
	}, nil)

	got, err := svc.ListAccountAgents(ctx, 7, "")
	require.NoError(t, err)
	require.Len(t, got, 1)
	agent := got[0]
	assert.Equal(t, "前端 Agent", agent.Name)
	assert.Equal(t, "工程", agent.DepartmentName)
	require.Len(t, agent.ExecTargets, 3)

	assert.True(t, agent.ExecTargets[0].IsLocalReference)
	assert.Equal(t, AvailabilitySkippedForWeb, agent.ExecTargets[0].Availability)
	assert.False(t, agent.ExecTargets[0].Current)

	assert.Equal(t, "书房小主机", agent.ExecTargets[1].DeviceName)
	assert.Equal(t, AvailabilityOffline, agent.ExecTargets[1].Availability)
	assert.False(t, agent.ExecTargets[1].Current)

	assert.Equal(t, "公司 Mac mini", agent.ExecTargets[2].DeviceName)
	assert.Equal(t, AvailabilityAvailable, agent.ExecTargets[2].Availability)
	assert.True(t, agent.ExecTargets[2].Current)
	assert.True(t, agent.HasAvailableTarget)
}

// 全部档都不可用（未配对/离线/本机跳过）时，Agent 级别的 has_available_target
// 落 false——前端据此渲染「没有可用的执行机器」。
func TestListAccountAgents_GivenAllTargetsUnavailable_ThenHasAvailableTargetFalse(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "测试 Agent"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-1", AgentredFingerprint: "fp-unknown",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "backend-1", "sort_order": 0})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.ListAccountAgents(ctx, 7, "")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.False(t, got[0].HasAvailableTarget)
	require.Len(t, got[0].ExecTargets, 1)
	assert.Equal(t, AvailabilityUnpaired, got[0].ExecTargets[0].Availability)
}

// R19 守卫：即便存储的 backend 载荷里混着 cli_path / env_json，视图对象序列化后
// 也绝不能带出这两个键或它们的值——因为 AgentView 一开始就没有能装下它们的字段。
func TestListAccountAgents_NeverCarriesCLIPathOrEnvJSON(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "运维 Agent"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-1", AgentredFingerprint: "",
			Payload: mustJSON(t, map[string]any{
				"type": "claude_code", "cli_path": "/Users/alice/.local/bin/claude", "env_json": `{"OPENAI_API_KEY":"sk-super-secret"}`,
			})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "backend-1", "sort_order": 0})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.ListAccountAgents(ctx, 7, "")
	require.NoError(t, err)
	out := mustJSON(t, got)
	assert.NotContains(t, out, "/Users/alice")
	assert.NotContains(t, out, "sk-super-secret")
	assert.NotContains(t, out, "cli_path")
	assert.NotContains(t, out, "env_json")
}

// agentred 展开：只列它自己在目标链里出现的 Agent（带档位），且项目清单只包含
// 已配置的那些——未配置的项目不出现，符合「只显示是否配置」的呈现约定。
//
// 「已配置」的来源是同步组里 kind=project_location、指纹等于这台机器的那些行
// （决策 13、决策 7）。上报组 device_local_paths 只有桌面端会写（R16），agentred
// 从不上报，照那张表取出来的清单永远是空的——因此这里连问都不问它。
func TestDeviceDetail_GivenAgentred_ThenListsRunnableAgentsWithRankAndConfiguredProjectsOnly(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)

	mDev.EXPECT().Find(ctx, int64(20)).Return(
		&device_entity.Device{ID: 20, UserID: 7, Kind: device_entity.KindAgentred, Fingerprint: "fp-a", Status: 1}, nil)
	var askedKinds []string
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, kinds []string) ([]*sync_entity.SyncObject, error) {
			askedKinds = kinds
			return []*sync_entity.SyncObject{
				{Kind: sync_entity.KindProject, SyncID: "proj-1", Payload: mustJSON(t, map[string]any{"name": "agentre-server"})},
				{Kind: sync_entity.KindProject, SyncID: "proj-2", Payload: mustJSON(t, map[string]any{"name": "agentre-hub"})},
				// 这台机器上配了路径的项目。
				{Kind: sync_entity.KindProjectLocation, SyncID: "loc-1", ProjectSyncID: "proj-1",
					AgentredFingerprint: "fp-a", Payload: mustJSON(t, map[string]any{"path": "/srv/data/agentre-server"})},
				// 另一台 agentred 上的路径记录：不属于这台机器，不算「已配置」。
				{Kind: sync_entity.KindProjectLocation, SyncID: "loc-2", ProjectSyncID: "proj-2",
					AgentredFingerprint: "fp-b", Payload: mustJSON(t, map[string]any{"path": "/srv/other/agentre-hub"})},
				{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "前端 Agent"})},
				{Kind: sync_entity.KindAgent, SyncID: "agent-2", Payload: mustJSON(t, map[string]any{"name": "后端 Agent"})},
				{Kind: sync_entity.KindAgentBackend, SyncID: "b-other", AgentredFingerprint: "fp-b",
					Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
				{Kind: sync_entity.KindAgentBackend, SyncID: "b-mine", AgentredFingerprint: "fp-a",
					Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
				{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
					Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-other", "sort_order": 0})},
				{Kind: sync_entity.KindAgentExecTarget, SyncID: "t2",
					Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-mine", "sort_order": 1})},
			}, nil
		})

	got, err := svc.DeviceDetail(ctx, 7, 20)
	require.NoError(t, err)
	assert.Equal(t, device_entity.KindAgentred, got.Kind)
	assert.Contains(t, askedKinds, sync_entity.KindProjectLocation)

	require.Len(t, got.RunnableAgents, 1)
	assert.Equal(t, "前端 Agent", got.RunnableAgents[0].Name)
	assert.Equal(t, 2, got.RunnableAgents[0].Rank)

	require.Len(t, got.Projects, 1)
	assert.Equal(t, "agentre-server", got.Projects[0].Name)
	assert.True(t, got.Projects[0].Configured)

	// R19 守卫：路径记录的正文过了这一层，但视图里只剩项目名与「已配置」这个布尔。
	out := mustJSON(t, got)
	assert.NotContains(t, out, "/srv/data")
	assert.NotContains(t, out, "path")
}

// 桌面端展开：不列 Agent（Agent 不按桌面端归属），项目清单列全部账号级项目，
// 各自标已配置/未配置——两种状态都要出现,且不出现路径正文。
func TestDeviceDetail_GivenDesktop_ThenListsAllProjectsConfiguredOrNotAndNoAgents(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)

	mDev.EXPECT().Find(ctx, int64(30)).Return(
		&device_entity.Device{ID: 30, UserID: 7, Kind: device_entity.KindDesktop, Fingerprint: "fp-d", Status: 1}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(30)).Return([]*sync_entity.DeviceLocalPath{
		{UserID: 7, DeviceID: 30, ProjectSyncID: "proj-1", Path: "/Users/wyz/agentre-server"},
	}, nil)
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindProject, SyncID: "proj-1", Payload: mustJSON(t, map[string]any{"name": "agentre-server"})},
		{Kind: sync_entity.KindProject, SyncID: "proj-2", Payload: mustJSON(t, map[string]any{"name": "agentre-hub"})},
	}, nil)

	got, err := svc.DeviceDetail(ctx, 7, 30)
	require.NoError(t, err)
	assert.Empty(t, got.RunnableAgents)
	require.Len(t, got.Projects, 2)

	byName := map[string]bool{}
	for _, p := range got.Projects {
		byName[p.Name] = p.Configured
	}
	assert.True(t, byName["agentre-server"])
	assert.False(t, byName["agentre-hub"])

	out := mustJSON(t, got)
	assert.NotContains(t, out, "/Users/wyz")
}

// 撤销/不属于自己账号的设备一律当不存在处理，不泄露「这个 ID 存在于别人账号下」。
func TestDeviceDetail_GivenForeignOrMissingDevice_ThenNotFound(t *testing.T) {
	ctx, _, _, mDev, svc := setupWorkspaceTest(t)
	mDev.EXPECT().Find(ctx, int64(99)).Return(
		&device_entity.Device{ID: 99, UserID: 8, Kind: device_entity.KindDesktop, Status: 1}, nil)

	_, err := svc.DeviceDetail(ctx, 7, 99)
	assert.Error(t, err)
}

// ── R15 派发计划：从 web 给「某 Agent + 某项目」派活，落到哪台 agentred ────────

// 本机相对引用（device_id 为空）按 R15d 在 web 语境下跳过；离线档给原因；第一档
// 可用的 agentred 被选中并带上该项目在那台机器上的绝对路径（屏幕 25 呈现 + 派发
// runtime.run 用）。
func TestWebDispatchPlan_GivenLocalOfflineAvailable_ThenSkipsLocalAndPicksFirstAvailable(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-online": true, "fp-offline": false}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "后端 Agent"})},
		{Kind: sync_entity.KindProject, SyncID: "proj-1", Payload: mustJSON(t, map[string]any{"name": "agentre-server"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-local", AgentredFingerprint: "",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-offline", AgentredFingerprint: "fp-offline",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-online", AgentredFingerprint: "fp-online",
			Payload: mustJSON(t, map[string]any{"type": "codex"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-local", "sort_order": 0})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t2",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-offline", "sort_order": 1})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t3",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-online", "sort_order": 2})},
		{Kind: sync_entity.KindProjectLocation, SyncID: "loc-1", ProjectSyncID: "proj-1",
			AgentredFingerprint: "fp-online", Payload: mustJSON(t, map[string]any{"path": "/srv/agentre-server"})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-offline", Status: 1},
		{ID: 21, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-online", Status: 1},
	}, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "proj-1", "")
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 3)

	// R15d 守卫：device_id 为空的「本机」档被跳过，不作为可选目标。
	assert.Equal(t, AvailabilitySkippedForWeb, plan.Tiers[0].Availability)
	assert.False(t, plan.Tiers[0].Current)

	assert.Equal(t, AvailabilityOffline, plan.Tiers[1].Availability)
	assert.Equal(t, "书房小主机", plan.Tiers[1].DeviceName)

	assert.Equal(t, AvailabilityAvailable, plan.Tiers[2].Availability)
	assert.True(t, plan.Tiers[2].Current)
	assert.Equal(t, "公司 Mac mini", plan.Tiers[2].DeviceName)
	assert.Equal(t, "codex", plan.Tiers[2].BackendType)

	// 选中档带执行所需信息：指纹、设备 ID、后端类型与项目路径（屏幕 25）。
	require.NotNil(t, plan.Chosen)
	assert.Equal(t, "fp-online", plan.Chosen.DeviceFingerprint)
	assert.Equal(t, int64(21), plan.Chosen.DeviceID)
	assert.Equal(t, "公司 Mac mini", plan.Chosen.DeviceName)
	assert.Equal(t, "/srv/agentre-server", plan.Chosen.Cwd)

	// picker 用：选中的机器上已配置的项目清单。
	require.Len(t, plan.Projects, 1)
	assert.Equal(t, "agentre-server", plan.Projects[0].Name)
	assert.Equal(t, "proj-1", plan.Projects[0].SyncID)
}

// 全部档不可用时不静默失败：逐档给出原因（本机跳过 / 未配对 / 离线 /
// 项目路径缺失），chosen 为空，任何一档都不是 Current。
func TestWebDispatchPlan_GivenAllUnavailable_ThenPerTierReasons(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-online": true, "fp-offline": false}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "运维 Agent"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-local", AgentredFingerprint: "",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-ghost", AgentredFingerprint: "fp-ghost",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-offline", AgentredFingerprint: "fp-offline",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-nopath", AgentredFingerprint: "fp-online",
			Payload: mustJSON(t, map[string]any{"type": "codex"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-local", "sort_order": 0})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t2",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-ghost", "sort_order": 1})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t3",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-offline", "sort_order": 2})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t4",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-nopath", "sort_order": 3})},
		// fp-online 这台机器没有 proj-1 的路径记录。
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-offline", Status: 1},
		{ID: 21, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-online", Status: 1},
	}, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "proj-1", "")
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 4)

	assert.Equal(t, AvailabilitySkippedForWeb, plan.Tiers[0].Availability)
	assert.Equal(t, AvailabilityUnpaired, plan.Tiers[1].Availability)
	assert.Equal(t, AvailabilityOffline, plan.Tiers[2].Availability)
	assert.Equal(t, AvailabilityProjectPathMissing, plan.Tiers[3].Availability)

	for _, tier := range plan.Tiers {
		assert.False(t, tier.Current, "全部不可用时任何一档都不该是当前档")
	}
	assert.Nil(t, plan.Chosen)
	assert.Empty(t, plan.Projects)
}

// 第一档在线的 agentred 没配这个项目的路径 → 该档标「项目路径缺失」，继续按顺序
// 取第二档（配了路径的）为派发目标（块 1 R15 的按序语义）。
func TestWebDispatchPlan_GivenProjectMissingOnFirstAvailable_ThenPicksNextWithPath(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-a": true, "fp-b": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "后端 Agent"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-a", AgentredFingerprint: "fp-a",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-b", AgentredFingerprint: "fp-b",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-a", "sort_order": 0})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t2",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-b", "sort_order": 1})},
		// 只有 fp-b 配了 proj-1 的路径。
		{Kind: sync_entity.KindProjectLocation, SyncID: "loc-1", ProjectSyncID: "proj-1",
			AgentredFingerprint: "fp-b", Payload: mustJSON(t, map[string]any{"path": "/srv/hub"})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 10, UserID: 7, Name: "书房 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-a", Status: 1},
		{ID: 11, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-b", Status: 1},
	}, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "proj-1", "")
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 2)

	assert.Equal(t, AvailabilityProjectPathMissing, plan.Tiers[0].Availability)
	assert.False(t, plan.Tiers[0].Current)
	assert.Equal(t, AvailabilityAvailable, plan.Tiers[1].Availability)
	assert.True(t, plan.Tiers[1].Current)

	require.NotNil(t, plan.Chosen)
	assert.Equal(t, "fp-b", plan.Chosen.DeviceFingerprint)
	assert.Equal(t, "/srv/hub", plan.Chosen.Cwd)
}

// 未传项目（picker 阶段只看「这台机器能不能接活」）时不做项目路径判定，路径字段留空。
func TestWebDispatchPlan_GivenNoProject_ThenPicksFirstAvailableWithoutPath(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-online": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "后端 Agent"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-online", AgentredFingerprint: "fp-online",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-online", "sort_order": 0})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 21, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-online", Status: 1},
	}, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "", "")
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 1)
	assert.Equal(t, AvailabilityAvailable, plan.Tiers[0].Availability)
	require.NotNil(t, plan.Chosen)
	assert.Equal(t, "fp-online", plan.Chosen.DeviceFingerprint)
	assert.Empty(t, plan.Chosen.Cwd)
}

// 账号下不存在的 Agent（或从没同步过）→ NotFound，不返回空计划假装可用。
func TestWebDispatchPlan_GivenUnknownAgent_ThenNotFound(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-other", Payload: mustJSON(t, map[string]any{"name": "别的 Agent"})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	_, err := svc.WebDispatchPlan(ctx, 7, "agent-missing", "", "")
	assert.Error(t, err)
}

// R17：浏览器把新对话派到一台桌面端上。桌面端在派发计划里是与 agentred 同地位的
// 具名目标（决策 10）——第一档可用的是桌面端时，计划必须选中它并把「该桌面端自己
// 上报的本机路径」作为 cwd 带出（决策 6：桌面端路径只存在于上报组 device_local_paths，
// 不在同步组 project_location 里），而不是误判成 project_path_missing。选中的档还要
// 携带 kind=desktop，供发起前如实说明 org/subagent/hook 在桌面端上可用（R17）。
func TestWebDispatchPlan_GivenDesktopFirstAvailable_ThenChoosesDesktopWithLocalPathAndKind(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-desk": true, "fp-agentred": false}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "后端 Agent"})},
		{Kind: sync_entity.KindProject, SyncID: "proj-1", Payload: mustJSON(t, map[string]any{"name": "agentre-server"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-local", AgentredFingerprint: "",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-desk", AgentredFingerprint: "fp-desk",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-agentred", AgentredFingerprint: "fp-agentred",
			Payload: mustJSON(t, map[string]any{"type": "codex"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-local", "sort_order": 0})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t2",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-desk", "sort_order": 1})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t3",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-agentred", "sort_order": 2})},
		// 桌面端不写同步组 project_location；它的路径只在上报组 device_local_paths。
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-agentred", Status: 1},
		{ID: 30, UserID: 7, Name: "家里 Mac mini", Kind: device_entity.KindDesktop, Fingerprint: "fp-desk", Status: 1},
	}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(30)).Return([]*sync_entity.DeviceLocalPath{
		{UserID: 7, DeviceID: 30, ProjectSyncID: "proj-1", Path: "/Users/wyz/agentre-server"},
	}, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "proj-1", "")
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 3)

	// 本机相对引用照旧跳过（R15d 删除后无相对槽位，这里是最老档位的遗留形态）。
	assert.Equal(t, AvailabilitySkippedForWeb, plan.Tiers[0].Availability)

	// 第一档可用的是桌面端：被选中，且不是 project_path_missing（路径来自它自己的上报）。
	assert.Equal(t, AvailabilityAvailable, plan.Tiers[1].Availability)
	assert.Equal(t, "家里 Mac mini", plan.Tiers[1].DeviceName)
	assert.Equal(t, device_entity.KindDesktop, plan.Tiers[1].Kind)
	assert.True(t, plan.Tiers[1].Current)

	assert.Equal(t, AvailabilityOffline, plan.Tiers[2].Availability)
	assert.Equal(t, "书房小主机", plan.Tiers[2].DeviceName)

	require.NotNil(t, plan.Chosen)
	assert.Equal(t, "fp-desk", plan.Chosen.DeviceFingerprint)
	assert.Equal(t, device_entity.KindDesktop, plan.Chosen.Kind)
	assert.Equal(t, "家里 Mac mini", plan.Chosen.DeviceName)
	assert.Equal(t, "/Users/wyz/agentre-server", plan.Chosen.Cwd)

	// picker 用：桌面端已配置的项目清单同样从它的上报组路径来。
	require.Len(t, plan.Projects, 1)
	assert.Equal(t, "agentre-server", plan.Projects[0].Name)
	assert.Equal(t, "proj-1", plan.Projects[0].SyncID)
}

// R17 的不可用边界：桌面端在线但没配所选项目的路径 → 该档如实标 project_path_missing
// （逐档原因，不静默），继续按顺序取下一档配了路径的 agentred。
func TestWebDispatchPlan_GivenDesktopMissingProjectPath_ThenSkipsToNextTargetWithPath(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-desk": true, "fp-agentred": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "后端 Agent"})},
		{Kind: sync_entity.KindProject, SyncID: "proj-1", Payload: mustJSON(t, map[string]any{"name": "agentre-server"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-desk", AgentredFingerprint: "fp-desk",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-agentred", AgentredFingerprint: "fp-agentred",
			Payload: mustJSON(t, map[string]any{"type": "codex"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-desk", "sort_order": 0})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t2",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-agentred", "sort_order": 1})},
		{Kind: sync_entity.KindProjectLocation, SyncID: "loc-1", ProjectSyncID: "proj-1",
			AgentredFingerprint: "fp-agentred", Payload: mustJSON(t, map[string]any{"path": "/srv/agentre-server"})},
		// 桌面端上报组里没有 proj-1 的路径（它的 ListByDevice 返回空）。
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 30, UserID: 7, Name: "家里 Mac mini", Kind: device_entity.KindDesktop, Fingerprint: "fp-desk", Status: 1},
		{ID: 21, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-agentred", Status: 1},
	}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(30)).Return(nil, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "proj-1", "")
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 2)

	assert.Equal(t, AvailabilityProjectPathMissing, plan.Tiers[0].Availability)
	assert.Equal(t, "家里 Mac mini", plan.Tiers[0].DeviceName)
	assert.False(t, plan.Tiers[0].Current)

	assert.Equal(t, AvailabilityAvailable, plan.Tiers[1].Availability)
	assert.True(t, plan.Tiers[1].Current)
	assert.Equal(t, "公司 Mac mini", plan.Tiers[1].DeviceName)
	assert.Equal(t, device_entity.KindAgentred, plan.Tiers[1].Kind)

	require.NotNil(t, plan.Chosen)
	assert.Equal(t, "fp-agentred", plan.Chosen.DeviceFingerprint)
	assert.Equal(t, device_entity.KindAgentred, plan.Chosen.Kind)
	assert.Equal(t, "/srv/agentre-server", plan.Chosen.Cwd)
}

// ── 每端自己的派发顺序：按调用方设备的排列重排执行目标链 ──────────────────

// registerExecOrderMock 只给「带设备指纹」的用例装排列仓储。不带指纹的用例根本不该
// 走到它：那时仓储没被注册，一旦有人偷偷去读会当场炸开，而不是悄悄拿到一个空排列
// 让「没解析设备就去读排列」这种错误蒙混过关。
func registerExecOrderMock(t *testing.T) *mock_exec_order_repo.MockExecOrderRepo {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	m := mock_exec_order_repo.NewMockExecOrderRepo(ctrl)
	exec_order_repo.RegisterExecOrder(m)
	t.Cleanup(func() { exec_order_repo.RegisterExecOrder(nil) })
	return m
}

// orderedChainRows 是「一个 Agent + 三档执行目标」的固定装置：账号 sort_order 是
// b-a → b-b → b-c，分别落在三台 agentred 上。
func orderedChainRows(t *testing.T) []*sync_entity.SyncObject {
	t.Helper()
	return []*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "后端 Agent"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-a", AgentredFingerprint: "fp-a",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-b", AgentredFingerprint: "fp-b",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-c", AgentredFingerprint: "fp-c",
			Payload: mustJSON(t, map[string]any{"type": "codex"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-a", "sort_order": 0})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t2",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-b", "sort_order": 1})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t3",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-c", "sort_order": 2})},
	}
}

// orderedChainDevices 是 orderedChainRows 对应的设备，外加发起请求的那台浏览器
// （kind=web，ID 90）——排列的**持有者**，它本身从不作为派发目标出现在链上。
func orderedChainDevices() []*device_entity.Device {
	return []*device_entity.Device{
		{ID: 20, UserID: 7, Name: "机器 A", Kind: device_entity.KindAgentred, Fingerprint: "fp-a", Status: 1},
		{ID: 21, UserID: 7, Name: "机器 B", Kind: device_entity.KindAgentred, Fingerprint: "fp-b", Status: 1},
		{ID: 22, UserID: 7, Name: "机器 C", Kind: device_entity.KindAgentred, Fingerprint: "fp-c", Status: 1},
		{ID: 90, UserID: 7, Name: "Chrome", Kind: device_entity.KindWeb, Fingerprint: "fp-web", Status: 1},
	}
}

func allOnline() fakeOnlineChecker {
	return fakeOnlineChecker{online: map[string]bool{"fp-a": true, "fp-b": true, "fp-c": true}}
}

func tierBackendSyncIDs(tiers []WebDispatchTier) []string {
	out := make([]string, 0, len(tiers))
	for _, t := range tiers {
		out = append(out, t.BackendSyncID)
	}
	return out
}

func tierRanks(tiers []WebDispatchTier) []int {
	out := make([]int, 0, len(tiers))
	for _, t := range tiers {
		out = append(out, t.Rank)
	}
	return out
}

// 带上自己指纹的浏览器拿到的是**它自己那份顺序**下的派发计划：链按它的排列重排，
// 「第一个可用」因此落到另一档。挑选逻辑一行不改，只是它看到的顺序变了。
//
// 每一档还要带上 backend sync_id：rank 是位置性的、device_id 也不唯一（一台机器可挂
// 多个 backend），浏览器只能靠它表达排列。
func TestWebDispatchPlan_GivenDeviceOrder_ThenTiersFollowItAndChosenMoves(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mOrder := registerExecOrderMock(t)
	SetOnlineChecker(allOnline())

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(orderedChainRows(t), nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(orderedChainDevices(), nil)
	mOrder.EXPECT().Find(ctx, int64(7), int64(90), "agent-1").Return(
		&exec_order_entity.DeviceExecTargetOrder{
			UserID: 7, DeviceID: 90, AgentSyncID: "agent-1", OrderJSON: `["b-c","b-a"]`,
		}, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "", "fp-web")
	require.NoError(t, err)

	// 排列覆盖 b-c、b-a；没被覆盖的 b-b 按账号 sort_order 补到尾部。
	assert.Equal(t, []string{"b-c", "b-a", "b-b"}, tierBackendSyncIDs(plan.Tiers))
	// rank 是位置性的：重排后必须重编号，否则前端看到的序号与实际派发顺序对不上。
	assert.Equal(t, []int{1, 2, 3}, tierRanks(plan.Tiers))
	assert.True(t, plan.Tiers[0].Current)
	require.NotNil(t, plan.Chosen)
	assert.Equal(t, "fp-c", plan.Chosen.DeviceFingerprint)
	assert.Equal(t, "机器 C", plan.Chosen.DeviceName)
}

// 这台设备没有自己的顺序：回落到同步下来的账号 sort_order，与不带指纹时一致。
func TestWebDispatchPlan_GivenNoOrderRow_ThenFallsBackToAccountSortOrder(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mOrder := registerExecOrderMock(t)
	SetOnlineChecker(allOnline())

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(orderedChainRows(t), nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(orderedChainDevices(), nil)
	mOrder.EXPECT().Find(ctx, int64(7), int64(90), "agent-1").Return(nil, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "", "fp-web")
	require.NoError(t, err)
	assert.Equal(t, []string{"b-a", "b-b", "b-c"}, tierBackendSyncIDs(plan.Tiers))
	assert.Equal(t, "fp-a", plan.Chosen.DeviceFingerprint)
}

// 排列是**收敛的**，不是权威的：排完序之后账号侧删掉了一档、又加了一档，旧排列
// 不失效也不让谁凭空消失——指向已不存在 backend 的项忽略，没被覆盖到的档按账号
// sort_order 补到尾部（与桌面端 ResolveExecTargetOrder 同一规则）。
func TestWebDispatchPlan_GivenOrderReferencingRemovedBackend_ThenIgnoredAndUncoveredAppended(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mOrder := registerExecOrderMock(t)
	SetOnlineChecker(allOnline())

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(orderedChainRows(t), nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(orderedChainDevices(), nil)
	mOrder.EXPECT().Find(ctx, int64(7), int64(90), "agent-1").Return(
		&exec_order_entity.DeviceExecTargetOrder{
			UserID: 7, DeviceID: 90, AgentSyncID: "agent-1",
			// b-gone 已被删除；b-b 是排完序之后新加的一档。
			OrderJSON: `["b-gone","b-c"]`,
		}, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "", "fp-web")
	require.NoError(t, err)
	assert.Equal(t, []string{"b-c", "b-a", "b-b"}, tierBackendSyncIDs(plan.Tiers))
	assert.Len(t, plan.Tiers, 3, "排列里的幽灵档不得凭空多出一档")
}

// 指纹解析不到设备（换了浏览器、清了 localStorage、指纹是别人账号的）：读路径按
// 「没有排列」处理，回落账号顺序，不报错也不静默改派到别处（决策 9 的读侧）。
// 设备解析不到就拿不到 device_id，也就根本没有可读的排列——排列仓储一次都不该被碰。
func TestWebDispatchPlan_GivenUnresolvableFingerprint_ThenSilentlyFallsBack(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	registerExecOrderMock(t) // 不设任何 EXPECT：被调用即失败
	SetOnlineChecker(allOnline())

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(orderedChainRows(t), nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(orderedChainDevices(), nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "", "fp-someone-else")
	require.NoError(t, err)
	assert.Equal(t, []string{"b-a", "b-b", "b-c"}, tierBackendSyncIDs(plan.Tiers))
	assert.Equal(t, "fp-a", plan.Chosen.DeviceFingerprint)
}

// 排列把「本机」相对引用排到第一位也改变不了 R15d：浏览器语境下它没有指代对象，
// 仍然 skipped_for_web、仍然不参与「第一个可用」的挑选。重排只换顺序，不换语义。
func TestWebDispatchPlan_GivenOrderPromotingLocalReference_ThenStillSkippedForWeb(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mOrder := registerExecOrderMock(t)
	SetOnlineChecker(allOnline())

	rows := append(orderedChainRows(t),
		&sync_entity.SyncObject{Kind: sync_entity.KindAgentBackend, SyncID: "b-local", AgentredFingerprint: "",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		&sync_entity.SyncObject{Kind: sync_entity.KindAgentExecTarget, SyncID: "t4",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-local", "sort_order": 3})},
	)
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(rows, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(orderedChainDevices(), nil)
	mOrder.EXPECT().Find(ctx, int64(7), int64(90), "agent-1").Return(
		&exec_order_entity.DeviceExecTargetOrder{
			UserID: 7, DeviceID: 90, AgentSyncID: "agent-1", OrderJSON: `["b-local","b-b"]`,
		}, nil)

	plan, err := svc.WebDispatchPlan(ctx, 7, "agent-1", "", "fp-web")
	require.NoError(t, err)
	assert.Equal(t, []string{"b-local", "b-b", "b-a", "b-c"}, tierBackendSyncIDs(plan.Tiers))
	assert.Equal(t, AvailabilitySkippedForWeb, plan.Tiers[0].Availability)
	assert.False(t, plan.Tiers[0].Current)
	assert.True(t, plan.Tiers[1].Current)
	assert.Equal(t, "fp-b", plan.Chosen.DeviceFingerprint)
}

// 总览页的 Agent 卡片渲染的是同一条链，也必须按这个浏览器的顺序：否则卡片上排第一、
// 标着「当前」的那一档，和真派发时选中的不是同一档。
func TestListAccountAgents_GivenDeviceOrder_ThenCardChainFollowsItAndCurrentMoves(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mOrder := registerExecOrderMock(t)
	SetOnlineChecker(allOnline())

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(orderedChainRows(t), nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(orderedChainDevices(), nil)
	// 一次取这台设备对全部 Agent 的排列：一屏多张卡片不该按 Agent 逐条查库。
	mOrder.EXPECT().ListByDevice(ctx, int64(7), int64(90)).Return(
		[]*exec_order_entity.DeviceExecTargetOrder{
			{UserID: 7, DeviceID: 90, AgentSyncID: "agent-1", OrderJSON: `["b-c"]`},
			{UserID: 7, DeviceID: 90, AgentSyncID: "agent-other", OrderJSON: `["x"]`},
		}, nil)

	got, err := svc.ListAccountAgents(ctx, 7, "fp-web")
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Len(t, got[0].ExecTargets, 3)
	assert.Equal(t, []string{"b-c", "b-a", "b-b"}, []string{
		got[0].ExecTargets[0].BackendSyncID,
		got[0].ExecTargets[1].BackendSyncID,
		got[0].ExecTargets[2].BackendSyncID,
	})
	assert.Equal(t, []int{1, 2, 3}, []int{
		got[0].ExecTargets[0].Rank, got[0].ExecTargets[1].Rank, got[0].ExecTargets[2].Rank,
	})
	assert.True(t, got[0].ExecTargets[0].Current)
	assert.Equal(t, "机器 C", got[0].ExecTargets[0].DeviceName)
}

// 写路径与读路径**刻意不同**：保存顺序时解析不到设备就拒绝，绝不猜一个 device_id
// 去写（决策 9）。指纹是参数传进来的，账号归属只能靠 (user_id, fingerprint) 这次
// 解析来保证——别人账号的指纹在这里查不到，因此写不进去。
func TestSetExecTargetOrder_GivenForeignFingerprint_ThenRejectedWithoutWriting(t *testing.T) {
	ctx, _, _, mDev, svc := setupWorkspaceTest(t)
	mOrder := registerExecOrderMock(t)
	mDev.EXPECT().FindByFingerprint(ctx, int64(7), "fp-someone-else").Return(nil, nil)
	mOrder.EXPECT().Save(gomock.Any(), gomock.Any()).Times(0)

	err := svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, DeviceFingerprint: "fp-someone-else",
		AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-c", "b-a"},
	})
	assert.Error(t, err)
}

// 已被解除授权的设备同样写不进去：它的顺序马上就要被清掉，再收一份新的没有意义。
func TestSetExecTargetOrder_GivenRevokedDevice_ThenRejectedWithoutWriting(t *testing.T) {
	ctx, _, _, mDev, svc := setupWorkspaceTest(t)
	mOrder := registerExecOrderMock(t)
	mDev.EXPECT().FindByFingerprint(ctx, int64(7), "fp-web").Return(
		&device_entity.Device{ID: 90, UserID: 7, Fingerprint: "fp-web", Kind: device_entity.KindWeb, Status: consts.DELETE}, nil)
	mOrder.EXPECT().Save(gomock.Any(), gomock.Any()).Times(0)

	err := svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, DeviceFingerprint: "fp-web",
		AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-c"},
	})
	assert.Error(t, err)
}

// 自己账号下的设备：排列按 (user_id, device_id, agent_sync_id) 整体落库。写路径
// 不校验排列与当前执行目标集合是否一致——排列是收敛的偏好，解析时以集合为准。
func TestSetExecTargetOrder_GivenOwnDevice_ThenSavesPermutationUnderResolvedDeviceID(t *testing.T) {
	ctx, _, _, mDev, svc := setupWorkspaceTest(t)
	mOrder := registerExecOrderMock(t)
	mDev.EXPECT().FindByFingerprint(ctx, int64(7), "fp-web").Return(
		&device_entity.Device{ID: 90, UserID: 7, Fingerprint: "fp-web", Kind: device_entity.KindWeb, Status: 1}, nil)

	var saved *exec_order_entity.DeviceExecTargetOrder
	mOrder.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *exec_order_entity.DeviceExecTargetOrder) error {
			saved = o
			return nil
		})

	require.NoError(t, svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, DeviceFingerprint: "fp-web",
		AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-c", "b-a", "b-b"},
	}))
	require.NotNil(t, saved)
	assert.Equal(t, int64(7), saved.UserID)
	assert.Equal(t, int64(90), saved.DeviceID, "device_id 只能由指纹解析 devices 行得到")
	assert.Equal(t, "agent-1", saved.AgentSyncID)
	assert.Equal(t, []string{"b-c", "b-a", "b-b"}, saved.BackendSyncIDs())
	assert.NotZero(t, saved.Updatetime)
}

// 解除授权 / 删除设备时它排的顺序一并消失：排列的持有者是那台设备，设备没了它就
// 没有持有者，不该残留在账号里。只按 device_id 删——device_id 是全局自增主键、天然
// 只属于一个账号，账号级的执行目标**集合**（在同步组里）不受影响。
func TestPurgeDeviceExecTargetOrders_GivenDeviceID_ThenDeletesAllItsOrders(t *testing.T) {
	ctx, _, _, _, svc := setupWorkspaceTest(t)
	mOrder := registerExecOrderMock(t)

	mOrder.EXPECT().DeleteByDevice(ctx, int64(90)).Return(nil)

	require.NoError(t, svc.PurgeDeviceExecTargetOrders(ctx, 90))
}

// 没有 backend sync_id 的档钉在原位，不被冲到队尾。
//
// 排列以 backend sync_id 表达，所以一档没有 sync_id 就无从在排列里指代自己
// （frontend/src/lib/execOrder.ts 的 reorderTargets 会把它从提交的排列里滤掉，
// 同时在本地把它钉在原位）。服务端若把「不在排列里」一律当成「未覆盖、补到队尾」，
// 这一档就会在提交后的重新拉取里凭空跳到最后——两端对同一次操作给出不同结果。
//
// 「未覆盖补到队尾」只适用于**能被指代却没被排到**的档（新加的一档）；无从指代的
// 档不属于那一类，它压根没有参与排序的资格，位置也就不该被排序动到。
func TestApplyDeviceOrder_GivenTierWithoutSyncID_ThenItStaysAtItsOriginalIndex(t *testing.T) {
	targets := []resolvedTarget{
		{Rank: 1, BackendSyncID: "b-a"},
		{Rank: 2, BackendSyncID: ""}, // 无从指代：畸形同步载荷里 backend_sync_id 为空
		{Rank: 3, BackendSyncID: "b-c"},
	}

	got := applyDeviceOrder(targets, []string{"b-c", "b-a"})

	assert.Equal(t, []string{"b-c", "", "b-a"}, backendSyncIDsOf(got),
		"无 sync_id 的档应留在第 2 位，可排的两档在它前后换位")
	assert.Equal(t, []int{1, 2, 3}, ranksOf(got), "Rank 必须按最终位置重编号")
}

// 能被指代却没被排列覆盖到的档（排完序之后新增的一档）仍然补到队尾——这是规格
// 「集合里没被排列覆盖到的档按账号 sort_order 补到尾部」，与上面那条互不冲突。
func TestApplyDeviceOrder_GivenUncoveredTierWithSyncID_ThenAppendedAtTail(t *testing.T) {
	targets := []resolvedTarget{
		{Rank: 1, BackendSyncID: "b-a"},
		{Rank: 2, BackendSyncID: "b-new"},
		{Rank: 3, BackendSyncID: "b-c"},
	}

	got := applyDeviceOrder(targets, []string{"b-c", "b-a"})

	assert.Equal(t, []string{"b-c", "b-a", "b-new"}, backendSyncIDsOf(got))
}

func backendSyncIDsOf(ts []resolvedTarget) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.BackendSyncID)
	}
	return out
}

func ranksOf(ts []resolvedTarget) []int {
	out := make([]int, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.Rank)
	}
	return out
}
