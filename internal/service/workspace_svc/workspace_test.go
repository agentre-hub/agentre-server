package workspace_svc

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/sync_entity"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
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

	got, err := svc.ListAccountAgents(ctx, 7)
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

	got, err := svc.ListAccountAgents(ctx, 7)
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

	got, err := svc.ListAccountAgents(ctx, 7)
	require.NoError(t, err)
	out := mustJSON(t, got)
	assert.NotContains(t, out, "/Users/alice")
	assert.NotContains(t, out, "sk-super-secret")
	assert.NotContains(t, out, "cli_path")
	assert.NotContains(t, out, "env_json")
}

// agentred 展开：只列它自己在目标链里出现的 Agent（带档位），且项目清单只包含
// 已配置的那些——未配置的项目不出现，符合「只显示是否配置」的呈现约定。
func TestDeviceDetail_GivenAgentred_ThenListsRunnableAgentsWithRankAndConfiguredProjectsOnly(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)

	mDev.EXPECT().Find(ctx, int64(20)).Return(
		&device_entity.Device{ID: 20, UserID: 7, Kind: device_entity.KindAgentred, Fingerprint: "fp-a", Status: 1}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(20)).Return([]*sync_entity.DeviceLocalPath{
		{UserID: 7, DeviceID: 20, ProjectSyncID: "proj-1", Path: "/srv/proj-1"},
	}, nil)
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindProject, SyncID: "proj-1", Payload: mustJSON(t, map[string]any{"name": "agentre-server"})},
		{Kind: sync_entity.KindProject, SyncID: "proj-2", Payload: mustJSON(t, map[string]any{"name": "agentre-hub"})},
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
	}, nil)

	got, err := svc.DeviceDetail(ctx, 7, 20)
	require.NoError(t, err)
	assert.Equal(t, device_entity.KindAgentred, got.Kind)

	require.Len(t, got.RunnableAgents, 1)
	assert.Equal(t, "前端 Agent", got.RunnableAgents[0].Name)
	assert.Equal(t, 2, got.RunnableAgents[0].Rank)

	require.Len(t, got.Projects, 1)
	assert.Equal(t, "agentre-server", got.Projects[0].Name)
	assert.True(t, got.Projects[0].Configured)
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
