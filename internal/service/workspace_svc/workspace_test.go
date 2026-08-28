package workspace_svc

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// accountChanCall 是 stubAccountChan 记下的一次广播。
type accountChanCall struct {
	accountID int64
	version   int64
}

// stubAccountChan 是账号级实时通道在服务层测试里的替身（SetDefault 换掉真实的
// Redis 实现），只记调用、可选地模拟广播失败——web 组织面的写路径测试据此断言
// 「广播失败只记录、不回滚已经落库的写入」。
type stubAccountChan struct {
	mu    sync.Mutex
	err   error
	calls []accountChanCall
}

func (s *stubAccountChan) Broadcast(_ context.Context, accountID int64, frame accountchan_svc.Frame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, accountChanCall{accountID: accountID, version: frame.Version})
	return s.err
}

func (s *stubAccountChan) Subscribe(context.Context, int64) (accountchan_svc.Subscription, error) {
	return nil, errors.New("stubAccountChan: Subscribe not used by write-path tests")
}

func (s *stubAccountChan) recordedCalls() []accountChanCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]accountChanCall(nil), s.calls...)
}

// registerAccountChanStub 换上替身并保证测试结束后恢复成未装配状态（Default() 的
// 安全占位），不让一个测试的广播替身漏到下一个测试里。
func registerAccountChanStub(t *testing.T) *stubAccountChan {
	t.Helper()
	stub := &stubAccountChan{}
	accountchan_svc.SetDefault(stub)
	t.Cleanup(func() { accountchan_svc.SetDefault(nil) })
	return stub
}

// fakeOnlineChecker 让测试按指纹摆布在线态，不用起真的 relay_svc / redis。
type fakeOnlineChecker struct {
	online map[string]bool
}

func (f fakeOnlineChecker) IsDaemonOnline(_ context.Context, _ int64, fingerprint string) (bool, error) {
	return f.online[fingerprint], nil
}

func setupWorkspaceTest(t *testing.T) (
	context.Context, *mock_sync_repo.MockSyncObjectRepo, *mock_sync_repo.MockSyncLocalPathRepo,
	*mock_device_repo.MockDeviceRepo, *workspaceSvc,
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

// 一个 Agent、三档执行目标：没写运行设备的后端（派发跳过，如实标「未指定设备」）→
// 离线的 agentred → 在线的 agentred。要求顺序原样保留、离线档标不可用、第三档被选为
// 「当前生效」。
func TestListAccountAgents_GivenOrderedTargets_ThenFirstAvailableWithADeviceIsCurrent(t *testing.T) {
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
	assert.Equal(t, AvailabilityNoDevice, agent.ExecTargets[0].Availability)
	assert.False(t, agent.ExecTargets[0].Current)

	assert.Equal(t, "书房小主机", agent.ExecTargets[1].DeviceName)
	assert.Equal(t, AvailabilityOffline, agent.ExecTargets[1].Availability)
	assert.False(t, agent.ExecTargets[1].Current)

	assert.Equal(t, "公司 Mac mini", agent.ExecTargets[2].DeviceName)
	assert.Equal(t, AvailabilityAvailable, agent.ExecTargets[2].Availability)
	assert.True(t, agent.ExecTargets[2].Current)
	assert.True(t, agent.HasAvailableTarget)
}

// 全部档都不可用（未配对/离线/未指定设备）时，Agent 级别的 has_available_target
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

// 「从项目里挑一个 Agent」要的两样在 AgentView 上：Agent 自己的图标，以及它**直接
// 加入**了哪些项目。成员关系存在同步组的 project_agent 里（桌面端 adapter_project 的
// projectAgentPayload），此前这一档 kind 压根没被拉过——不拉它，浏览器就答不出
// 「这个项目里有哪些 Agent」，只能退回按机器列。
//
// 继承（子项目看得见父项目的成员）**不在这一层算**：项目树已经整份发给浏览器了
// （/v1/workspace/projects 带 parent_sync_id），在服务端再算一遍等于把同一条规则
// 实现两次。这里只如实回「直接成员」。
func TestListAccountAgents_GivenProjectMembership_ThenCarriesAvatarIconAndDirectProjects(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)

	var askedKinds []string
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, kinds []string) ([]*sync_entity.SyncObject, error) {
			askedKinds = kinds
			return []*sync_entity.SyncObject{
				{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{
					"name": "后端 Agent", "avatar_color": "agent-1", "avatar_icon": "server-cog"})},
				{Kind: sync_entity.KindAgent, SyncID: "agent-2", Payload: mustJSON(t, map[string]any{
					"name": "文档 Agent", "avatar_color": "agent-11"})},
				// 排序反着给：出参必须按 sync_id 稳定排序，不跟同步组的返回顺序走。
				{Kind: sync_entity.KindProjectAgent, SyncID: "pa-2", Payload: mustJSON(t, map[string]any{
					"project_sync_id": "proj-b", "agent_sync_id": "agent-1", "joined_at": 2})},
				{Kind: sync_entity.KindProjectAgent, SyncID: "pa-1", Payload: mustJSON(t, map[string]any{
					"project_sync_id": "proj-a", "agent_sync_id": "agent-1", "joined_at": 1})},
				// 已删除的成员关系不算数：退出项目之后它不该还留在清单里。
				{Kind: sync_entity.KindProjectAgent, SyncID: "pa-3", DeletedAt: 1700000000,
					Payload: mustJSON(t, map[string]any{
						"project_sync_id": "proj-c", "agent_sync_id": "agent-1", "joined_at": 3})},
			}, nil
		})
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.ListAccountAgents(ctx, 7)
	require.NoError(t, err)
	assert.Contains(t, askedKinds, sync_entity.KindProjectAgent,
		"不拉 project_agent 这一档，成员关系就永远是空的")
	require.Len(t, got, 2)

	byID := map[string]AgentView{}
	for _, a := range got {
		byID[a.SyncID] = a
	}
	assert.Equal(t, "server-cog", byID["agent-1"].AvatarIcon)
	assert.Equal(t, []string{"proj-a", "proj-b"}, byID["agent-1"].ProjectSyncIDs,
		"按 sync_id 排序，且删掉的那条不在内")
	assert.Empty(t, byID["agent-2"].ProjectSyncIDs, "没加入任何项目就如实留空，不补占位")
	assert.Empty(t, byID["agent-2"].AvatarIcon, "没选过图标就留空，不编一个默认值")
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

// ── 「改在哪跑」：按指定档重算 Chosen ─────────────────────────────────────────

// 桌面端空会话态那枚 chip 打开的浮层允许挑链上任意一档（「只影响这一次」）。
// 浏览器挑完必须拿到那一档的**指纹与 cwd**，否则 relay 连不上——而档结构
// WebDispatchTier 上没有这两样（只有 Chosen 有，见它自己的注释：R19 的唯一例外
// 只开给选中的那一档）。所以「挑档」这件事只能是服务端按指定档重算一次 Chosen，
// 不能让浏览器自己拼。
func TestWebDispatchPlan_GivenTargetBackend_ThenChosenIsThatTierNotTheFirstAvailable(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-a": true, "fp-b": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(twoAvailableTiersRows(t), nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-a", Status: 1},
		{ID: 21, UserID: 7, Name: "MacBook Pro", Kind: device_entity.KindAgentred, Fingerprint: "fp-b", Status: 1},
	}, nil)

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-1", ProjectSyncID: "proj-1", TargetBackendSyncID: "b-b"})
	require.NoError(t, err)

	require.NotNil(t, plan.Chosen)
	assert.Equal(t, "MacBook Pro", plan.Chosen.DeviceName, "落到用户挑的那一档，不是排最前的那档")
	assert.Equal(t, "fp-b", plan.Chosen.DeviceFingerprint)
	assert.Equal(t, "/home/wyz/agentre-server", plan.Chosen.Cwd, "cwd 要是**那台机器**上的路径")
	assert.Equal(t, "codex", plan.Chosen.BackendType)

	require.Len(t, plan.Tiers, 2)
	assert.False(t, plan.Tiers[0].Current, "自动挑的那一档不再是生效档")
	assert.True(t, plan.Tiers[1].Current, "生效档 = 用户挑的那一档")
}

// 指定的那一档跑不了时**不静默回落**到自动挑的那一档：用户挑的是这台机器，
// 悄悄换一台去跑是这里最糟的失败——会话的上下文、文件、shell 历史全在另一台上。
// Chosen 留空，逐档原因照常给，由界面说出来。
func TestWebDispatchPlan_GivenUnavailableTargetBackend_ThenNoChosenAndNoSilentFallback(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-a": true, "fp-b": false}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(twoAvailableTiersRows(t), nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-a", Status: 1},
		{ID: 21, UserID: 7, Name: "MacBook Pro", Kind: device_entity.KindAgentred, Fingerprint: "fp-b", Status: 1},
	}, nil)

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-1", ProjectSyncID: "proj-1", TargetBackendSyncID: "b-b"})
	require.NoError(t, err)

	assert.Nil(t, plan.Chosen, "挑中的那一档不可用，就不给 Chosen——不换一台去跑")
	require.Len(t, plan.Tiers, 2)
	assert.Equal(t, AvailabilityAvailable, plan.Tiers[0].Availability, "别的档照常如实标可用")
	assert.False(t, plan.Tiers[0].Current)
	assert.Equal(t, AvailabilityOffline, plan.Tiers[1].Availability)
	assert.False(t, plan.Tiers[1].Current)
}

// 指定的档根本不在这条链上（链被改过、浏览器手里那个标识过期了）按找不到拒。
// 同样不回落：回落等于拿一个用户没挑过的目标去跑。
func TestWebDispatchPlan_GivenUnknownTargetBackend_ThenNotFound(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-a": true, "fp-b": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(twoAvailableTiersRows(t), nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-a", Status: 1},
	}, nil)

	_, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-1", TargetBackendSyncID: "b-gone"})
	assert.Error(t, err)
}

// 两档都在线的一条链：b-a 排前、b-b 排后，两台机器上都配了 proj-1 的路径（路径
// 不同，用来验证 cwd 跟着**选中的那一档**走）。三个「改在哪跑」用例共用。
func twoAvailableTiersRows(t *testing.T) []*sync_entity.SyncObject {
	t.Helper()
	return []*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "后端 Agent"})},
		{Kind: sync_entity.KindProject, SyncID: "proj-1", Payload: mustJSON(t, map[string]any{"name": "agentre-server"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-a", AgentredFingerprint: "fp-a",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-b", AgentredFingerprint: "fp-b",
			Payload: mustJSON(t, map[string]any{"type": "codex"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-a", "sort_order": 0})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t2",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-b", "sort_order": 1})},
		{Kind: sync_entity.KindProjectLocation, SyncID: "loc-a", ProjectSyncID: "proj-1",
			AgentredFingerprint: "fp-a", Payload: mustJSON(t, map[string]any{"path": "/srv/agentre-server"})},
		{Kind: sync_entity.KindProjectLocation, SyncID: "loc-b", ProjectSyncID: "proj-1",
			AgentredFingerprint: "fp-b", Payload: mustJSON(t, map[string]any{"path": "/home/wyz/agentre-server"})},
	}
}

// ── R15 派发计划：从 web 给「某 Agent + 某项目」派活，落到哪台 agentred ────────

// 没写运行设备的后端（指纹为空）跳过并如实给理由；离线档给原因；第一档可用的
// agentred 被选中并带上该项目在那台机器上的绝对路径（屏幕 25 呈现 + 派发
// runtime.run 用）。
func TestWebDispatchPlan_GivenDevicelessOfflineAvailable_ThenSkipsDevicelessAndPicksFirstAvailable(t *testing.T) {
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

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-1", ProjectSyncID: "proj-1"})
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 3)

	// 没写运行设备的一档被跳过，不作为可选目标。
	assert.Equal(t, AvailabilityNoDevice, plan.Tiers[0].Availability)
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

// 全部档不可用时不静默失败：逐档给出原因（未指定设备 / 未配对 / 离线 /
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

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-1", ProjectSyncID: "proj-1"})
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 4)

	assert.Equal(t, AvailabilityNoDevice, plan.Tiers[0].Availability)
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

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-1", ProjectSyncID: "proj-1"})
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

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-1", ProjectSyncID: ""})
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

	_, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-missing", ProjectSyncID: ""})
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

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-1", ProjectSyncID: "proj-1"})
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 3)

	// 没写运行设备的那一档照旧跳过。
	assert.Equal(t, AvailabilityNoDevice, plan.Tiers[0].Availability)

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

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{
		UserID: 7, AgentSyncID: "agent-1", ProjectSyncID: "proj-1"})
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

// ── 每端自己的派发顺序：按调用方浏览器的排列重排执行目标链 ──────────────────

func registerSyncStateMock(t *testing.T) *mock_sync_repo.MockSyncStateRepo {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	m := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncState(m)
	t.Cleanup(func() { sync_repo.RegisterSyncState(nil) })
	return m
}

func keysOf[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// execTargetRow 造一行 agent_exec_target 同步对象。载荷里刻意带一个 Go 侧
// agentExecTargetPayload **没有**声明的键（skills_json，R15e 的按档技能授权），
// 因为整行回写会不会把它丢掉，正是下面那条守卫要测的东西。
func execTargetRow(
	id int64, syncID, agentSyncID, backendSyncID string, sortOrder int, skills string,
) *sync_entity.SyncObject {
	return &sync_entity.SyncObject{
		ID: id, UserID: 7, Kind: sync_entity.KindAgentExecTarget, SyncID: syncID,
		Payload: `{"agent_sync_id":"` + agentSyncID + `","backend_sync_id":"` + backendSyncID +
			`","sort_order":` + strconv.Itoa(sortOrder) + `,"skills_json":` + skills + `}`,
		Version: 10,
	}
}

func payloadKey(t *testing.T, payload, key string) any {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal([]byte(payload), &m))
	return m[key]
}

// 重排写的就是账号默认顺序：改的是 sync_objects 里该 Agent 各 agent_exec_target
// 行的 sort_order，没有第二处存储（决策 14）。
//
// **守卫的核心是 skills_json 必须原样活下来。** sync_objects 是整行
// last-write-wins（前置规格决策 4 把字段级合并列为非目标），而 Go 侧的
// agentExecTargetPayload 只声明了三个键 —— 把载荷解进它再 marshal 回去，
// skills_json（R15e 的按档技能授权）会被静默抹掉。这不是一个假想的失误，
// 而是「照着读路径的结构体写写路径」这个最自然的写法的默认结果。
func TestSetExecTargetOrder_GivenPermutation_ThenOnlySortOrderChangesAndSkillsSurvive(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).
		Return([]*sync_entity.SyncObject{
			execTargetRow(1, "t-a", "agent-1", "b-a", 0, `["read"]`),
			execTargetRow(2, "t-b", "agent-1", "b-b", 1, `["write"]`),
			execTargetRow(3, "t-c", "agent-1", "b-c", 2, `[]`),
			// 另一个 Agent 的档：一行都不许动。
			execTargetRow(4, "t-x", "agent-2", "b-x", 0, `["bash"]`),
		}, nil)

	var version int64 = 100
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).DoAndReturn(
		func(context.Context, int64, int64) (int64, error) { version++; return version, nil },
	).AnyTimes()

	saved := map[string]*sync_entity.SyncObject{}
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error {
			saved[o.SyncID] = o
			return nil
		}).AnyTimes()

	// 把 b-b 提到最前，b-a 退到第二；b-c 原地不动。
	require.NoError(t, svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-b", "b-a", "b-c"},
	}))

	// b-c 的 sort_order 没变，因此不该被写 —— 每一次 Save 都要烧掉一个版本号并向
	// 每台桌面端下推一次，为没变的行付这个代价是纯浪费。另一个 Agent 的 t-x 同理，
	// 而且它一开始就不该进这次重排的范围。
	assert.ElementsMatch(t, []string{"t-b", "t-a"}, keysOf(saved))
	assert.Equal(t, float64(0), payloadKey(t, saved["t-b"].Payload, "sort_order"))
	assert.Equal(t, float64(1), payloadKey(t, saved["t-a"].Payload, "sort_order"))

	// 守卫本体：未声明的键原样活下来。
	assert.Equal(t, []any{"read"}, payloadKey(t, saved["t-a"].Payload, "skills_json"))
	assert.Equal(t, []any{"write"}, payloadKey(t, saved["t-b"].Payload, "skills_json"))
	assert.Equal(t, "agent-1", payloadKey(t, saved["t-a"].Payload, "agent_sync_id"))
	assert.Equal(t, "b-a", payloadKey(t, saved["t-a"].Payload, "backend_sync_id"))

	// 版本号由账号序列分配，不沿用旧值。
	assert.Greater(t, saved["t-b"].Version, int64(10))
	assert.Greater(t, saved["t-a"].Version, int64(10))
}

// 重排也是一次「服务端直写」：来源指纹必须记成空串（决策 21「浏览器发起的写不是
// 任何一台机器推上来的」）。留着上一台推它的机器指纹，冲突应答里的
// OverwrittenOriginFingerprint 就会指着那台无辜的机器，而桌面端正是据此向用户交代
// 「你的改动被谁覆盖了」（规格「来源标识」）。
func TestSetExecTargetOrder_ThenRecordsServerAsTheSource(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	pushedByADevice := execTargetRow(1, "t-a", "agent-1", "b-a", 0, `["read"]`)
	pushedByADevice.OriginFingerprint = "fp-42"
	other := execTargetRow(2, "t-b", "agent-1", "b-b", 1, `["write"]`)
	other.OriginFingerprint = "fp-42"
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).
		Return([]*sync_entity.SyncObject{pushedByADevice, other}, nil)

	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(101), nil).AnyTimes()

	saved := map[string]*sync_entity.SyncObject{}
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error {
			saved[o.SyncID] = o
			return nil
		}).AnyTimes()

	require.NoError(t, svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-b", "b-a"},
	}))

	require.Len(t, saved, 2)
	for syncID, row := range saved {
		assert.Equal(t, ServerOriginFingerprint, row.OriginFingerprint,
			"%s 是浏览器排的序，来源不是设备 42", syncID)
	}
}

// 排列指向已经不存在的 backend 时忽略它，其余照排 —— 排列是收敛的偏好，
// 不是权威：浏览器提交的那一刻，别处可能刚删掉一档。
func TestSetExecTargetOrder_GivenStaleBackendInPermutation_ThenItIsIgnored(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).
		Return([]*sync_entity.SyncObject{
			execTargetRow(1, "t-a", "agent-1", "b-a", 0, `[]`),
			execTargetRow(2, "t-b", "agent-1", "b-b", 1, `[]`),
		}, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(101), nil).AnyTimes()

	saved := map[string]*sync_entity.SyncObject{}
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error {
			saved[o.SyncID] = o
			return nil
		}).AnyTimes()

	require.NoError(t, svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, AgentSyncID: "agent-1",
		BackendSyncIDs: []string{"b-gone", "b-b", "b-a"},
	}))

	assert.ElementsMatch(t, []string{"t-a", "t-b"}, keysOf(saved))
	assert.Equal(t, float64(0), payloadKey(t, saved["t-b"].Payload, "sort_order"))
	assert.Equal(t, float64(1), payloadKey(t, saved["t-a"].Payload, "sort_order"))
}

// 没有 backend sync_id 的档钉在原位，不被冲到队尾。
//
// 排列以 backend sync_id 表达，所以一档没有 sync_id 就无从在排列里指代自己
// （frontend/src/lib/execOrder.ts 的 reorderTargets 会把它从提交的排列里滤掉，
// 同时在本地把它钉在原位）。服务端若把「不在排列里」一律当成「未覆盖、补到队尾」，
// 这一档就会在提交后的重新拉取里凭空跳到最后 —— 两端对同一次操作给出不同结果。
//
// 「未覆盖补到队尾」只适用于**能被指代却没被排到**的档（新加的一档）；无从指代的
// 档不属于那一类，它压根没有参与排序的资格，位置也就不该被排序动到。
func TestSetExecTargetOrder_GivenTargetWithoutBackendSyncID_ThenItStaysAtItsIndex(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).
		Return([]*sync_entity.SyncObject{
			execTargetRow(1, "t-a", "agent-1", "b-a", 0, `[]`),
			// 畸形同步载荷：backend_sync_id 为空，无从在排列里指代自己。
			execTargetRow(2, "t-blank", "agent-1", "", 1, `[]`),
			execTargetRow(3, "t-c", "agent-1", "b-c", 2, `[]`),
		}, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(101), nil).AnyTimes()

	saved := map[string]*sync_entity.SyncObject{}
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error {
			saved[o.SyncID] = o
			return nil
		}).AnyTimes()

	require.NoError(t, svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-c", "b-a"},
	}))

	// 可排的两档在空档的前后换位，空档自己仍是第 2 位（sort_order 1，没被写）。
	assert.Equal(t, float64(0), payloadKey(t, saved["t-c"].Payload, "sort_order"))
	assert.Equal(t, float64(2), payloadKey(t, saved["t-a"].Payload, "sort_order"))
	assert.NotContains(t, keysOf(saved), "t-blank", "钉住的档 sort_order 没变，不该被写")
}

// 集合里有、排列里没有的档补到队尾，且相互顺序按原 sort_order 保持 —— 与读路径
// 此前的收敛规则同源，只是现在收敛发生在写入的那一刻。
func TestSetExecTargetOrder_GivenUncoveredTarget_ThenItGoesToTheTail(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).
		Return([]*sync_entity.SyncObject{
			execTargetRow(1, "t-a", "agent-1", "b-a", 0, `[]`),
			execTargetRow(2, "t-new", "agent-1", "b-new", 1, `[]`),
			execTargetRow(3, "t-c", "agent-1", "b-c", 2, `[]`),
		}, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(101), nil).AnyTimes()

	saved := map[string]*sync_entity.SyncObject{}
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error {
			saved[o.SyncID] = o
			return nil
		}).AnyTimes()

	require.NoError(t, svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-c", "b-a"},
	}))

	assert.Equal(t, float64(0), payloadKey(t, saved["t-c"].Payload, "sort_order"))
	assert.Equal(t, float64(1), payloadKey(t, saved["t-a"].Payload, "sort_order"))
	assert.Equal(t, float64(2), payloadKey(t, saved["t-new"].Payload, "sort_order"))
}

// SetExecTargetOrder 也是浏览器对 sync_objects 的直写（决策 14「浏览器排的就是账号
// 默认顺序」）——它比 CreateOrgObject/UpdateOrgObject/DeleteOrgObject 更老，绕开了
// saveOrgRow 自己取版本号，但一样落在「服务端直写（web 组织面）」这一类里：拖拽重排
// 同样要让在线的桌面端立刻看到，不然「只给新路径加信号」的半吊子后果就落在它头上。
func TestSetExecTargetOrder_GivenPermutation_ThenBroadcastsHighestVersion(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	stub := registerAccountChanStub(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).
		Return([]*sync_entity.SyncObject{
			execTargetRow(1, "t-a", "agent-1", "b-a", 0, `[]`),
			execTargetRow(2, "t-b", "agent-1", "b-b", 1, `[]`),
		}, nil)
	var version int64 = 300
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).DoAndReturn(
		func(context.Context, int64, int64) (int64, error) { version++; return version, nil },
	).AnyTimes()
	mObj.EXPECT().Save(ctx, gomock.Any()).Return(nil).AnyTimes()

	require.NoError(t, svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-b", "b-a"},
	}))

	// 两档都换了位置，各烧一个版本号（301, 302）；广播的是这一批里最新的那个。
	assert.Equal(t, []accountChanCall{{accountID: 7, version: 302}}, stub.recordedCalls())
}

// 提交的排列与当前顺序完全一致时没有一行会被写（「位置没变的行不写」），因此也不该
// 广播——没有变化可言，发一条信号只会让在线的桌面端白白多拉一页。
func TestSetExecTargetOrder_GivenNoChanges_ThenNoBroadcast(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	_ = registerSyncStateMock(t) // 没有 EXPECT：取版本号即失败
	stub := registerAccountChanStub(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).
		Return([]*sync_entity.SyncObject{
			execTargetRow(1, "t-a", "agent-1", "b-a", 0, `[]`),
			execTargetRow(2, "t-b", "agent-1", "b-b", 1, `[]`),
		}, nil)

	require.NoError(t, svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-a", "b-b"},
	}))

	assert.Empty(t, stub.recordedCalls())
}

// 广播失败只记录、不回滚已经落库的重排——写入的权威性在数据库，不在通道。
func TestSetExecTargetOrder_GivenBroadcastFails_ThenReorderStillSucceeds(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	stub := registerAccountChanStub(t)
	stub.err = errors.New("redis unreachable")

	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).
		Return([]*sync_entity.SyncObject{
			execTargetRow(1, "t-a", "agent-1", "b-a", 0, `[]`),
			execTargetRow(2, "t-b", "agent-1", "b-b", 1, `[]`),
		}, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(401), nil).AnyTimes()
	mObj.EXPECT().Save(ctx, gomock.Any()).Return(nil).AnyTimes()

	require.NoError(t, svc.SetExecTargetOrder(ctx, SetExecTargetOrderInput{
		UserID: 7, AgentSyncID: "agent-1", BackendSyncIDs: []string{"b-b", "b-a"},
	}))
}

// ── 会话的项目归属（web 统一会话索引，规格 2026-08-17 决策 4）─────────────────

// 归属判定的正例与两条边界：cwd 与**这台机器上**某个项目的路径相等才算命中；
// 同一条路径挂在别的机器上不算；配不上任何项目的会话不产出条目（由调用方归入
// 「未归项目」）。R19 守卫：回给浏览器的东西里一条路径都没有——判定是在这一层
// 用路径做的，路径本身到此为止。
// 项目轴要把项目递归成树，因此除了名字还要父标识、颜色与排序——这几个键同步载荷
// 本来就带（agentre 侧 adapter_project.go），只是这一侧此前只解出了 name。
func TestAccountProjects_GivenNestedProjects_ThenCarriesParentColorAndOrder(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation,
	}).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-parent", Payload: mustJSON(t, map[string]any{
				"name": "后端", "color": "#3B82F6", "sort_order": 0})},
			{Kind: sync_entity.KindProject, SyncID: "proj-child", Payload: mustJSON(t, map[string]any{
				"name": "agentre-server", "color": "#10B981",
				"parent_sync_id": "proj-parent", "sort_order": 2})},
		}, nil)
	// 「未配置」的判据要问账号里有哪些 agentred（决策 9）。
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.AccountProjects(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got, 2)

	byID := map[string]ProjectNodeView{}
	for _, p := range got {
		byID[p.SyncID] = p
	}
	assert.Equal(t, "后端", byID["proj-parent"].Name)
	assert.Equal(t, "#3B82F6", byID["proj-parent"].Color)
	assert.Empty(t, byID["proj-parent"].ParentSyncID)
	assert.Equal(t, "agentre-server", byID["proj-child"].Name)
	assert.Equal(t, "proj-parent", byID["proj-child"].ParentSyncID)
	assert.Equal(t, 2, byID["proj-child"].SortOrder)
}

// 项目图标要和桌面端画的是同一个：同步载荷里的 icon 原样带出来，供 web 的项目轴
// 画「项目色底 + 项目自己的图标」而不是通用文件夹。从没选过图标的项目如实留空，
// 不补一个假默认值——前端落到名字首字母那条兜底认的是「空」。
func TestAccountProjects_GivenIconInPayload_ThenCarriesIconAndEmptyWhenAbsent(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation,
	}).Return(
		[]*sync_entity.SyncObject{
			{Kind: sync_entity.KindProject, SyncID: "proj-with-icon", Payload: mustJSON(t, map[string]any{
				"name": "后端", "icon": "🚀", "color": "#3B82F6"})},
			{Kind: sync_entity.KindProject, SyncID: "proj-no-icon", Payload: mustJSON(t, map[string]any{
				"name": "前端", "color": "#10B981"})},
		}, nil)
	// 「未配置」的判据要问账号里有哪些 agentred（决策 9）。
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.AccountProjects(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got, 2)

	byID := map[string]ProjectNodeView{}
	for _, p := range got {
		byID[p.SyncID] = p
	}
	assert.Equal(t, "🚀", byID["proj-with-icon"].Icon)
	assert.Empty(t, byID["proj-no-icon"].Icon)
}

// ── 浏览器直写组织面（规格 2026-08-18「server 端的组织管理面」）─────────────────

// assertWriteCode 断言一次被拒的写入带的是这个业务码：写通道的每一种拒绝都要能被
// 浏览器分辨（「不能建后端」与「这行不是你的」在界面上是两种完全不同的交代）。
func assertWriteCode(t *testing.T, err error, want int) {
	t.Helper()
	var he *httputils.Error
	require.ErrorAs(t, err, &he)
	assert.Equal(t, want, he.Code)
}

// liveOrgRow 造一行存活的同步对象，载荷由调用方原样给出。
func liveOrgRow(id int64, kind, syncID, payload string) *sync_entity.SyncObject {
	return &sync_entity.SyncObject{
		ID: id, UserID: 7, Kind: kind, SyncID: syncID, Payload: payload,
		Version: 10, OriginFingerprint: "fp-5", Createtime: 1, Updatetime: 1,
	}
}

// 建：三类对象各自由 server 分配同步标识与版本号，落在调用方账号下，来源记空串
// （决策 21：0 = 服务端直写，不是任何一台设备推上来的）。
func TestCreateOrgObject_GivenWritableKinds_ThenServerAllocatesIDVersionAndRecordsItselfAsSource(t *testing.T) {
	cases := []struct {
		name   string
		kind   string
		fields map[string]any
	}{
		{"部门", sync_entity.KindDepartment, map[string]any{"name": "工程"}},
		{"Agent", sync_entity.KindAgent, map[string]any{"name": "前端 Agent", "prompt_json": `{"text":"你是"}`}},
		{"执行目标", sync_entity.KindAgentExecTarget, map[string]any{
			"agent_sync_id": "agent-1", "backend_sync_id": "b-1", "sort_order": 2}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, mObj, _, _, svc := setupWorkspaceTest(t)
			mState := registerSyncStateMock(t)
			if tc.kind == sync_entity.KindAgentExecTarget {
				// 执行目标只能引用**已有**后端，因此这一档的 backend 要先核对存在。
				mObj.EXPECT().Find(ctx, int64(7), "b-1").Return(
					liveOrgRow(9, sync_entity.KindAgentBackend, "b-1", `{"type":"claude_code"}`), nil)
			}
			mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(101), nil)
			var saved *sync_entity.SyncObject
			mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
				func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

			got, err := svc.CreateOrgObject(ctx, OrgWriteInput{UserID: 7, Kind: tc.kind, Fields: tc.fields})
			require.NoError(t, err)
			require.NotNil(t, saved)

			assert.Equal(t, int64(7), saved.UserID, "写入范围只由鉴权上下文里的账号圈定")
			assert.Equal(t, tc.kind, saved.Kind)
			assert.NotEmpty(t, saved.SyncID, "新行的同步标识由 server 分配")
			assert.Equal(t, saved.SyncID, got.SyncID)
			assert.Equal(t, int64(101), saved.Version, "版本号来自账号级单调序列")
			assert.Equal(t, int64(101), got.Version)
			assert.Empty(t, saved.OriginFingerprint, "服务端直写的来源标识是空串")
			assert.Zero(t, saved.DeletedAt)
			assert.Positive(t, saved.SyncUpdatedAt)
			for k, v := range tc.fields {
				assert.EqualValues(t, v, payloadKey(t, saved.Payload, k))
			}
		})
	}
}

// 两次新建拿到的是两个不同的同步标识——同一个标识会让第二次直接覆盖第一次。
func TestCreateOrgObject_GivenTwoCalls_ThenSyncIDsDiffer(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(101), nil).Times(2)
	mObj.EXPECT().Save(ctx, gomock.Any()).Return(nil).Times(2)

	first, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindDepartment, Fields: map[string]any{"name": "工程"}})
	require.NoError(t, err)
	second, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindDepartment, Fields: map[string]any{"name": "设计"}})
	require.NoError(t, err)
	assert.NotEqual(t, first.SyncID, second.SyncID)
}

// 改部门：**载荷里没被这次请求提到的键必须原样活下来**。
//
// sync_objects 是整行 last-write-wins（前置规格决策 4 把字段级合并列为非目标），
// 把载荷解进一个 Go 结构体再 marshal 回去，结构体没声明的键会被静默抹掉——这正是
// SetExecTargetOrder 踩过一次的那个坑（见 withSortOrder 的注释）。因此每一条新写
// 路径各来一份守卫，且都刻意在载荷里放一个**任何 Go 结构体都没声明**的键。
func TestUpdateOrgObject_GivenDepartmentRename_ThenUntouchedKeysSurvive(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "dept-1").Return(liveOrgRow(1, sync_entity.KindDepartment, "dept-1",
		`{"name":"工程","description":"原简介","icon":"🏢","accent_color":"#3B6896",`+
			`"lead_agent_sync_id":"agent-1","sort_order":3,"future_key_from_a_newer_desktop":"保留我"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(102), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	got, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindDepartment, SyncID: "dept-1",
		Fields: map[string]any{"name": "平台工程"}})
	require.NoError(t, err)
	require.NotNil(t, saved)

	assert.Equal(t, "平台工程", payloadKey(t, saved.Payload, "name"))
	assert.Equal(t, "原简介", payloadKey(t, saved.Payload, "description"))
	assert.Equal(t, "🏢", payloadKey(t, saved.Payload, "icon"))
	assert.Equal(t, "#3B6896", payloadKey(t, saved.Payload, "accent_color"))
	assert.Equal(t, "agent-1", payloadKey(t, saved.Payload, "lead_agent_sync_id"))
	assert.EqualValues(t, 3, payloadKey(t, saved.Payload, "sort_order"))
	assert.Equal(t, "保留我", payloadKey(t, saved.Payload, "future_key_from_a_newer_desktop"))

	assert.Equal(t, int64(102), saved.Version)
	assert.Equal(t, int64(102), got.Version)
	assert.Equal(t, "dept-1", got.SyncID)
	assert.Empty(t, saved.OriginFingerprint, "改也是服务端直写")
	assert.Zero(t, saved.DeletedAt)
}

// 改 Agent 的名字不抹掉系统提示词与工具授权（规格点名的两个键），也不抹掉一个
// 任何 Go 结构体都没声明的键。
func TestUpdateOrgObject_GivenAgentRename_ThenPromptToolsAndUndeclaredKeysSurvive(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "agent-1").Return(liveOrgRow(2, sync_entity.KindAgent, "agent-1",
		`{"name":"前端 Agent","prompt_json":"{\"text\":\"你是前端\"}","tools_json":"[\"read\",\"write\"]",`+
			`"avatar_hash":"sha256:abc","pinned":true,"future_key_from_a_newer_desktop":"保留我"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(103), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgent, SyncID: "agent-1",
		Fields: map[string]any{"name": "全栈 Agent"}})
	require.NoError(t, err)
	require.NotNil(t, saved)

	assert.Equal(t, "全栈 Agent", payloadKey(t, saved.Payload, "name"))
	assert.Equal(t, `{"text":"你是前端"}`, payloadKey(t, saved.Payload, "prompt_json"))
	assert.Equal(t, `["read","write"]`, payloadKey(t, saved.Payload, "tools_json"))
	assert.Equal(t, "sha256:abc", payloadKey(t, saved.Payload, "avatar_hash"))
	assert.Equal(t, true, payloadKey(t, saved.Payload, "pinned"))
	assert.Equal(t, "保留我", payloadKey(t, saved.Payload, "future_key_from_a_newer_desktop"))
	assert.Empty(t, saved.OriginFingerprint)
}

// 改执行目标的技能授权不抹掉 sort_order（另一条写路径正在写的键）与未声明的键。
func TestUpdateOrgObject_GivenExecTargetSkills_ThenSortOrderAndUndeclaredKeysSurvive(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "t-1").Return(liveOrgRow(3, sync_entity.KindAgentExecTarget, "t-1",
		`{"agent_sync_id":"agent-1","backend_sync_id":"b-1","sort_order":2,"skills_json":"[]",`+
			`"future_key_from_a_newer_desktop":"保留我"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(104), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgentExecTarget, SyncID: "t-1",
		Fields: map[string]any{"skills_json": `["org"]`}})
	require.NoError(t, err)
	require.NotNil(t, saved)

	assert.Equal(t, `["org"]`, payloadKey(t, saved.Payload, "skills_json"))
	assert.EqualValues(t, 2, payloadKey(t, saved.Payload, "sort_order"))
	assert.Equal(t, "agent-1", payloadKey(t, saved.Payload, "agent_sync_id"))
	assert.Equal(t, "b-1", payloadKey(t, saved.Payload, "backend_sync_id"))
	assert.Equal(t, "保留我", payloadKey(t, saved.Payload, "future_key_from_a_newer_desktop"))
	assert.Empty(t, saved.OriginFingerprint)
}

// 删：落墓碑而不是物理删除，墓碑本身也吃一个新版本号（删除要能被下行游标带走），
// 来源同样记 0。
func TestDeleteOrgObject_GivenWritableKinds_ThenTombstonedWithNewVersionAndServerSource(t *testing.T) {
	for _, kind := range []string{
		sync_entity.KindDepartment, sync_entity.KindAgent, sync_entity.KindAgentExecTarget,
	} {
		t.Run(kind, func(t *testing.T) {
			ctx, mObj, _, _, svc := setupWorkspaceTest(t)
			mState := registerSyncStateMock(t)

			mObj.EXPECT().Find(ctx, int64(7), "row-1").Return(
				liveOrgRow(4, kind, "row-1", `{"name":"要删掉的"}`), nil)
			mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(105), nil)
			var saved *sync_entity.SyncObject
			mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
				func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

			got, err := svc.DeleteOrgObject(ctx, OrgWriteInput{UserID: 7, Kind: kind, SyncID: "row-1"})
			require.NoError(t, err)
			require.NotNil(t, saved)

			assert.Positive(t, saved.DeletedAt, "删除落墓碑，不是物理删除")
			assert.Equal(t, int64(105), saved.Version)
			assert.Equal(t, int64(105), got.Version)
			assert.Empty(t, saved.OriginFingerprint)
			assert.Equal(t, `{"name":"要删掉的"}`, saved.Payload, "墓碑保留正文，与设备离开账号那条路径一致")
		})
	}
}

// web 组织面是「谁发信号」三处之一——server 直写之后要把账号级实时通道推进到这一版，
// 建 / 改 / 删各自都得触发，另一台桌面端才不必等 30 秒轮询就看到浏览器这边的改动。
func TestCreateOrgObject_ThenBroadcastsAccountVersion(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	stub := registerAccountChanStub(t)

	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(201), nil)
	mObj.EXPECT().Save(ctx, gomock.Any()).Return(nil)

	_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindDepartment, Fields: map[string]any{"name": "工程"}})
	require.NoError(t, err)

	assert.Equal(t, []accountChanCall{{accountID: 7, version: 201}}, stub.recordedCalls())
}

func TestUpdateOrgObject_ThenBroadcastsAccountVersion(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	stub := registerAccountChanStub(t)

	mObj.EXPECT().Find(ctx, int64(7), "dept-1").Return(
		liveOrgRow(1, sync_entity.KindDepartment, "dept-1", `{"name":"工程"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(202), nil)
	mObj.EXPECT().Save(ctx, gomock.Any()).Return(nil)

	_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindDepartment, SyncID: "dept-1",
		Fields: map[string]any{"name": "平台工程"}})
	require.NoError(t, err)

	assert.Equal(t, []accountChanCall{{accountID: 7, version: 202}}, stub.recordedCalls())
}

func TestDeleteOrgObject_ThenBroadcastsAccountVersion(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	stub := registerAccountChanStub(t)

	mObj.EXPECT().Find(ctx, int64(7), "dept-1").Return(
		liveOrgRow(1, sync_entity.KindDepartment, "dept-1", `{"name":"工程"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(203), nil)
	mObj.EXPECT().Save(ctx, gomock.Any()).Return(nil)

	_, err := svc.DeleteOrgObject(ctx, OrgWriteInput{UserID: 7, Kind: sync_entity.KindDepartment, SyncID: "dept-1"})
	require.NoError(t, err)

	assert.Equal(t, []accountChanCall{{accountID: 7, version: 203}}, stub.recordedCalls())
}

// 建在校验阶段就被拒时不该碰仓储，自然也不该广播——这条既有的拒绝路径本就不烧
// 版本号，写一条断言钉住「没有一次广播」，防止日后有人把广播调用挪到检查之前。
func TestOrgWrite_GivenRejectedBeforeWriting_ThenNoBroadcast(t *testing.T) {
	ctx, _, _, _, svc := setupWorkspaceTest(t)
	stub := registerAccountChanStub(t)

	_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgentBackend, Fields: map[string]any{"name": "x"}})
	require.Error(t, err)

	assert.Empty(t, stub.recordedCalls())
}

// 广播失败只记录、不回滚已经落库的写入——写入的权威性在数据库，不在通道
// （规格「失败处理」）。web 组织面的写入必须照常成功返回。
func TestUpdateOrgObject_GivenBroadcastFails_ThenWriteStillSucceeds(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	stub := registerAccountChanStub(t)
	stub.err = errors.New("redis unreachable")

	mObj.EXPECT().Find(ctx, int64(7), "dept-1").Return(
		liveOrgRow(1, sync_entity.KindDepartment, "dept-1", `{"name":"工程"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(204), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	got, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindDepartment, SyncID: "dept-1",
		Fields: map[string]any{"name": "平台工程"}})

	require.NoError(t, err)
	require.NotNil(t, saved)
	assert.Equal(t, int64(204), got.Version, "写入照常落库，不因广播失败回滚")
}

// 后端在 web 上只读：agent_backend 带着 cli_path 与 env_json（本机可执行文件路径
// 与透传环境变量），浏览器无从知道那台机器上的可执行文件在哪，建出来的档必然不可用。
// 建 / 改 / 删三个动作都必须在碰仓储之前就拒掉（mock 是严格的：任何一次仓储调用
// 都会让这条测试红）。
//
// 项目一族自 2026-08-20 那一轮起**在**这条通道里（它们的载荷全是「指向」，没有一件
// 是机器上的东西），因此不在这份清单里；它们自己的判据在 project_write_test.go 与
// project_location_test.go。剩下的只有 backend 与「压根不是同步组的类型」两种。
func TestOrgWrite_GivenNonWritableKind_ThenRefusedBeforeTouchingTheRepo(t *testing.T) {
	for _, kind := range []string{sync_entity.KindAgentBackend, ""} {
		t.Run("kind="+kind, func(t *testing.T) {
			ctx, _, _, _, svc := setupWorkspaceTest(t)
			in := OrgWriteInput{UserID: 7, Kind: kind, SyncID: "x-1",
				Fields: map[string]any{"name": "x", "cli_path": "/usr/local/bin/claude"}}

			_, err := svc.CreateOrgObject(ctx, in)
			assertWriteCode(t, err, code.OrgKindNotWritable)
			_, err = svc.UpdateOrgObject(ctx, in)
			assertWriteCode(t, err, code.OrgKindNotWritable)
			_, err = svc.DeleteOrgObject(ctx, in)
			assertWriteCode(t, err, code.OrgKindNotWritable)
		})
	}
}

// 跨账号写不进去：行按（账号, 同步标识）取，账号来自鉴权上下文而不是请求体，
// 别的账号的那一行在这里取不到，于是一步都走不到写入。
func TestOrgWrite_GivenObjectOfAnotherAccount_ThenNotFoundAndNothingWritten(t *testing.T) {
	for _, op := range []string{"update", "delete"} {
		t.Run(op, func(t *testing.T) {
			ctx, mObj, _, _, svc := setupWorkspaceTest(t)
			// 严格 mock：没有 NextVersion / Save 的期望，写一次就红。
			mObj.EXPECT().Find(ctx, int64(7), "dept-of-account-8").Return(nil, nil)

			in := OrgWriteInput{UserID: 7, Kind: sync_entity.KindDepartment,
				SyncID: "dept-of-account-8", Fields: map[string]any{"name": "偷改"}}
			var err error
			if op == "update" {
				_, err = svc.UpdateOrgObject(ctx, in)
			} else {
				_, err = svc.DeleteOrgObject(ctx, in)
			}
			assertWriteCode(t, err, code.OrgObjectNotFound)
		})
	}
}

// 同步标识存在但类型对不上（拿部门的标识走 Agent 端点）同样按「找不到」拒，
// 不告诉调用方那个标识其实是什么——写通道不该成为一个探测器。
func TestUpdateOrgObject_GivenKindMismatch_ThenNotFound(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mObj.EXPECT().Find(ctx, int64(7), "dept-1").Return(
		liveOrgRow(1, sync_entity.KindDepartment, "dept-1", `{"name":"工程"}`), nil)

	_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgent, SyncID: "dept-1",
		Fields: map[string]any{"name": "改成 Agent"}})
	assertWriteCode(t, err, code.OrgObjectNotFound)
}

// 墓碑不复活（R6）：已经被删掉的行，改与删都明确拒绝，且都不再吃版本号。
func TestOrgWrite_GivenTombstonedObject_ThenRefusedAsDeleted(t *testing.T) {
	for _, op := range []string{"update", "delete"} {
		t.Run(op, func(t *testing.T) {
			ctx, mObj, _, _, svc := setupWorkspaceTest(t)
			row := liveOrgRow(1, sync_entity.KindDepartment, "dept-1", `{"name":"工程"}`)
			row.DeletedAt = 1700000000000
			mObj.EXPECT().Find(ctx, int64(7), "dept-1").Return(row, nil)

			in := OrgWriteInput{UserID: 7, Kind: sync_entity.KindDepartment, SyncID: "dept-1",
				Fields: map[string]any{"name": "复活"}}
			var err error
			if op == "update" {
				_, err = svc.UpdateOrgObject(ctx, in)
			} else {
				_, err = svc.DeleteOrgObject(ctx, in)
			}
			assertWriteCode(t, err, code.OrgObjectDeleted)
		})
	}
}

// 新建缺必填字段时当场拒：没有名字的部门 / Agent 在桌面端落不了地（实体自己的
// Check 拦下），落成一行同步对象只会让它在每一端都卡着。
func TestCreateOrgObject_GivenMissingRequiredField_ThenRejectedBeforeWriting(t *testing.T) {
	cases := map[string]OrgWriteInput{
		"部门没名字":      {UserID: 7, Kind: sync_entity.KindDepartment, Fields: map[string]any{"icon": "🏢"}},
		"Agent 名字为空": {UserID: 7, Kind: sync_entity.KindAgent, Fields: map[string]any{"name": "  "}},
		"执行目标没有 agent": {UserID: 7, Kind: sync_entity.KindAgentExecTarget,
			Fields: map[string]any{"backend_sync_id": "b-1"}},
		"执行目标没有 backend": {UserID: 7, Kind: sync_entity.KindAgentExecTarget,
			Fields: map[string]any{"agent_sync_id": "agent-1"}},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, _, _, _, svc := setupWorkspaceTest(t)
			_, err := svc.CreateOrgObject(ctx, in)
			assertWriteCode(t, err, code.InvalidParameter)
		})
	}
}

// 执行目标只能引用**已有**后端：引用一个账号里没有的（别人的、或已落墓碑的）
// backend 时拒绝，不落下一档永远不可用的执行目标。
func TestCreateOrgObject_GivenExecTargetReferencingUnknownBackend_ThenRejected(t *testing.T) {
	tombstoned := liveOrgRow(9, sync_entity.KindAgentBackend, "b-gone", `{"type":"claude_code"}`)
	tombstoned.DeletedAt = 1700000000000
	cases := map[string]*sync_entity.SyncObject{
		"账号里没有这一行":  nil,
		"已落墓碑":      tombstoned,
		"标识指向的不是后端": liveOrgRow(9, sync_entity.KindAgent, "b-gone", `{"name":"其实是个 Agent"}`),
	}
	for name, found := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, mObj, _, _, svc := setupWorkspaceTest(t)
			mObj.EXPECT().Find(ctx, int64(7), "b-gone").Return(found, nil)

			_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
				UserID: 7, Kind: sync_entity.KindAgentExecTarget,
				Fields: map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-gone"}})
			assertWriteCode(t, err, code.OrgBackendNotFound)
		})
	}
}

// ── 浏览器读组织面（规格 2026-08-18「server 端的组织管理面」）─────────────────
//
// 写通道在上面，读侧在这里：浏览器仅凭会话就要读到索引与详情要画的全部材料。
// 索引要部门（含空部门与父子关系）与 Agent 行，详情要 Agent 的完整组织字段、
// 每档执行目标（含技能）以及「配一档时能挑哪些后端」。

// orgRow 造一行存活的组织类同步对象。
func orgRow(t *testing.T, kind, syncID string, payload map[string]any) *sync_entity.SyncObject {
	t.Helper()
	return &sync_entity.SyncObject{Kind: kind, SyncID: syncID, Payload: mustJSON(t, payload)}
}

// 空部门照常摆组头（规格「索引」决策 13）：一个部门有没有 Agent 与它在不在索引里
// 无关——按「有 Agent 的部门」反推组头，空部门就会从界面上整个消失，用户也就再也
// 拖不进去东西。父子关系同样必须读得到：组头按 parent 递归缩进。
func TestOrgChart_GivenEmptyAndNestedDepartments_ThenAllOfThemAreReadableWithHierarchy(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		orgRow(t, sync_entity.KindDepartment, "dept-eng", map[string]any{
			"name": "工程", "description": "写代码的", "icon": "code", "accent_color": "#3B6896",
			"lead_agent_sync_id": "agent-1", "sort_order": 1,
		}),
		orgRow(t, sync_entity.KindDepartment, "dept-fe", map[string]any{
			"name": "前端", "parent_sync_id": "dept-eng", "sort_order": 2,
		}),
		orgRow(t, sync_entity.KindDepartment, "dept-empty", map[string]any{
			"name": "还没人的部门", "sort_order": 0,
		}),
		orgRow(t, sync_entity.KindAgent, "agent-1", map[string]any{
			"name": "老王", "department_sync_id": "dept-eng",
		}),
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.OrgChart(ctx, 7)
	require.NoError(t, err)

	ids := make([]string, 0, len(got.Departments))
	for _, d := range got.Departments {
		ids = append(ids, d.SyncID)
	}
	assert.Equal(t, []string{"dept-empty", "dept-eng", "dept-fe"}, ids,
		"一个 Agent 都没有的部门也要在，且按 sort_order 排")

	eng := got.Departments[1]
	assert.Equal(t, "工程", eng.Name)
	assert.Equal(t, "写代码的", eng.Description)
	assert.Equal(t, "code", eng.Icon)
	assert.Equal(t, "#3B6896", eng.AccentColor)
	assert.Equal(t, "agent-1", eng.LeadAgentSyncID, "组头上的 Lead")
	assert.Empty(t, eng.ParentSyncID)
	assert.Equal(t, "dept-eng", got.Departments[2].ParentSyncID, "子部门缩在父部门里")
}

// 详情的字段集合与桌面端一致（规格「详情」：没有新增也没有删除）——身份栏的名称 /
// 简介 / 头像 / 配色 / 归属，行为栏的系统提示词与工具授权，一个都不能少，
// 否则 server 那一面画不出同形的详情。归属二选一的两个键都要如实带出：
// 界面靠它们把下拉停在正确的那一组上。
func TestOrgChart_GivenAgent_ThenCarriesEveryFieldTheDetailEdits(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		orgRow(t, sync_entity.KindAgent, "agent-1", map[string]any{
			"name": "前端 Agent", "description": "管样式的", "avatar_color": "#3B6896",
			"avatar_icon": "sparkles", "system_badge": "", "department_sync_id": "dept-1",
			"sort_order": 3, "prompt_json": `{"text":"你是一个前端"}`,
			"tools_json": `{"granted":["org"]}`,
		}),
		orgRow(t, sync_entity.KindAgent, "agent-sub", map[string]any{
			"name": "下属 Agent", "parent_agent_sync_id": "agent-1", "sort_order": 1,
		}),
		orgRow(t, sync_entity.KindAgent, "agent-system", map[string]any{
			"name": "系统 Agent", "system_badge": "default", "sort_order": 2,
		}),
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.OrgChart(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got.Agents, 3)

	byID := map[string]OrgAgentView{}
	for _, a := range got.Agents {
		byID[a.SyncID] = a
	}
	lead := byID["agent-1"]
	assert.Equal(t, "前端 Agent", lead.Name)
	assert.Equal(t, "管样式的", lead.Description)
	assert.Equal(t, "#3B6896", lead.AvatarColor)
	assert.Equal(t, "sparkles", lead.AvatarIcon)
	assert.Equal(t, "dept-1", lead.DepartmentSyncID)
	assert.Empty(t, lead.ParentAgentSyncID)
	assert.Equal(t, 3, lead.SortOrder)
	assert.Equal(t, `{"text":"你是一个前端"}`, lead.PromptJSON, "行为栏的系统提示词")
	assert.Equal(t, `{"granted":["org"]}`, lead.ToolsJSON, "行为栏的工具授权")

	assert.Equal(t, "agent-1", byID["agent-sub"].ParentAgentSyncID, "行内的「↳ 主管」")
	assert.Empty(t, byID["agent-sub"].DepartmentSyncID, "归属二选一：挂上级时部门为空")
	assert.Equal(t, "default", byID["agent-system"].SystemBadge, "系统 Agent 单独置顶一行")
}

// 执行目标一档一行：行上要有机器、后端与状态摘要，技能折在行内（规格「详情」）。
// 每档还要带自己的同步标识——改技能授权与删掉这一档都按它定位，缺了它详情就只
// 读得出来、改不动。
func TestOrgChart_GivenExecTargets_ThenEachTierCarriesBackendStatusAndSkills(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-online": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		orgRow(t, sync_entity.KindAgent, "agent-1", map[string]any{"name": "前端 Agent"}),
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-offline", AgentredFingerprint: "fp-offline",
			Payload: mustJSON(t, map[string]any{"type": "claude_code", "name": "书房的 Claude"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-online", AgentredFingerprint: "fp-online",
			Payload: mustJSON(t, map[string]any{"type": "codex", "name": "公司的 Codex"})},
		orgRow(t, sync_entity.KindAgentExecTarget, "target-2", map[string]any{
			"agent_sync_id": "agent-1", "backend_sync_id": "backend-online", "sort_order": 2,
			"skills_json": `{"granted":["web-search"]}`,
		}),
		orgRow(t, sync_entity.KindAgentExecTarget, "target-1", map[string]any{
			"agent_sync_id": "agent-1", "backend_sync_id": "backend-offline", "sort_order": 1,
		}),
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-offline", Status: 1},
		{ID: 21, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-online", Status: 1},
	}, nil)

	got, err := svc.OrgChart(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got.Agents, 1)
	targets := got.Agents[0].ExecTargets
	require.Len(t, targets, 2)

	assert.Equal(t, "target-1", targets[0].SyncID, "按 sort_order，且带自己的同步标识")
	assert.Equal(t, 1, targets[0].Rank)
	assert.Equal(t, "backend-offline", targets[0].BackendSyncID)
	assert.Equal(t, "书房的 Claude", targets[0].BackendName)
	assert.Equal(t, "claude_code", targets[0].BackendType)
	assert.Equal(t, "书房小主机", targets[0].DeviceName)
	assert.Equal(t, int64(20), targets[0].DeviceID)
	assert.Equal(t, AvailabilityOffline, targets[0].Availability, "不可用的档留在列表里并给出原因")
	assert.False(t, targets[0].Current)
	assert.Empty(t, targets[0].SkillsJSON)

	assert.Equal(t, "target-2", targets[1].SyncID)
	assert.Equal(t, AvailabilityAvailable, targets[1].Availability)
	assert.True(t, targets[1].Current, "当前生效的一档在视觉上与其余区分")
	assert.Equal(t, `{"granted":["web-search"]}`, targets[1].SkillsJSON, "技能折在行内")
}

// 配一档执行目标时浏览器要挑一个后端：能挑的就是账号里**已有**的那些
// （规格「后端是机器的，浏览器只能引用，不能创建或编辑」）。每一项要说清楚它在哪台
// 机器上、此刻能不能用——否则用户挑完才发现那台机器根本不在了。
func TestSelectableBackends_GivenBackendsAcrossMachines_ThenEachCarriesMachineAndStatus(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-online": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-online", AgentredFingerprint: "fp-online",
			Payload: mustJSON(t, map[string]any{"type": "codex", "name": "公司的 Codex"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-offline", AgentredFingerprint: "fp-offline",
			Payload: mustJSON(t, map[string]any{"type": "claude_code", "name": "书房的 Claude"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-gone", AgentredFingerprint: "fp-unknown",
			Payload: mustJSON(t, map[string]any{"type": "claude_code", "name": "已经离开账号的那台"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-local", AgentredFingerprint: "",
			Payload: mustJSON(t, map[string]any{"type": "claude_code", "name": "没写运行设备的那个"})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-offline", Status: 1},
		{ID: 21, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-online", Status: 1},
	}, nil)

	got, err := svc.SelectableBackends(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got, 4, "不可用的档也留在清单里，隐藏了用户不知道为什么轮不到它")

	byID := map[string]OrgBackendView{}
	for _, b := range got {
		byID[b.SyncID] = b
	}
	assert.Equal(t, "公司的 Codex", byID["backend-online"].Name)
	assert.Equal(t, "codex", byID["backend-online"].BackendType)
	assert.Equal(t, int64(21), byID["backend-online"].DeviceID)
	assert.Equal(t, "公司 Mac mini", byID["backend-online"].DeviceName)
	assert.Equal(t, AvailabilityAvailable, byID["backend-online"].Availability)

	assert.Equal(t, AvailabilityOffline, byID["backend-offline"].Availability)
	assert.Equal(t, "书房小主机", byID["backend-offline"].DeviceName)
	assert.Equal(t, AvailabilityUnpaired, byID["backend-gone"].Availability)
	assert.Empty(t, byID["backend-gone"].DeviceName)
	assert.True(t, byID["backend-local"].IsLocalReference)
	assert.Equal(t, AvailabilityNoDevice, byID["backend-local"].Availability)
}

// 判据这一侧的守卫（规格 2026-08-21「同步与身份」）：一个后端在哪台机器上、此刻
// 能不能用，全部由它那一列 agentred_fingerprint 决定——在账号里且活跃且在线为可用，
// 在账号里但不在线为离线，指纹在账号下找不到设备为「已撤销」（沿用 unpaired，
// 组织面文案不变），**空指纹为「未指定设备」**：它只可能是决策 14 的存量，
// 不再复用 skipped_for_web 那条「跳过桌面端本机档」的语义。
//
// 这里断言的是**线上取值本身**而不是常量：浏览器按这几个字符串分支，改掉任何一个
// 都是改契约，得让它在这里红一次。
func TestSelectableBackends_GivenFingerprintVerdicts_ThenEmptyFingerprintIsNoDeviceNotSkippedForWeb(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-online": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-online", AgentredFingerprint: "fp-online",
			Payload: mustJSON(t, map[string]any{"type": "codex", "name": "在线那台"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-offline", AgentredFingerprint: "fp-offline",
			Payload: mustJSON(t, map[string]any{"type": "claude_code", "name": "离线那台"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-revoked", AgentredFingerprint: "fp-revoked",
			Payload: mustJSON(t, map[string]any{"type": "claude_code", "name": "撤销掉的那台"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-nodevice", AgentredFingerprint: "",
			Payload: mustJSON(t, map[string]any{"type": "claude_code", "name": "没写设备的存量"})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-offline", Status: 1},
		{ID: 21, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-online", Status: 1},
	}, nil)

	got, err := svc.SelectableBackends(ctx, 7)
	require.NoError(t, err)
	byID := map[string]OrgBackendView{}
	for _, b := range got {
		byID[b.SyncID] = b
	}
	require.Len(t, byID, 4)

	assert.Equal(t, "available", byID["b-online"].Availability)
	assert.Equal(t, "offline", byID["b-offline"].Availability)
	assert.Equal(t, "unpaired", byID["b-revoked"].Availability,
		"指纹在账号下找不到设备 = 已撤销，与执行目标那一侧同一条判据")
	assert.Empty(t, byID["b-revoked"].DeviceName, "不知道是哪台机器，不编一个")

	assert.Equal(t, "no_device", byID["b-nodevice"].Availability,
		"空指纹是「未指定设备」，不是「跳过桌面端本机档」")
	assert.NotEqual(t, "skipped_for_web", byID["b-nodevice"].Availability)
	assert.Empty(t, byID["b-nodevice"].DeviceName)
	assert.Zero(t, byID["b-nodevice"].DeviceID)
}

// R19 守卫（值这一侧）：即便后端载荷里就摆着 cli_path 与 env_json，组织面读侧
// 序列化后也绝不能带出这两个键或它们的值——因为这几个视图类型一开始就没有能装下
// 它们的字段。挑后端的那个清单是本轮最吃紧的一处：它是**专门**用来呈现后端的。
func TestOrgReads_NeverCarryCLIPathOrEnvJSON(t *testing.T) {
	backendRows := func() []*sync_entity.SyncObject {
		return []*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindAgent, "agent-1", map[string]any{"name": "运维 Agent"}),
			{Kind: sync_entity.KindAgentBackend, SyncID: "backend-1", AgentredFingerprint: "",
				Payload: mustJSON(t, map[string]any{
					"type": "claude_code", "name": "本机 Claude",
					"cli_path": "/Users/alice/.local/bin/claude",
					"env_json": `{"OPENAI_API_KEY":"sk-super-secret"}`,
				})},
			orgRow(t, sync_entity.KindAgentExecTarget, "target-1", map[string]any{
				"agent_sync_id": "agent-1", "backend_sync_id": "backend-1", "sort_order": 0,
			}),
		}
	}

	t.Run("OrgChart", func(t *testing.T) {
		ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
		mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(backendRows(), nil)
		mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

		got, err := svc.OrgChart(ctx, 7)
		require.NoError(t, err)
		assertNoMachineLocalSecret(t, mustJSON(t, got))
	})

	t.Run("SelectableBackends", func(t *testing.T) {
		ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
		mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(backendRows(), nil)
		mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

		got, err := svc.SelectableBackends(ctx, 7)
		require.NoError(t, err)
		assertNoMachineLocalSecret(t, mustJSON(t, got))
	})
}

func assertNoMachineLocalSecret(t *testing.T, out string) {
	t.Helper()
	assert.NotContains(t, out, "/Users/alice")
	assert.NotContains(t, out, "sk-super-secret")
	assert.NotContains(t, out, "cli_path")
	assert.NotContains(t, out, "env_json")
}

// R19 守卫（类型这一侧，规格点名的那条「本轮新增的每一个发往浏览器的视图都要沿用
// 同一种守法」）：守的不是「这一次没填」，而是**类型上根本没有能装下它的字段**。
// 上面那条值守卫只看这一次的取值，给视图加一个 CLIPath 字段而这次恰好为空，它照样
// 绿；这一条不会——它逐字段扫类型本身。
//
// 两个方向都测（docs/testing.md「Guard tests」）：真实视图必须一条都不命中，而一个
// 故意违规的探针必须**被抓到**——只测前者的话，一个什么都发现不了的探测器同样绿。
func TestOrgViews_HaveNoFieldThatCouldHoldAMachineLocalSecret(t *testing.T) {
	for _, view := range []any{
		OrgChartView{}, OrgDepartmentView{}, OrgAgentView{}, OrgExecTargetView{}, OrgBackendView{},
	} {
		typ := reflect.TypeOf(view)
		t.Run(typ.Name(), func(t *testing.T) {
			assert.Empty(t, machineLocalFields(typ),
				"%s 上出现了能装下机器本地路径 / 环境变量的字段：R19 的守法是结构性的", typ.Name())
		})
	}

	// 反向：探针类型必须被抓到，否则上面那一片绿只说明扫描器坏了。
	type violatingProbe struct {
		Name    string
		CLIPath string
		EnvJSON string
	}
	assert.ElementsMatch(t, []string{"CLIPath", "EnvJSON"},
		machineLocalFields(reflect.TypeOf(violatingProbe{})),
		"扫描器自己必须能抓到违规字段")
}

// machineLocalFields 深走一个视图类型，回所有「名字就说明它装的是机器上的东西」的
// 字段。禁词只有这三个：R19 的红线是**本机可执行文件路径与透传环境变量**
// （规格「后端是机器的」），不是「凡是敏感的都不许」。
func machineLocalFields(typ reflect.Type) []string {
	for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct {
		return nil
	}
	var out []string
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		lower := strings.ToLower(field.Name)
		for _, forbidden := range []string{"path", "cli", "env"} {
			if strings.Contains(lower, forbidden) {
				out = append(out, field.Name)
				break
			}
		}
		out = append(out, machineLocalFields(field.Type)...)
	}
	return out
}

// 读的范围同样只由鉴权上下文里的账号圈定（与 aee3a85 的九条写路径同一条判据）：
// 仓储按账号取行，别的账号的组织架构在这里读不到——一行都读不到，而不是「读到了
// 再过滤」。断言两件事：问仓储时带的是**调用方**的账号，以及回来的确实是空。
func TestOrgReads_GivenAnotherAccount_ThenNothingIsReadable(t *testing.T) {
	const owner, stranger = int64(7), int64(8)
	rowsOf := func(userID int64, _ []string) []*sync_entity.SyncObject {
		if userID != owner {
			return nil
		}
		return []*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindDepartment, "dept-1", map[string]any{"name": "工程"}),
			orgRow(t, sync_entity.KindAgent, "agent-1", map[string]any{"name": "老王"}),
			{Kind: sync_entity.KindAgentBackend, SyncID: "backend-1", AgentredFingerprint: "fp-1",
				Payload: mustJSON(t, map[string]any{"type": "codex", "name": "公司的 Codex"})},
		}
	}

	t.Run("OrgChart", func(t *testing.T) {
		ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
		var asked []int64
		mObj.EXPECT().ListByKinds(ctx, gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, userID int64, kinds []string) ([]*sync_entity.SyncObject, error) {
				asked = append(asked, userID)
				return rowsOf(userID, kinds), nil
			})
		mDev.EXPECT().ListByUser(ctx, stranger).Return(nil, nil)

		got, err := svc.OrgChart(ctx, stranger)
		require.NoError(t, err)
		assert.Equal(t, []int64{stranger}, asked, "问仓储时带的必须是调用方的账号")
		assert.Empty(t, got.Departments)
		assert.Empty(t, got.Agents)
	})

	t.Run("SelectableBackends", func(t *testing.T) {
		ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
		var asked []int64
		mObj.EXPECT().ListByKinds(ctx, gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, userID int64, kinds []string) ([]*sync_entity.SyncObject, error) {
				asked = append(asked, userID)
				return rowsOf(userID, kinds), nil
			})
		mDev.EXPECT().ListByUser(ctx, stranger).Return(nil, nil)

		got, err := svc.SelectableBackends(ctx, stranger)
		require.NoError(t, err)
		assert.Equal(t, []int64{stranger}, asked)
		assert.Empty(t, got)
	})
}

// ── 系统 Agent 在 web 写通道上的不可变性（复核补） ────────────────────────────
//
// 桌面端把「系统 Agent 不能删、不能挪」判在服务端（agent_svc.Delete / Move 的
// AgentSystemImmutable），web 这条写通道此前只有一个禁用按钮拦着。禁用按钮不是
// 判据：`curl` 一下就绕过去了，而落下去的那一条墓碑会经下行游标到达每一台桌面端，
// 在那里走 adapter.remove → agent_repo.Delete —— 那条路**不过** IsSystem() 那道闸。
// 后果是账号里的 CEO 助手在所有设备上一起消失，且再也建不回来（system_badge 只由
// 迁移 seed 写入，两端的建 Agent 都不接受它），此后凡是要用它兜底的地方
// （FindSystem：删根部门时给孤儿 Agent 找上级）都永久报 AgentParentNotFound。

func TestDeleteOrgObject_GivenSystemAgent_ThenRefusedBeforeWriting(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)

	mObj.EXPECT().Find(ctx, int64(7), "agent-system").Return(
		liveOrgRow(4, sync_entity.KindAgent, "agent-system",
			`{"name":"CEO 助手","system_badge":"DEFAULT"}`), nil)
	// NextVersion / Save 一次都不该发生：拒绝要在烧掉版本号之前。

	_, err := svc.DeleteOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgent, SyncID: "agent-system"})
	assertWriteCode(t, err, code.OrgSystemAgentImmutable)
}

// 挪也不行：实体层只认「系统 Agent 既不属于部门也没有上级」这一种形状
// （agent_entity.Agent.Check 的 AgentSystemImmutable），给它写上归属就是在往每一台
// 桌面端推一行它自己校验不过的数据。改名、改简介、改提示词照常放行——桌面端也只拦
// 删与挪这两件事，两端的判据要一样宽。
func TestUpdateOrgObject_GivenSystemAgentPlacement_ThenRefusedButRenameStillWorks(t *testing.T) {
	systemAgent := func() *sync_entity.SyncObject {
		return liveOrgRow(4, sync_entity.KindAgent, "agent-system",
			`{"name":"CEO 助手","system_badge":"DEFAULT"}`)
	}

	for name, fields := range map[string]map[string]any{
		"挪进部门":  {"department_sync_id": "dept-1"},
		"挂到上级下": {"parent_agent_sync_id": "agent-2"},
	} {
		t.Run(name, func(t *testing.T) {
			ctx, mObj, _, _, svc := setupWorkspaceTest(t)
			mObj.EXPECT().Find(ctx, int64(7), "agent-system").Return(systemAgent(), nil)

			_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
				UserID: 7, Kind: sync_entity.KindAgent, SyncID: "agent-system", Fields: fields})
			assertWriteCode(t, err, code.OrgSystemAgentImmutable)
		})
	}

	t.Run("显式清空归属照常放行", func(t *testing.T) {
		ctx, mObj, _, _, svc := setupWorkspaceTest(t)
		mState := registerSyncStateMock(t)
		mObj.EXPECT().Find(ctx, int64(7), "agent-system").Return(systemAgent(), nil)
		mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(120), nil)
		mObj.EXPECT().Save(ctx, gomock.Any()).Return(nil)

		_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
			UserID: 7, Kind: sync_entity.KindAgent, SyncID: "agent-system",
			Fields: map[string]any{"department_sync_id": "", "parent_agent_sync_id": ""}})
		require.NoError(t, err)
	})

	t.Run("改名照常放行", func(t *testing.T) {
		ctx, mObj, _, _, svc := setupWorkspaceTest(t)
		mState := registerSyncStateMock(t)
		mObj.EXPECT().Find(ctx, int64(7), "agent-system").Return(systemAgent(), nil)
		mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(121), nil)
		var saved *sync_entity.SyncObject
		mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
			func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

		_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
			UserID: 7, Kind: sync_entity.KindAgent, SyncID: "agent-system",
			Fields: map[string]any{"name": "总助"}})
		require.NoError(t, err)
		require.NotNil(t, saved)
		assert.Contains(t, saved.Payload, `"name":"总助"`)
		assert.Contains(t, saved.Payload, `"system_badge":"DEFAULT"`, "徽标本身不该被这次改动碰到")
	})
}

// 普通 Agent 不受这道闸影响。
func TestDeleteOrgObject_GivenOrdinaryAgent_ThenStillTombstoned(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "agent-1").Return(
		liveOrgRow(4, sync_entity.KindAgent, "agent-1", `{"name":"张三","system_badge":""}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(130), nil)
	mObj.EXPECT().Save(ctx, gomock.Any()).Return(nil)

	_, err := svc.DeleteOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgent, SyncID: "agent-1"})
	require.NoError(t, err)
}

// ── 新建执行目标落在链尾（复核补） ────────────────────────────────────────────
//
// 请求没提 sort_order 时，此前落下去的载荷里根本没有这个键，读侧解出来就是 0 ——
// 与链头（SetExecTargetOrder 写的是 0 基下标）打平。打平之后谁在前由 ListByKinds
// 的返回顺序决定，而那条查询没有 ORDER BY：同一份数据两次读取可以给出不同的
// 「当前生效」档，也就可能把用户排在第一位的那台机器挤掉。
func TestCreateOrgObject_GivenExecTargetWithoutSortOrder_ThenItLandsAtTheTailOfTheChain(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "b-new").Return(
		liveOrgRow(9, sync_entity.KindAgentBackend, "b-new", `{"type":"claude_code"}`), nil)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).Return(
		[]*sync_entity.SyncObject{
			liveOrgRow(1, sync_entity.KindAgentExecTarget, "t-1",
				`{"agent_sync_id":"agent-1","backend_sync_id":"b-1","sort_order":0}`),
			liveOrgRow(2, sync_entity.KindAgentExecTarget, "t-2",
				`{"agent_sync_id":"agent-1","backend_sync_id":"b-2","sort_order":1}`),
			// 别的 Agent 的链不参与这次计数。
			liveOrgRow(3, sync_entity.KindAgentExecTarget, "t-3",
				`{"agent_sync_id":"agent-9","backend_sync_id":"b-3","sort_order":7}`),
		}, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(140), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgentExecTarget,
		Fields: map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-new"}})
	require.NoError(t, err)
	require.NotNil(t, saved)

	var got map[string]any
	require.NoError(t, json.Unmarshal([]byte(saved.Payload), &got))
	assert.InDelta(t, float64(2), got["sort_order"], 0, "接在 agent-1 那条链的末尾，不与链头打平")
}

// 链上一档都没有时从 0 开始，且不为此多问一次仓储以外的东西。
func TestCreateOrgObject_GivenFirstExecTargetOfAnAgent_ThenSortOrderZero(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "b-new").Return(
		liveOrgRow(9, sync_entity.KindAgentBackend, "b-new", `{"type":"claude_code"}`), nil)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindAgentExecTarget}).Return(nil, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(141), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgentExecTarget,
		Fields: map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-new"}})
	require.NoError(t, err)
	require.NotNil(t, saved)

	var got map[string]any
	require.NoError(t, json.Unmarshal([]byte(saved.Payload), &got))
	assert.InDelta(t, float64(0), got["sort_order"], 0)
}

// 请求显式给了 sort_order 就照给的写：0 是一个**有意的**值（插到队首），
// 「没提到」与「显式传 0」在这条写通道上必须可分辨。
func TestCreateOrgObject_GivenExplicitSortOrder_ThenItIsHonoured(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "b-new").Return(
		liveOrgRow(9, sync_entity.KindAgentBackend, "b-new", `{"type":"claude_code"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(142), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgentExecTarget,
		Fields: map[string]any{
			"agent_sync_id": "agent-1", "backend_sync_id": "b-new", "sort_order": 0}})
	require.NoError(t, err)
	require.NotNil(t, saved)

	var got map[string]any
	require.NoError(t, json.Unmarshal([]byte(saved.Payload), &got))
	assert.InDelta(t, float64(0), got["sort_order"], 0)
}

// 每一档还要带上它所在那台机器的 agentred 指纹：浏览器的中继是点对点的
// （`/v1/relay/client?daemon_fingerprint=…`），没有指纹就拨不到那台机器，也就
// 问不出「这一档的后端上到底装了哪些技能包」。设备标识（device_id）在中继上
// 指不到任何东西——中继认的是指纹。
//
// 没写运行设备的档与指向不存在后端的档不带指纹：前者没指到任何一台机器，后者根本
// 不知道是哪台机器。两种都留空而不是编一个。
func TestOrgChart_GivenExecTargets_ThenEachTierCarriesTheMachineFingerprintToDial(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-online": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		orgRow(t, sync_entity.KindAgent, "agent-1", map[string]any{"name": "前端 Agent"}),
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-local", AgentredFingerprint: "",
			Payload: mustJSON(t, map[string]any{"type": "claudecode", "name": "没写运行设备的那个"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-offline", AgentredFingerprint: "fp-offline",
			Payload: mustJSON(t, map[string]any{"type": "claudecode", "name": "书房的 Claude"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "backend-online", AgentredFingerprint: "fp-online",
			Payload: mustJSON(t, map[string]any{"type": "codex", "name": "公司的 Codex"})},
		orgRow(t, sync_entity.KindAgentExecTarget, "t-local", map[string]any{
			"agent_sync_id": "agent-1", "backend_sync_id": "backend-local", "sort_order": 1}),
		orgRow(t, sync_entity.KindAgentExecTarget, "t-offline", map[string]any{
			"agent_sync_id": "agent-1", "backend_sync_id": "backend-offline", "sort_order": 2}),
		orgRow(t, sync_entity.KindAgentExecTarget, "t-online", map[string]any{
			"agent_sync_id": "agent-1", "backend_sync_id": "backend-online", "sort_order": 3}),
		orgRow(t, sync_entity.KindAgentExecTarget, "t-gone", map[string]any{
			"agent_sync_id": "agent-1", "backend_sync_id": "backend-deleted", "sort_order": 4}),
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 20, UserID: 7, Name: "书房小主机", Kind: device_entity.KindAgentred, Fingerprint: "fp-offline", Status: 1},
		{ID: 21, UserID: 7, Name: "公司 Mac mini", Kind: device_entity.KindAgentred, Fingerprint: "fp-online", Status: 1},
	}, nil)

	got, err := svc.OrgChart(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got.Agents, 1)
	byID := map[string]OrgExecTargetView{}
	for _, tg := range got.Agents[0].ExecTargets {
		byID[tg.SyncID] = tg
	}
	require.Len(t, byID, 4)

	assert.Equal(t, "fp-online", byID["t-online"].DeviceFingerprint, "在线的档：拨得到，带指纹")
	assert.Equal(t, "fp-offline", byID["t-offline"].DeviceFingerprint,
		"离线只是此刻拨不通，指纹仍是这台机器的身份——不因为离线就抹掉")
	assert.Empty(t, byID["t-local"].DeviceFingerprint, "没写运行设备的档指不到任何一台机器")
	assert.True(t, byID["t-local"].IsLocalReference,
		"后端行还在、只是没写设备：与「后端已不在」区分开，档上如实标「未指定设备」")
	assert.Equal(t, AvailabilityNoDevice, byID["t-local"].Availability)
	assert.Empty(t, byID["t-gone"].DeviceFingerprint, "后端已不在：不知道是哪台机器，不编一个")
}
