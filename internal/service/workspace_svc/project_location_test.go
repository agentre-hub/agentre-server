package workspace_svc

import (
	"context"
	"reflect"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

// ── 项目 × 机器的路径（规格 2026-08-20「路径与 R19」「选目录时会看到什么」）────────
//
// 这是本轮唯一动到 R19 的地方，收窄成按对象的三条：镜像会话的 cwd 与 backend 的
// cli_path / env_json 仍然永不下发，只有 project_location.path 在项目设置这一处
// 逐条下发——**改不了一个看不见的值**。
//
// 两类设备的路径存在不同的地方，因此这一屏对它们的口径也不同（决策 4）：
// agentred 的路径是账号级同步对象，可读可写；桌面端的本机路径只在上报组、整份快照
// 替换，因此只给「已配置」这个布尔，一个字符都不多，也写不进去。

// agentredDevice / desktopDevice 造一台设备。
func agentredDevice(id int64, name, fingerprint string) *device_entity.Device {
	return &device_entity.Device{
		ID: id, UserID: 7, Name: name, Kind: device_entity.KindAgentred,
		Fingerprint: fingerprint, Status: 1,
	}
}

func desktopDevice(id int64, name, fingerprint string) *device_entity.Device {
	return &device_entity.Device{
		ID: id, UserID: 7, Name: name, Kind: device_entity.KindDesktop,
		Fingerprint: fingerprint, Status: 1,
	}
}

// locationRow 造一行 agentred 的路径记录：自然键在两个**列**上（不在载荷里）。
func locationRow(id int64, syncID, projectSyncID, fingerprint, path string) *sync_entity.SyncObject {
	return &sync_entity.SyncObject{
		ID: id, UserID: 7, Kind: sync_entity.KindProjectLocation, SyncID: syncID,
		ProjectSyncID: projectSyncID, AgentredFingerprint: fingerprint,
		Payload: `{"path":"` + path + `"}`, Version: 10,
	}
}

// agentred 逐条给出路径正文，并带上这条路径记录自己的同步标识——移除一条路径删的是
// 那一行，浏览器没有它就定位不到要删哪一行。
func TestProjectMachines_GivenAgentredWithAPath_ThenCarriesItVerbatimWithItsSyncID(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-1": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7),
		[]string{sync_entity.KindProject, sync_entity.KindProjectLocation}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
			locationRow(5, "pl-1", "proj-1", "fp-1", "/srv/agentre-server"),
		}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(
		[]*device_entity.Device{agentredDevice(1, "build-01", "fp-1")}, nil)

	got, err := svc.ProjectMachines(ctx, 7, "proj-1")
	require.NoError(t, err)
	require.Len(t, got, 1)

	assert.Equal(t, int64(1), got[0].DeviceID)
	assert.Equal(t, "build-01", got[0].DeviceName)
	assert.Equal(t, device_entity.KindAgentred, got[0].Kind)
	assert.Equal(t, "fp-1", got[0].Fingerprint, "目录选择器要靠它拨中继")
	assert.True(t, got[0].Online)
	assert.True(t, got[0].Configured)
	assert.Equal(t, "/srv/agentre-server", got[0].Path)
	assert.Equal(t, "pl-1", got[0].LocationSyncID)
}

// 没配路径的 agentred 如实给「未配置」与空路径——「空」与「没配」在界面上是同一件事，
// 但它必须留在列表里，否则用户没有地方去配它。
func TestProjectMachines_GivenAgentredWithoutAPath_ThenNotConfiguredAndStillListed(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{}})

	mObj.EXPECT().ListByKinds(ctx, int64(7),
		[]string{sync_entity.KindProject, sync_entity.KindProjectLocation}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
			// 别的项目的路径，不该被算到这个项目头上。
			locationRow(5, "pl-other", "proj-2", "fp-1", "/srv/other"),
		}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(
		[]*device_entity.Device{agentredDevice(1, "build-01", "fp-1")}, nil)

	got, err := svc.ProjectMachines(ctx, 7, "proj-1")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.False(t, got[0].Configured)
	assert.Empty(t, got[0].Path)
	assert.Empty(t, got[0].LocationSyncID)
	assert.False(t, got[0].Online, "离线的机器留在列表里并禁用，隐藏会让人以为它没配对")
}

// 桌面端的路径正文照给（规格 2026-08-21 决策 5）：这一屏上它现在改得动，而**改不了
// 一个看不见的值**——这正是 2026-08-20 决策 4 当初拒绝给它按钮的那条理由。
//
// 但正文只能来自**上报组**：同步组里就算有一行指纹撞上这台桌面端，也不该拿它当
// 桌面端的路径。两组数据的流动性不同，混用取到的不是「少几行」而是错的。
//
// `LocationSyncID` 仍然为空：桌面端在同步组里没有那样一行，「移除路径」经中继喊
// 那台机器自己去做，不是删服务端的一行记录（决策 6）。
func TestProjectMachines_GivenDesktop_ThenCarriesTheReportedPathButNothingToDelete(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-d": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7),
		[]string{sync_entity.KindProject, sync_entity.KindProjectLocation}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
			// 就算同步组里有一行指纹撞上桌面端的，也不该拿它当桌面端的路径。
			locationRow(5, "pl-1", "proj-1", "fp-d", "/Users/me/code"),
		}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(
		[]*device_entity.Device{desktopDevice(2, "wangyz-mbp", "fp-d")}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(2)).Return(
		[]*sync_entity.DeviceLocalPath{
			{UserID: 7, DeviceID: 2, ProjectSyncID: "proj-1", Path: "/Users/me/code/agentre"},
		}, nil)

	got, err := svc.ProjectMachines(ctx, 7, "proj-1")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, device_entity.KindDesktop, got[0].Kind)
	assert.True(t, got[0].Configured, "桌面端配没配来自上报组")
	assert.Equal(t, "/Users/me/code/agentre", got[0].Path,
		"正文取自上报组，不是同步组里那行指纹撞上它的记录")
	assert.Empty(t, got[0].LocationSyncID, "桌面端在同步组里没有那样一行，没有可删的标识")
}

// 上报了一条空路径的桌面端**不算配好了**：这一条与索引组头那枚角标的判据
// （`projectsWithARunnablePath` 要求路径正文非空）必须一致——同一件事在两处给出
// 不同结论，就会出现「设置里打绿勾、组头上挂未配置」那种自相矛盾的界面。
func TestProjectMachines_GivenDesktopReportedAnEmptyPath_ThenNotConfigured(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-d": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7),
		[]string{sync_entity.KindProject, sync_entity.KindProjectLocation}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
		}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(
		[]*device_entity.Device{desktopDevice(2, "wangyz-mbp", "fp-d")}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(2)).Return(
		[]*sync_entity.DeviceLocalPath{{UserID: 7, DeviceID: 2, ProjectSyncID: "proj-1", Path: ""}}, nil)

	got, err := svc.ProjectMachines(ctx, 7, "proj-1")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.False(t, got[0].Configured)
	assert.Empty(t, got[0].Path)
}

// 项目不在这个账号下（不存在、别人的、已落墓碑）时不区分，一律 NotFound：
// 区分开就等于给出一个跨账号的存在性探测器。
func TestProjectMachines_GivenUnknownProject_ThenNotFound(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7),
		[]string{sync_entity.KindProject, sync_entity.KindProjectLocation}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
		}, nil)

	_, err := svc.ProjectMachines(ctx, 7, "proj-gone")
	assertWriteCode(t, err, code.OrgObjectNotFound)
}

// 顺序要稳定：ListByUser 按 last_seen_at 排，那个值会自己变。按机器名再按指纹排，
// 同一份数据两次请求给出同一个样子。
func TestProjectMachines_GivenSeveralMachines_ThenOrderIsStable(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
		}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		agentredDevice(3, "build-02", "fp-3"),
		desktopDevice(2, "wangyz-mbp", "fp-d"),
		agentredDevice(1, "build-01", "fp-1"),
	}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(2)).Return(nil, nil)

	got, err := svc.ProjectMachines(ctx, 7, "proj-1")
	require.NoError(t, err)
	names := make([]string, 0, len(got))
	for _, m := range got {
		names = append(names, m.DeviceName)
	}
	assert.Equal(t, []string{"build-01", "build-02", "wangyz-mbp"}, names)
}

// ── 写路径 ──────────────────────────────────────────────────────────────────

// 这台机器上还没有这个项目的路径：新建一行，自然键落在**两个列**上而不是载荷里，
// 因为 R4b 的合并与那个部分唯一索引认的都是列。
func TestSetProjectLocation_GivenNoExistingRow_ThenCreatesWithTheNaturalKeyOnColumns(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mDev.EXPECT().FindByFingerprint(ctx, int64(7), "fp-1").Return(
		agentredDevice(1, "build-01", "fp-1"), nil)
	mObj.EXPECT().Find(ctx, int64(7), "proj-1").Return(
		liveOrgRow(1, sync_entity.KindProject, "proj-1", `{"name":"后端"}`), nil)
	mObj.EXPECT().FindLocationByNaturalKey(ctx, int64(7), "proj-1", "fp-1").Return(nil, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(401), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	got, err := svc.SetProjectLocation(ctx, SetProjectLocationInput{
		UserID: 7, ProjectSyncID: "proj-1", Fingerprint: "fp-1", Path: "/srv/agentre-server"})
	require.NoError(t, err)
	require.NotNil(t, saved)

	assert.Equal(t, sync_entity.KindProjectLocation, saved.Kind)
	assert.Equal(t, "proj-1", saved.ProjectSyncID, "自然键的一半在列上")
	assert.Equal(t, "fp-1", saved.AgentredFingerprint, "自然键的另一半也在列上")
	assert.Equal(t, "/srv/agentre-server", payloadKey(t, saved.Payload, "path"))
	assert.Equal(t, int64(401), saved.Version)
	assert.Empty(t, saved.OriginFingerprint, "服务端直写的来源标识是空串")
	assert.NotEmpty(t, got.SyncID)
	assert.Equal(t, saved.SyncID, got.SyncID)
}

// 已经有一行：改它的路径，**不新建第二行**——(项目, 指纹) 上有一个部分唯一索引，
// 第二行会直接撞库；而且载荷里没被提到的键要原样活下来。
func TestSetProjectLocation_GivenExistingRow_ThenUpdatesItInPlace(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	existing := locationRow(5, "pl-1", "proj-1", "fp-1", "/srv/old")
	existing.Payload = `{"path":"/srv/old","future_key_from_a_newer_desktop":"保留我"}`

	mDev.EXPECT().FindByFingerprint(ctx, int64(7), "fp-1").Return(
		agentredDevice(1, "build-01", "fp-1"), nil)
	mObj.EXPECT().Find(ctx, int64(7), "proj-1").Return(
		liveOrgRow(1, sync_entity.KindProject, "proj-1", `{"name":"后端"}`), nil)
	mObj.EXPECT().FindLocationByNaturalKey(ctx, int64(7), "proj-1", "fp-1").Return(existing, nil)
	mObj.EXPECT().Find(ctx, int64(7), "pl-1").Return(existing, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(402), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	got, err := svc.SetProjectLocation(ctx, SetProjectLocationInput{
		UserID: 7, ProjectSyncID: "proj-1", Fingerprint: "fp-1", Path: "/srv/new"})
	require.NoError(t, err)
	require.NotNil(t, saved)

	assert.Equal(t, "pl-1", saved.SyncID, "改的是同一行")
	assert.Equal(t, "pl-1", got.SyncID)
	assert.Equal(t, "/srv/new", payloadKey(t, saved.Payload, "path"))
	assert.Equal(t, "保留我", payloadKey(t, saved.Payload, "future_key_from_a_newer_desktop"))
}

// 桌面端的路径不能从 web 配（决策 4）：往上报组写一行，下一次那台桌面端上报整份快照
// 就把它冲掉了——给一个按了不生效的按钮比不给还糟。判在服务端，因为禁用按钮拦不住
// 直接打端点的请求。
func TestSetProjectLocation_GivenADesktopFingerprint_ThenRefusedBeforeWriting(t *testing.T) {
	ctx, _, _, mDev, svc := setupWorkspaceTest(t)
	mDev.EXPECT().FindByFingerprint(ctx, int64(7), "fp-d").Return(
		desktopDevice(2, "wangyz-mbp", "fp-d"), nil)

	_, err := svc.SetProjectLocation(ctx, SetProjectLocationInput{
		UserID: 7, ProjectSyncID: "proj-1", Fingerprint: "fp-d", Path: "/Users/me/code"})
	assertWriteCode(t, err, code.OrgProjectPathDesktopReadOnly)
}

// 指纹在账号里找不到对应设备（没配对、已撤销）时拒绝：落下去是一条指向不存在机器的
// 路径记录，谁也用不上它。
func TestSetProjectLocation_GivenAnUnknownFingerprint_ThenRefused(t *testing.T) {
	ctx, _, _, mDev, svc := setupWorkspaceTest(t)
	mDev.EXPECT().FindByFingerprint(ctx, int64(7), "fp-gone").Return(nil, nil)

	_, err := svc.SetProjectLocation(ctx, SetProjectLocationInput{
		UserID: 7, ProjectSyncID: "proj-1", Fingerprint: "fp-gone", Path: "/srv/x"})
	assertWriteCode(t, err, code.DeviceNotFound)
}

// 缺项目同步标识、缺指纹、缺路径都在碰仓储之前就拒（mock 是严格的：任何一次仓储调用
// 都会让这条测试红）。缺项目那一条尤其要紧：同步协议自己就挡它
// （sync_svc.rejectReason），因为没有它就没有账号内自然键，R4b 的合并无从谈起——
// 但写入侧必须先挡住，不能靠下游。
func TestSetProjectLocation_GivenAMissingPiece_ThenRefusedBeforeTouchingTheRepo(t *testing.T) {
	cases := map[string]SetProjectLocationInput{
		"没有项目":   {UserID: 7, Fingerprint: "fp-1", Path: "/srv/x"},
		"没有指纹":   {UserID: 7, ProjectSyncID: "proj-1", Path: "/srv/x"},
		"没有路径":   {UserID: 7, ProjectSyncID: "proj-1", Fingerprint: "fp-1"},
		"路径全是空白": {UserID: 7, ProjectSyncID: "proj-1", Fingerprint: "fp-1", Path: "   "},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, _, _, _, svc := setupWorkspaceTest(t)
			_, err := svc.SetProjectLocation(ctx, in)
			assertWriteCode(t, err, code.InvalidParameter)
		})
	}
}

// 项目不在这个账号下时拒绝：一条指不出项目的路径记录会被同步协议当场拒掉，
// 而它占住 (指纹, 路径) 只会把真正指得出项目的那一行挡掉。
func TestSetProjectLocation_GivenAnUnknownProject_ThenRefused(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mDev.EXPECT().FindByFingerprint(ctx, int64(7), "fp-1").Return(
		agentredDevice(1, "build-01", "fp-1"), nil)
	mObj.EXPECT().Find(ctx, int64(7), "proj-gone").Return(nil, nil)

	_, err := svc.SetProjectLocation(ctx, SetProjectLocationInput{
		UserID: 7, ProjectSyncID: "proj-gone", Fingerprint: "fp-1", Path: "/srv/x"})
	assertWriteCode(t, err, code.OrgObjectNotFound)
}

// 移除一条路径走的是同一条删除通道：落墓碑，在线的机器立刻收到，离线的下次上线时收。
func TestDeleteOrgObject_GivenProjectLocation_ThenTombstoned(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "pl-1").Return(
		locationRow(5, "pl-1", "proj-1", "fp-1", "/srv/x"), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(403), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.DeleteOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProjectLocation, SyncID: "pl-1"})
	require.NoError(t, err)
	require.NotNil(t, saved)
	assert.Positive(t, saved.DeletedAt)
	assert.Equal(t, int64(403), saved.Version)
	assert.Empty(t, saved.OriginFingerprint)
}

// 直接走通用建路的路径记录如果没带自然键，一样拒——SetProjectLocation 是唯一
// 正当入口，但闸门不能只靠「调用方走对了门」。
func TestCreateOrgObject_GivenProjectLocationWithoutItsNaturalKey_ThenRejected(t *testing.T) {
	cases := map[string]OrgWriteInput{
		"缺项目同步标识": {UserID: 7, Kind: sync_entity.KindProjectLocation,
			AgentredFingerprint: "fp-1", Fields: map[string]any{"path": "/srv/x"}},
		"缺指纹": {UserID: 7, Kind: sync_entity.KindProjectLocation,
			ProjectSyncID: "proj-1", Fields: map[string]any{"path": "/srv/x"}},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, _, _, _, svc := setupWorkspaceTest(t)
			_, err := svc.CreateOrgObject(ctx, in)
			assertWriteCode(t, err, code.InvalidParameter)
		})
	}
}

// R19 收窄的边界：只有这一个视图带得动路径，别的一个都不许。
func TestProjectMachineView_IsTheOnlyViewCarryingAPath(t *testing.T) {
	assert.Equal(t, []string{"Path"},
		machineLocalFields(reflect.TypeOf(ProjectMachineView{})),
		"这一处是 R19 本轮唯一新开的口子：只有 Path，没有 cli / env")

	// 收窄不外溢：设备展开的项目一项仍然只回布尔，会话索引的项目节点仍然什么都不带。
	for _, view := range []any{ProjectView{}, ProjectNodeView{}, DeviceDetailView{}} {
		typ := reflect.TypeOf(view)
		assert.Empty(t, machineLocalFields(typ),
			"%s 不在收窄范围内：它问的是「这台机器准备好了吗」，不是「路径是什么」", typ.Name())
	}
}

// ── 「这个项目算不算未配置」（规格 2026-08-20 决策 9）────────────────────────────
//
// 组头上那枚「未配置」角标是索引上唯一一处说得出「该配路径了」的地方，判据必须在
// 服务端：浏览器手里只有项目树，它答不出「哪台机器上有这个项目的路径」。

func TestAccountProjects_ConfiguredNeedsAPathOnAMachineThatIsStillInTheAccount(t *testing.T) {
	rows := []*sync_entity.SyncObject{
		orgRow(t, sync_entity.KindProject, "proj-配了", map[string]any{"name": "配了"}),
		orgRow(t, sync_entity.KindProject, "proj-没配", map[string]any{"name": "没配"}),
		orgRow(t, sync_entity.KindProject, "proj-机器没了", map[string]any{"name": "机器没了"}),
		locationRow(5, "pl-1", "proj-配了", "fp-1", "/srv/a"),
		// 指向一台已经不在账号里的机器：那条路径谁也用不上，不算配好了。
		locationRow(6, "pl-2", "proj-机器没了", "fp-gone", "/srv/b"),
	}
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation,
	}).Return(rows, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		agentredDevice(1, "build-01", "fp-1"),
		desktopDevice(2, "wangyz-mbp", "fp-d"),
	}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(2)).Return(nil, nil)

	got, err := svc.AccountProjects(ctx, 7)
	require.NoError(t, err)
	byID := map[string]ProjectNodeView{}
	for _, p := range got {
		byID[p.SyncID] = p
	}
	assert.True(t, byID["proj-配了"].Configured)
	assert.False(t, byID["proj-没配"].Configured)
	assert.False(t, byID["proj-机器没了"].Configured,
		"指向一台已经不在账号里的机器的路径不算配好了")
}

// 同步组里有一行指纹撞上桌面端：那不是桌面端的路径，也不该算数。桌面端的路径只认
// 上报组——两组数据的流动性不同，混用取到的不是「少几行」而是错的。
func TestAccountProjects_GivenASyncRowWhoseFingerprintHitsADesktop_ThenNotConfigured(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
			locationRow(5, "pl-1", "proj-1", "fp-d", "/Users/me/code"),
		}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		desktopDevice(2, "wangyz-mbp", "fp-d"),
	}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(2)).Return(nil, nil)

	got, err := svc.AccountProjects(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.False(t, got[0].Configured)
}

// 一台 agentred 都没有的账号：所有项目如实算未配置——这正是「只有 agentred 也能管理」
// 那条路走到第一步时的状态，角标必须挂得出来。
func TestAccountProjects_GivenNoAgentredAtAll_ThenEveryProjectIsUnconfigured(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
		}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.AccountProjects(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.False(t, got[0].Configured)
}

// ── 「未配置」角标与「网页真能不能派活」必须是同一个判据 ──────────────────────
//
// 决策 9 当初写的判据是「桌面端不参与，因为 web 派活时桌面端那一档本来就跳过」。
// **那句依据是错的**：跳过的是 `IsLocalReference` 那一档（backend 行没写运行设备，
// AvailabilityNoDevice），不是桌面端这一类设备。一台已配对、在线、上报过本机路径的
// 桌面端，在 WebDispatchPlan 里拿到的是 AvailabilityAvailable，cwd 就取自上报组
// （locationsFor）。
//
// 于是同一个项目在同一个控制台里给出两句互相矛盾的话：项目设置里那台桌面端打着绿勾
// 「已配置」，索引组头上却挂着「未配置」。下面两个测试把这条矛盾钉死。

func TestAccountProjects_GivenOnlyADesktopReportedPath_ThenConfigured(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
		}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		desktopDevice(2, "wangyz-mbp", "fp-d"),
	}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(2)).Return(
		[]*sync_entity.DeviceLocalPath{
			{UserID: 7, DeviceID: 2, ProjectSyncID: "proj-1", Path: "/Users/me/code"},
		}, nil)

	got, err := svc.AccountProjects(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.True(t, got[0].Configured,
		"桌面端上报过这个项目的本机路径，web 就派得出活，组头不该再挂「未配置」")
}

// 判据与派发口径同源，就必须同源到底：桌面端上报的那一行路径为空时派不出活
// （agentred 那一侧的空路径本来就不算），角标照挂。
func TestAccountProjects_GivenDesktopReportedAnEmptyPath_ThenStillUnconfigured(t *testing.T) {
	ctx, mObj, mPath, mDev, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
		}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		desktopDevice(2, "wangyz-mbp", "fp-d"),
	}, nil)
	mPath.EXPECT().ListByDevice(ctx, int64(7), int64(2)).Return(
		[]*sync_entity.DeviceLocalPath{
			{UserID: 7, DeviceID: 2, ProjectSyncID: "proj-1", Path: ""},
		}, nil)

	got, err := svc.AccountProjects(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.False(t, got[0].Configured)
}
