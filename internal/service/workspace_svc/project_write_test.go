package workspace_svc

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

// ── 浏览器直写项目一族（规格 2026-08-20「项目在 web 上成为一件可管理的事」）──────
//
// 项目与成员关系走的是与部门 / Agent / 执行目标完全同一条写通道（决策 2）：同一套
// 「校验 → 载荷 → NextVersion → Save → 广播」。这些测试因此只钉项目**自己那几条**
// 判据，共用语义（来源记空串、跨账号取不到、墓碑不复活、广播）由 workspace_test.go 里
// 那批按 kind 遍历的测试覆盖。

// 建：项目与成员关系各自由 server 分配同步标识与版本号，来源记空串。
//
// 成员关系的两端在**载荷里**用同步标识表达（桌面端 projectAgentPayload 的
// project_sync_id / agent_sync_id），不写 sync_objects 的 project_sync_id 列——
// 那一列是路径记录的自然键，桌面端推上来的成员关系同样不带它，服务端这一侧要写成
// 同一个形状，否则两个来源的同一类行长得不一样。
func TestCreateOrgObject_GivenProjectKinds_ThenServerAllocatesIDVersionAndRecordsItselfAsSource(t *testing.T) {
	t.Run("项目", func(t *testing.T) {
		ctx, mObj, _, _, svc := setupWorkspaceTest(t)
		mState := registerSyncStateMock(t)
		mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(201), nil)
		var saved *sync_entity.SyncObject
		mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
			func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

		got, err := svc.CreateOrgObject(ctx, OrgWriteInput{
			UserID: 7, Kind: sync_entity.KindProject,
			Fields: map[string]any{"name": "agentre-server", "description": "服务端", "color": "agent-7"}})
		require.NoError(t, err)
		require.NotNil(t, saved)

		assert.Equal(t, int64(7), saved.UserID)
		assert.Equal(t, sync_entity.KindProject, saved.Kind)
		assert.NotEmpty(t, saved.SyncID)
		assert.Equal(t, saved.SyncID, got.SyncID)
		assert.Equal(t, int64(201), saved.Version)
		assert.Empty(t, saved.OriginFingerprint, "服务端直写的来源标识是空串")
		assert.Zero(t, saved.DeletedAt)
		assert.Equal(t, "agentre-server", payloadKey(t, saved.Payload, "name"))
		assert.Equal(t, "服务端", payloadKey(t, saved.Payload, "description"))
		assert.Equal(t, "agent-7", payloadKey(t, saved.Payload, "color"))
	})

	t.Run("成员关系", func(t *testing.T) {
		ctx, mObj, _, _, svc := setupWorkspaceTest(t)
		mState := registerSyncStateMock(t)
		mObj.EXPECT().ListByKinds(ctx, int64(7),
			[]string{sync_entity.KindProject, sync_entity.KindAgent, sync_entity.KindProjectAgent}).Return(
			[]*sync_entity.SyncObject{
				orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
				orgRow(t, sync_entity.KindAgent, "agent-1", map[string]any{"name": "小助手"}),
			}, nil)
		mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(202), nil)
		var saved *sync_entity.SyncObject
		mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
			func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

		got, err := svc.CreateOrgObject(ctx, OrgWriteInput{
			UserID: 7, Kind: sync_entity.KindProjectAgent,
			Fields: map[string]any{"project_sync_id": "proj-1", "agent_sync_id": "agent-1"}})
		require.NoError(t, err)
		require.NotNil(t, saved)

		assert.Equal(t, sync_entity.KindProjectAgent, saved.Kind)
		assert.NotEmpty(t, got.SyncID)
		assert.Equal(t, int64(202), saved.Version)
		assert.Equal(t, "proj-1", payloadKey(t, saved.Payload, "project_sync_id"))
		assert.Equal(t, "agent-1", payloadKey(t, saved.Payload, "agent_sync_id"))
		assert.Empty(t, saved.ProjectSyncID,
			"成员关系的项目在载荷里表达，不占 project_sync_id 列——那一列是路径记录的自然键")
		assert.Positive(t, payloadKey(t, saved.Payload, "joined_at"),
			"入组时刻由服务端补上：留 0 会让这条关系在每一台机器上都显示成 1970 年加入")
	})
}

// 名字为空的项目就地拒绝，不落半行：桌面端 project_entity.Check 同样要求名字非空，
// 落下去只会在每一端都卡着。
func TestCreateOrgObject_GivenProjectWithoutName_ThenRejectedBeforeWriting(t *testing.T) {
	cases := map[string]map[string]any{
		"没有 name":   {"color": "agent-3"},
		"name 全是空白": {"name": "  "},
	}
	for name, fields := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, _, _, _, svc := setupWorkspaceTest(t)
			_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
				UserID: 7, Kind: sync_entity.KindProject, Fields: fields})
			assertWriteCode(t, err, code.InvalidParameter)
		})
	}
}

// 成员关系两端都必填：缺一端的行在每一端都解析不出引用，按 R2a 一直暂缓。
func TestCreateOrgObject_GivenProjectMemberMissingAnEnd_ThenRejectedBeforeWriting(t *testing.T) {
	cases := map[string]map[string]any{
		"没有项目":     {"agent_sync_id": "agent-1"},
		"没有 Agent": {"project_sync_id": "proj-1"},
	}
	for name, fields := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, _, _, _, svc := setupWorkspaceTest(t)
			_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
				UserID: 7, Kind: sync_entity.KindProjectAgent, Fields: fields})
			assertWriteCode(t, err, code.InvalidParameter)
		})
	}
}

// 改项目：**载荷里没被这次请求提到的键必须原样活下来**（同部门那条守卫，刻意在载荷里
// 放一个任何 Go 结构体都没声明的键）。
func TestUpdateOrgObject_GivenProjectRename_ThenUntouchedKeysSurvive(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "proj-1").Return(liveOrgRow(1, sync_entity.KindProject, "proj-1",
		`{"name":"后端","description":"原简介","icon":"🚀","color":"agent-3",`+
			`"sort_order":3,"future_key_from_a_newer_desktop":"保留我"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(203), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "proj-1",
		Fields: map[string]any{"name": "agentre-server"}})
	require.NoError(t, err)
	require.NotNil(t, saved)

	assert.Equal(t, "agentre-server", payloadKey(t, saved.Payload, "name"))
	assert.Equal(t, "原简介", payloadKey(t, saved.Payload, "description"))
	assert.Equal(t, "🚀", payloadKey(t, saved.Payload, "icon"))
	assert.Equal(t, "agent-3", payloadKey(t, saved.Payload, "color"))
	assert.EqualValues(t, 3, payloadKey(t, saved.Payload, "sort_order"))
	assert.Equal(t, "保留我", payloadKey(t, saved.Payload, "future_key_from_a_newer_desktop"))
}

// 父项目指向自己或自己的后代时就地拒绝：同步下去会在每一端造出一个走不完的环
// （桌面端按 parent_id 递归缩进，环意味着渲染永不终止）。
func TestUpdateOrgObject_GivenParentPointingAtItselfOrADescendant_ThenRejectedBeforeWriting(t *testing.T) {
	// proj-a → proj-b → proj-c 一条链。
	tree := []*sync_entity.SyncObject{
		orgRow(t, sync_entity.KindProject, "proj-a", map[string]any{"name": "A"}),
		orgRow(t, sync_entity.KindProject, "proj-b", map[string]any{"name": "B", "parent_sync_id": "proj-a"}),
		orgRow(t, sync_entity.KindProject, "proj-c", map[string]any{"name": "C", "parent_sync_id": "proj-b"}),
	}
	cases := map[string]string{
		"指向自己":  "proj-a",
		"指向子项目": "proj-b",
		"指向孙项目": "proj-c",
	}
	for name, parent := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, mObj, _, _, svc := setupWorkspaceTest(t)
			mObj.EXPECT().Find(ctx, int64(7), "proj-a").Return(
				liveOrgRow(1, sync_entity.KindProject, "proj-a", `{"name":"A"}`), nil)
			mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindProject}).Return(tree, nil)

			_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
				UserID: 7, Kind: sync_entity.KindProject, SyncID: "proj-a",
				Fields: map[string]any{"parent_sync_id": parent}})
			assertWriteCode(t, err, code.OrgProjectParentCycle)
		})
	}
}

// 挂到一个不在这条链上的项目下是正当操作，照常放行——上面那条守卫不能顺手把它也挡掉。
func TestUpdateOrgObject_GivenParentOutsideItsOwnSubtree_ThenAccepted(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "proj-c").Return(
		liveOrgRow(3, sync_entity.KindProject, "proj-c", `{"name":"C","parent_sync_id":"proj-b"}`), nil)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindProject}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-a", map[string]any{"name": "A"}),
			orgRow(t, sync_entity.KindProject, "proj-b", map[string]any{"name": "B", "parent_sync_id": "proj-a"}),
			orgRow(t, sync_entity.KindProject, "proj-c", map[string]any{"name": "C", "parent_sync_id": "proj-b"}),
		}, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(204), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "proj-c",
		Fields: map[string]any{"parent_sync_id": "proj-a"}})
	require.NoError(t, err)
	require.NotNil(t, saved)
	assert.Equal(t, "proj-a", payloadKey(t, saved.Payload, "parent_sync_id"))
}

// 显式把父项目清空（挂回根上）是正当操作：判的是**写进去的值**，不是键在不在。
func TestUpdateOrgObject_GivenParentClearedToRoot_ThenAccepted(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "proj-b").Return(
		liveOrgRow(2, sync_entity.KindProject, "proj-b", `{"name":"B","parent_sync_id":"proj-a"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(205), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.UpdateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "proj-b",
		Fields: map[string]any{"parent_sync_id": ""}})
	require.NoError(t, err)
	require.NotNil(t, saved)
	assert.Equal(t, "", payloadKey(t, saved.Payload, "parent_sync_id"))
}

// 父项目引用一个账号里没有的项目时拒绝：落下去就是一棵接不上的孤树。
func TestCreateOrgObject_GivenUnknownParentProject_ThenRejected(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{sync_entity.KindProject}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-a", map[string]any{"name": "A"}),
		}, nil)

	_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProject,
		Fields: map[string]any{"name": "新项目", "parent_sync_id": "proj-gone"}})
	assertWriteCode(t, err, code.OrgObjectNotFound)
}

// 成员关系的两端都必须是账号里存活的对象：指不到的一端等于一条永远落不了地的行。
func TestCreateOrgObject_GivenProjectMemberWithDanglingEnd_ThenRejected(t *testing.T) {
	deadProject := orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"})
	deadProject.DeletedAt = 1700000000000
	cases := map[string][]*sync_entity.SyncObject{
		"项目不存在": {
			orgRow(t, sync_entity.KindAgent, "agent-1", map[string]any{"name": "小助手"}),
		},
		"Agent 不存在": {
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
		},
	}
	for name, rows := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, mObj, _, _, svc := setupWorkspaceTest(t)
			mObj.EXPECT().ListByKinds(ctx, int64(7),
				[]string{sync_entity.KindProject, sync_entity.KindAgent, sync_entity.KindProjectAgent}).
				Return(rows, nil)

			_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
				UserID: 7, Kind: sync_entity.KindProjectAgent,
				Fields: map[string]any{"project_sync_id": "proj-1", "agent_sync_id": "agent-1"}})
			assertWriteCode(t, err, code.OrgObjectNotFound)
		})
	}
}

// 同一个 Agent 不重复加进同一个项目：第二行成员关系会让成员清单里出现两个同一个人，
// 删掉其中一个之后它还在——用户看到的是「删不掉」。
func TestCreateOrgObject_GivenProjectMemberAlreadyThere_ThenRejected(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7),
		[]string{sync_entity.KindProject, sync_entity.KindAgent, sync_entity.KindProjectAgent}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
			orgRow(t, sync_entity.KindAgent, "agent-1", map[string]any{"name": "小助手"}),
			orgRow(t, sync_entity.KindProjectAgent, "pa-1", map[string]any{
				"project_sync_id": "proj-1", "agent_sync_id": "agent-1"}),
		}, nil)

	_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProjectAgent,
		Fields: map[string]any{"project_sync_id": "proj-1", "agent_sync_id": "agent-1"}})
	assertWriteCode(t, err, code.OrgProjectMemberExists)
}

// 删项目：这一行与它的**全部子项目**都落墓碑，各自名下的成员关系与路径记录一并跟着走
// （决策 13，与桌面端 projectAdapter.children 同一份清单）。对话一条都不删——项目归属
// 是判出来的，项目行没了那些对话自然回到「未归项目」。
func TestDeleteOrgObject_GivenProjectWithSubtree_ThenDescendantsMembersAndLocationsGoToo(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	chanStub := registerAccountChanStub(t)

	// proj-a → proj-b → proj-c，外加一个不在这棵子树里的 proj-x。
	mObj.EXPECT().Find(ctx, int64(7), "proj-a").Return(
		liveOrgRow(1, sync_entity.KindProject, "proj-a", `{"name":"A"}`), nil)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation,
	}).Return([]*sync_entity.SyncObject{
		{ID: 1, Kind: sync_entity.KindProject, SyncID: "proj-a", Payload: mustJSON(t, map[string]any{"name": "A"})},
		{ID: 2, Kind: sync_entity.KindProject, SyncID: "proj-b", Payload: mustJSON(t, map[string]any{
			"name": "B", "parent_sync_id": "proj-a"})},
		{ID: 3, Kind: sync_entity.KindProject, SyncID: "proj-c", Payload: mustJSON(t, map[string]any{
			"name": "C", "parent_sync_id": "proj-b"})},
		{ID: 4, Kind: sync_entity.KindProject, SyncID: "proj-x", Payload: mustJSON(t, map[string]any{"name": "X"})},
		{ID: 5, Kind: sync_entity.KindProjectAgent, SyncID: "pa-b", Payload: mustJSON(t, map[string]any{
			"project_sync_id": "proj-b", "agent_sync_id": "agent-1"})},
		{ID: 6, Kind: sync_entity.KindProjectAgent, SyncID: "pa-x", Payload: mustJSON(t, map[string]any{
			"project_sync_id": "proj-x", "agent_sync_id": "agent-1"})},
		{ID: 7, Kind: sync_entity.KindProjectLocation, SyncID: "pl-c", ProjectSyncID: "proj-c",
			AgentredFingerprint: "fp-1", Payload: mustJSON(t, map[string]any{"path": "/srv/c"})},
		{ID: 8, Kind: sync_entity.KindProjectLocation, SyncID: "pl-x", ProjectSyncID: "proj-x",
			AgentredFingerprint: "fp-1", Payload: mustJSON(t, map[string]any{"path": "/srv/x"})},
	}, nil)

	// 级联的每一行各吃一个版本号（同 sync_svc.tombstoneExecTargetsOf 的做法），
	// 主行最后落，因此它拿到的是最高的那一个。
	var versions []int64
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).DoAndReturn(
		func(context.Context, int64, int64) (int64, error) {
			v := int64(300 + len(versions))
			versions = append(versions, v)
			return v, nil
		}).AnyTimes()

	tombstoned := map[int64]int64{}
	mObj.EXPECT().Tombstone(ctx, gomock.Any(), gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, id, version, _ int64) (int64, error) {
			tombstoned[id] = version
			return 1, nil
		}).AnyTimes()
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	got, err := svc.DeleteOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "proj-a"})
	require.NoError(t, err)
	require.NotNil(t, saved)

	assert.Positive(t, saved.DeletedAt, "主行落墓碑")
	assert.Equal(t, "proj-a", saved.SyncID)
	tombstonedIDs := make([]int64, 0, len(tombstoned))
	for id := range tombstoned {
		tombstonedIDs = append(tombstonedIDs, id)
	}
	assert.ElementsMatch(t, []int64{2, 3, 5, 7}, tombstonedIDs,
		"子项目、子项目名下的成员关系与路径记录一并落墓碑；子树之外的一行都不动")

	calls := chanStub.recordedCalls()
	require.Len(t, calls, 1, "一次删除只推一次信号")
	assert.Equal(t, got.Version, calls[0].version, "推的是这次操作实际推进到的最高版本")
	for id, v := range tombstoned {
		assert.Less(t, v, got.Version, "级联行的版本都早于主行 #%d", id)
	}
}

// 删一个没有子项目、没有成员、没有路径的项目：级联查询照发（服务端事先不知道它是空的），
// 但一行都不该被级联掉。
func TestDeleteOrgObject_GivenLeafProject_ThenOnlyItselfIsTombstoned(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "proj-a").Return(
		liveOrgRow(1, sync_entity.KindProject, "proj-a", `{"name":"A"}`), nil)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation,
	}).Return([]*sync_entity.SyncObject{
		{ID: 1, Kind: sync_entity.KindProject, SyncID: "proj-a", Payload: `{"name":"A"}`},
	}, nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(310), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	got, err := svc.DeleteOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProject, SyncID: "proj-a"})
	require.NoError(t, err)
	require.NotNil(t, saved)
	assert.Positive(t, saved.DeletedAt)
	assert.Equal(t, int64(310), got.Version)
}

// 删一条成员关系不牵动任何别的行：它没有子行。
func TestDeleteOrgObject_GivenProjectMember_ThenNoCascade(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)

	mObj.EXPECT().Find(ctx, int64(7), "pa-1").Return(
		liveOrgRow(5, sync_entity.KindProjectAgent, "pa-1",
			`{"project_sync_id":"proj-1","agent_sync_id":"agent-1"}`), nil)
	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(320), nil)
	var saved *sync_entity.SyncObject
	mObj.EXPECT().Save(ctx, gomock.Any()).DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error { saved = o; return nil })

	_, err := svc.DeleteOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProjectAgent, SyncID: "pa-1"})
	require.NoError(t, err)
	require.NotNil(t, saved)
	assert.Positive(t, saved.DeletedAt)
}

// ── 项目读侧新长出来的两块：描述与成员 ────────────────────────────────────────

// 描述此前在服务端整条链上都不存在（projectPayload 没声明这个键，json.Unmarshal
// 直接把它丢掉）。项目设置要改它，就得先读得到它。
func TestAccountProjects_GivenDescriptionInPayload_ThenItIsCarried(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation,
	}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{
				"name": "后端", "description": "服务端那一半"}),
			orgRow(t, sync_entity.KindProject, "proj-2", map[string]any{"name": "前端"}),
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
	assert.Equal(t, "服务端那一半", byID["proj-1"].Description)
	assert.Empty(t, byID["proj-2"].Description)
}

// 成员在服务端此前连读侧都没有。组头的 ＋ 只列这个项目的成员（决策 10），因此项目树
// 这一份材料要逐项目带上成员：每条成员关系带**它自己的同步标识**，删成员按它定位。
func TestAccountProjects_GivenMemberships_ThenEachProjectCarriesItsOwnMembers(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation,
	}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
			orgRow(t, sync_entity.KindProject, "proj-2", map[string]any{"name": "前端"}),
			orgRow(t, sync_entity.KindProjectAgent, "pa-1", map[string]any{
				"project_sync_id": "proj-1", "agent_sync_id": "agent-b"}),
			orgRow(t, sync_entity.KindProjectAgent, "pa-2", map[string]any{
				"project_sync_id": "proj-1", "agent_sync_id": "agent-a"}),
		}, nil)
	// 「未配置」的判据要问账号里有哪些 agentred（决策 9）。
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.AccountProjects(ctx, 7)
	require.NoError(t, err)
	byID := map[string]ProjectNodeView{}
	for _, p := range got {
		byID[p.SyncID] = p
	}
	require.Len(t, byID["proj-1"].Members, 2)
	// 顺序要稳定：ListByKinds 没有 ORDER BY，不排的话同一份数据两次请求能给出两个样子。
	assert.Equal(t, ProjectMemberView{SyncID: "pa-2", AgentSyncID: "agent-a"}, byID["proj-1"].Members[0])
	assert.Equal(t, ProjectMemberView{SyncID: "pa-1", AgentSyncID: "agent-b"}, byID["proj-1"].Members[1])
	assert.Empty(t, byID["proj-2"].Members, "没有成员的项目如实给空，不借别人的")
}

// 两台桌面端各自离线把同一个 Agent 加进同一个项目，会落成两行同步标识不同、
// (项目, Agent) 相同的成员关系（桌面端 projectAgentAdapter.apply 只在本机去重，
// 挡不住这一种）。读侧按 (项目, Agent) 收敛，取同步标识字典序小的那一行——判据只看
// 数据本身，不看行序，否则同一批数据两次请求能给出两个「该删哪一条」。
func TestAccountProjects_GivenDuplicateMembership_ThenTheAgentAppearsOnce(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, int64(7), []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation,
	}).Return(
		[]*sync_entity.SyncObject{
			orgRow(t, sync_entity.KindProject, "proj-1", map[string]any{"name": "后端"}),
			orgRow(t, sync_entity.KindProjectAgent, "pa-zz", map[string]any{
				"project_sync_id": "proj-1", "agent_sync_id": "agent-a"}),
			orgRow(t, sync_entity.KindProjectAgent, "pa-aa", map[string]any{
				"project_sync_id": "proj-1", "agent_sync_id": "agent-a"}),
		}, nil)
	// 「未配置」的判据要问账号里有哪些 agentred（决策 9）。
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return(nil, nil)

	got, err := svc.AccountProjects(ctx, 7)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Len(t, got[0].Members, 1)
	assert.Equal(t, "pa-aa", got[0].Members[0].SyncID)
}

// 项目一族的读侧一样不带路径：ProjectNodeView 上没有任何一个字段能装下它
// （R19 的结构性守法），成员关系的载荷里也从来没有路径。
func TestProjectNodeView_HasNoFieldThatCouldHoldAPath(t *testing.T) {
	for _, view := range []any{ProjectNodeView{}, ProjectMemberView{}} {
		typ := reflect.TypeOf(view)
		assert.Empty(t, machineLocalFields(typ),
			"%s 上出现了能装下机器本地路径的字段：R19 的守法是结构性的", typ.Name())
	}
}

// 广播失败不回滚已经落库的项目写入（同组织面那条）。
func TestCreateOrgObject_GivenProjectAndBroadcastFails_ThenWriteStillSucceeds(t *testing.T) {
	ctx, mObj, _, _, svc := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	stub := registerAccountChanStub(t)
	stub.err = errors.New("redis unreachable")

	mState.EXPECT().NextVersion(ctx, int64(7), int64(1)).Return(int64(330), nil)
	mObj.EXPECT().Save(ctx, gomock.Any()).Return(nil)

	got, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindProject, Fields: map[string]any{"name": "新项目"}})
	require.NoError(t, err)
	assert.Equal(t, int64(330), got.Version)
	require.Len(t, stub.recordedCalls(), 1)
}

// 项目一族现在在写通道里，别的类型不因此跟着进来：backend 仍然只读。
func TestOrgWrite_GivenBackendKind_ThenStillNotWritable(t *testing.T) {
	ctx, _, _, _, svc := setupWorkspaceTest(t)
	_, err := svc.CreateOrgObject(ctx, OrgWriteInput{
		UserID: 7, Kind: sync_entity.KindAgentBackend, Fields: map[string]any{"name": "x"}})
	assertWriteCode(t, err, code.OrgKindNotWritable)
}
