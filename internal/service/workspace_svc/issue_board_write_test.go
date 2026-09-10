package workspace_svc

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
)

// ── 浏览器直写看板（规格 2026-08-27-issues-board-project-scope「`agentre-server` 端」）──
//
// 三类看板对象走的是与组织面 / 项目面**完全同一条**写通道：账号级单调序列分配版本号、
// 删除落墓碑、来源指纹记空串、写入范围只由鉴权上下文里的账号圈定。这些测试因此钉的是
// 看板自己那几条：载荷的键名形状（桌面端 adapter_issue.go 定死）、阶段与关闭时刻的
// 联动、标签关联的增删，以及删除的级联。

// savedRows 收集这次写入落下去的全部行，供逐条断言。
func savedRows(mObj *mock_sync_repo.MockSyncObjectRepo, out *[]*sync_entity.SyncObject) {
	mObj.EXPECT().Save(gomock.Any(), gomock.Any()).AnyTimes().DoAndReturn(
		func(_ context.Context, o *sync_entity.SyncObject) error {
			copied := *o
			*out = append(*out, &copied)
			return nil
		})
}

func rowOfKind(rows []*sync_entity.SyncObject, kind string) *sync_entity.SyncObject {
	for _, row := range rows {
		if row.Kind == kind {
			return row
		}
	}
	return nil
}

// 建一张卡：server 分配同步标识与版本号，来源记空串，载荷正好是桌面端那十个键。
// 位置落在目标列的末尾——留 0 会让每一张新卡都和别人撞在同一个位置上。
func TestCreateIssue_ThenServerAllocatesIDVersionAndWritesTheWirePayload(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).Return([]*sync_entity.SyncObject{
		projectRow(t, "p-a", "甲", ""),
		withPayload(t, issueRow(t, "i-tail", "已有的卡", "todo", "p-a"),
			map[string]any{"position": 65536}),
	}, nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(301), nil)
	var saved []*sync_entity.SyncObject
	savedRows(mObj, &saved)

	got, err := IssueBoard().CreateIssue(ctx, IssueWriteInput{
		UserID: boardUser,
		Fields: map[string]any{
			"title": "新卡", "description": "正文", "stage": "todo",
			"project_sync_id": "p-a", "llm_provider_key": "anthropic-main",
			"llm_model_key": "anthropic-opus-01"},
	})
	require.NoError(t, err)
	require.Len(t, saved, 1)
	row := saved[0]

	assert.Equal(t, boardUser, row.UserID)
	assert.Equal(t, sync_entity.KindIssue, row.Kind)
	assert.NotEmpty(t, row.SyncID)
	assert.Equal(t, row.SyncID, got.SyncID)
	assert.Equal(t, int64(301), row.Version)
	assert.Empty(t, row.OriginFingerprint, "服务端直写的来源标识是空串")
	assert.Zero(t, row.DeletedAt)
	assert.Empty(t, row.ProjectSyncID,
		"任务的项目在载荷里表达，不占 project_sync_id 列——那一列是路径记录的自然键")

	assert.Equal(t, "新卡", payloadKey(t, row.Payload, "title"))
	assert.Equal(t, "正文", payloadKey(t, row.Payload, "description"))
	assert.Equal(t, "todo", payloadKey(t, row.Payload, "stage"))
	assert.Equal(t, "p-a", payloadKey(t, row.Payload, "project_sync_id"))
	assert.EqualValues(t, 131072, payloadKey(t, row.Payload, "position"),
		"新卡落在目标列末尾：已有的最后一张是 65536，步长再加一格")
	assert.EqualValues(t, 0, payloadKey(t, row.Payload, "closed_at"))
	assert.NotContains(t, row.Payload, `"state"`,
		"状态轴不进载荷：它完全由 stage 推导，两端各自算")
}

// 建卡时挂上的标签各自是一行 issue_label，各吃一个版本号——关联本身也是一个
// 同步对象，两端的本地主键在对方机器上指向完全不同的两行。
func TestCreateIssue_GivenLabels_ThenEachLinkIsItsOwnSyncObject(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).Return([]*sync_entity.SyncObject{
		labelRow(t, "l-bug", "bug", "red"),
		labelRow(t, "l-docs", "docs", "gray"),
	}, nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(310), nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(311), nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(312), nil)
	var saved []*sync_entity.SyncObject
	savedRows(mObj, &saved)

	labels := []string{"l-bug", "l-docs"}
	got, err := IssueBoard().CreateIssue(ctx, IssueWriteInput{
		UserID: boardUser, Fields: map[string]any{"title": "新卡", "stage": "todo"},
		LabelSyncIDs: &labels})
	require.NoError(t, err)

	links := make(map[string]string, 2)
	for _, row := range saved {
		if row.Kind != sync_entity.KindIssueLabel {
			continue
		}
		assert.Equal(t, got.SyncID, payloadKey(t, row.Payload, "issue_sync_id"))
		assert.NotEmpty(t, row.SyncID)
		links[payloadKey(t, row.Payload, "label_sync_id").(string)] = row.SyncID
	}
	assert.Len(t, links, 2)
	assert.NotEqual(t, links["l-bug"], links["l-docs"], "两行关联各有自己的同步标识")
}

// 引用不到的标签当场拒：落下去就是一条指向不存在标签的关联，在每一台机器上
// 都按 R2a 一直暂缓，用户只看到「这张卡同步不过去」。
func TestCreateIssue_GivenDanglingReferences_ThenRejected(t *testing.T) {
	cases := map[string]IssueWriteInput{
		"项目": {UserID: boardUser, Fields: map[string]any{
			"title": "卡", "project_sync_id": "p-gone"}},
		"Agent": {UserID: boardUser, Fields: map[string]any{
			"title": "卡", "agent_sync_id": "a-gone"}},
		"机器": {UserID: boardUser, Fields: map[string]any{
			"title": "卡", "agent_backend_sync_id": "b-gone"}},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, mObj, _, _, _ := setupWorkspaceTest(t)
			mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).Return(nil, nil)
			_, err := IssueBoard().CreateIssue(ctx, in)
			assertWriteCode(t, err, code.OrgObjectNotFound)
		})
	}

	t.Run("标签", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).Return(nil, nil)
		labels := []string{"l-gone"}
		_, err := IssueBoard().CreateIssue(ctx, IssueWriteInput{
			UserID: boardUser, Fields: map[string]any{"title": "卡"}, LabelSyncIDs: &labels})
		assertWriteCode(t, err, code.OrgObjectNotFound)
	})
}

// 标题为空、阶段不认识的卡就地拒，不落半行：桌面端 issue_entity.Check 同样拒收，
// 落下去只会在每一端都卡着。
func TestCreateIssue_GivenInvalidFields_ThenRejectedWithoutWriting(t *testing.T) {
	cases := map[string]map[string]any{
		"没有标题":  {"title": "  ", "stage": "todo"},
		"阶段不认识": {"title": "卡", "stage": "archived"},
	}
	for name, fields := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, _, _, _, _ := setupWorkspaceTest(t)
			_, err := IssueBoard().CreateIssue(ctx, IssueWriteInput{UserID: boardUser, Fields: fields})
			assertWriteCode(t, err, code.InvalidParameter)
		})
	}
}

// 改一张卡：只覆盖这次请求明确涉及的键，载荷里其余的原值原样活着——sync_objects
// 是整行 last-write-wins，把没提到的键一起写成零值就是静默的数据丢失。
func TestUpdateIssue_ThenOnlyMentionedKeysAreOverwritten(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	existing := withPayload(t, issueRow(t, "i-1", "老标题", "todo", "p-a"),
		map[string]any{"llm_model_key": "anthropic-opus-01", "position": 65536})
	existing.Version = 5
	mObj.EXPECT().Find(ctx, boardUser, "i-1").Return(existing, nil)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).Return(
		[]*sync_entity.SyncObject{projectRow(t, "p-a", "甲", ""), existing}, nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(320), nil)
	var saved []*sync_entity.SyncObject
	savedRows(mObj, &saved)

	_, err := IssueBoard().UpdateIssue(ctx, IssueWriteInput{
		UserID: boardUser, SyncID: "i-1", Fields: map[string]any{"title": "新标题"}})
	require.NoError(t, err)
	require.Len(t, saved, 1)

	assert.Equal(t, "新标题", payloadKey(t, saved[0].Payload, "title"))
	assert.Equal(t, "anthropic-opus-01", payloadKey(t, saved[0].Payload, "llm_model_key"),
		"没提到的键原样留下")
	assert.EqualValues(t, 65536, payloadKey(t, saved[0].Payload, "position"))
	assert.Equal(t, int64(320), saved[0].Version)
	assert.Empty(t, saved[0].OriginFingerprint)
}

// 改标签集合是一次**差集**：新挂的建一行关联，摘掉的落墓碑，没动的一行都不许碰
// ——重建全部关联会让每一次保存都在账号里刷掉一批版本号。
func TestUpdateIssue_GivenLabelSet_ThenOnlyTheDifferenceIsWritten(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	existing := issueRow(t, "i-1", "卡", "todo", "")
	keep := linkRow(t, "k-keep", "i-1", "l-keep")
	drop := linkRow(t, "k-drop", "i-1", "l-drop")
	drop.ID = 42
	mObj.EXPECT().Find(ctx, boardUser, "i-1").Return(existing, nil)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).Return([]*sync_entity.SyncObject{
		labelRow(t, "l-keep", "bug", "red"),
		labelRow(t, "l-drop", "docs", "gray"),
		labelRow(t, "l-new", "feature", "green"),
		existing, keep, drop,
	}, nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(330), nil).Times(3)
	var saved []*sync_entity.SyncObject
	savedRows(mObj, &saved)
	mObj.EXPECT().Tombstone(ctx, int64(42), int64(330), gomock.Any()).Return(int64(1), nil)

	labels := []string{"l-keep", "l-new"}
	_, err := IssueBoard().UpdateIssue(ctx, IssueWriteInput{
		UserID: boardUser, SyncID: "i-1", Fields: map[string]any{}, LabelSyncIDs: &labels})
	require.NoError(t, err)

	added := 0
	for _, row := range saved {
		if row.Kind != sync_entity.KindIssueLabel {
			continue
		}
		added++
		assert.Equal(t, "l-new", payloadKey(t, row.Payload, "label_sync_id"))
		assert.Equal(t, "i-1", payloadKey(t, row.Payload, "issue_sync_id"))
	}
	assert.Equal(t, 1, added, "只有新挂的那一个标签建了关联")
}

// 请求没提到标签时一行关联都不许动：省略与「清空标签」是两件事。
func TestUpdateIssue_GivenNoLabelKey_ThenLinksAreLeftAlone(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	existing := issueRow(t, "i-1", "卡", "todo", "")
	mObj.EXPECT().Find(ctx, boardUser, "i-1").Return(existing, nil)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).Return([]*sync_entity.SyncObject{
		existing, linkRow(t, "k-1", "i-1", "l-bug"), labelRow(t, "l-bug", "bug", "red"),
	}, nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(340), nil)
	var saved []*sync_entity.SyncObject
	savedRows(mObj, &saved)

	_, err := IssueBoard().UpdateIssue(ctx, IssueWriteInput{
		UserID: boardUser, SyncID: "i-1", Fields: map[string]any{"title": "改了标题"}})
	require.NoError(t, err)

	assert.Len(t, saved, 1)
	assert.Equal(t, sync_entity.KindIssue, saved[0].Kind)
}

// 拖一张卡改的是 stage 与 position 两个键，落点在相邻两卡之间取中点。
// 进 done 记下关闭时刻、离开 done 清掉它——状态轴消失之后它完全由 stage 推导。
func TestMoveIssue_ThenStageAndPositionAreWrittenAndClosedAtFollowsTheStage(t *testing.T) {
	const now = int64(1_800_000_000_000)

	t.Run("落在两卡之间", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		freezeBoardNow(t, now)
		mState := registerSyncStateMock(t)
		moving := issueRow(t, "i-move", "被拖的", "todo", "")
		mObj.EXPECT().Find(ctx, boardUser, "i-move").Return(moving, nil)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).Return([]*sync_entity.SyncObject{
			moving,
			withPayload(t, issueRow(t, "i-1", "一", "doing", ""), map[string]any{"position": 100}),
			withPayload(t, issueRow(t, "i-2", "二", "doing", ""), map[string]any{"position": 300}),
		}, nil)
		mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(350), nil)
		var saved []*sync_entity.SyncObject
		savedRows(mObj, &saved)

		_, err := IssueBoard().MoveIssue(ctx, IssueMoveInput{
			UserID: boardUser, SyncID: "i-move", Stage: "doing", AfterSyncID: "i-1"})
		require.NoError(t, err)
		require.Len(t, saved, 1)
		assert.Equal(t, "doing", payloadKey(t, saved[0].Payload, "stage"))
		assert.EqualValues(t, 200, payloadKey(t, saved[0].Payload, "position"))
		assert.EqualValues(t, 0, payloadKey(t, saved[0].Payload, "closed_at"))
	})

	t.Run("拖进已完成", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		freezeBoardNow(t, now)
		mState := registerSyncStateMock(t)
		moving := issueRow(t, "i-move", "被拖的", "todo", "")
		mObj.EXPECT().Find(ctx, boardUser, "i-move").Return(moving, nil)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).
			Return([]*sync_entity.SyncObject{moving}, nil)
		mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(351), nil)
		var saved []*sync_entity.SyncObject
		savedRows(mObj, &saved)

		_, err := IssueBoard().MoveIssue(ctx, IssueMoveInput{
			UserID: boardUser, SyncID: "i-move", Stage: "done"})
		require.NoError(t, err)
		require.Len(t, saved, 1)
		assert.Equal(t, "done", payloadKey(t, saved[0].Payload, "stage"))
		assert.EqualValues(t, now, payloadKey(t, saved[0].Payload, "closed_at"))
	})

	t.Run("拖出已完成", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		freezeBoardNow(t, now)
		mState := registerSyncStateMock(t)
		moving := withPayload(t, issueRow(t, "i-move", "被拖的", "done", ""),
			map[string]any{"closed_at": now - 1000})
		mObj.EXPECT().Find(ctx, boardUser, "i-move").Return(moving, nil)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).
			Return([]*sync_entity.SyncObject{moving}, nil)
		mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(352), nil)
		var saved []*sync_entity.SyncObject
		savedRows(mObj, &saved)

		_, err := IssueBoard().MoveIssue(ctx, IssueMoveInput{
			UserID: boardUser, SyncID: "i-move", Stage: "todo"})
		require.NoError(t, err)
		require.Len(t, saved, 1)
		assert.EqualValues(t, 0, payloadKey(t, saved[0].Payload, "closed_at"))
	})
}

// 删一张卡落墓碑而不是物理删除（删除本身要能被下行游标带到每一台机器上），
// 它身上的关联行一并落——留着就是一串指向已消失任务的悬空引用。
func TestDeleteIssue_ThenTheCardAndItsLabelLinksAreTombstoned(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	target := issueRow(t, "i-1", "卡", "todo", "")
	target.ID = 11
	mine := linkRow(t, "k-1", "i-1", "l-bug")
	mine.ID = 12
	others := linkRow(t, "k-2", "i-2", "l-bug")
	others.ID = 13
	mObj.EXPECT().Find(ctx, boardUser, "i-1").Return(target, nil)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).
		Return([]*sync_entity.SyncObject{target, mine, others}, nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(360), nil).Times(2)
	mObj.EXPECT().Tombstone(ctx, int64(12), int64(360), gomock.Any()).Return(int64(1), nil)
	var saved []*sync_entity.SyncObject
	savedRows(mObj, &saved)

	_, err := IssueBoard().DeleteIssue(ctx, boardUser, "i-1")
	require.NoError(t, err)
	require.Len(t, saved, 1)
	assert.Positive(t, saved[0].DeletedAt, "删除落墓碑，正文原样留着")
	assert.Equal(t, sync_entity.KindIssue, saved[0].Kind)
}

// 删除不复活（R6），跨账号取不到（Find 按（账号, 同步标识）取），类型不符与
// 「不存在」共用一个码——分开就等于给出一个跨账号的存在性探测器。
func TestIssueWrites_GivenMissingDeletedOrForeignRow_ThenRefused(t *testing.T) {
	t.Run("不存在或不属于本账号", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		mObj.EXPECT().Find(ctx, boardUser, "i-x").Return(nil, nil)
		_, err := IssueBoard().DeleteIssue(ctx, boardUser, "i-x")
		assertWriteCode(t, err, code.OrgObjectNotFound)
	})

	t.Run("类型不符", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		mObj.EXPECT().Find(ctx, boardUser, "p-a").Return(projectRow(t, "p-a", "甲", ""), nil)
		_, err := IssueBoard().DeleteIssue(ctx, boardUser, "p-a")
		assertWriteCode(t, err, code.OrgObjectNotFound)
	})

	t.Run("已是墓碑", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		row := issueRow(t, "i-1", "卡", "todo", "")
		row.DeletedAt = 1
		mObj.EXPECT().Find(ctx, boardUser, "i-1").Return(row, nil)
		_, err := IssueBoard().DeleteIssue(ctx, boardUser, "i-1")
		assertWriteCode(t, err, code.OrgObjectDeleted)
	})
}

// 建标签：名字与色调进载荷，status 记成存活——server 没有本地行，读路径判「这个
// 标签还在不在」靠的就是载荷里这一个键（桌面端 adapter_issue.go 的同一条理由）。
func TestCreateLabel_ThenNameToneAndLiveStatusAreWritten(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, []string{sync_entity.KindLabel}).Return(nil, nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(370), nil)
	var saved []*sync_entity.SyncObject
	savedRows(mObj, &saved)

	got, err := IssueBoard().CreateLabel(ctx, LabelWriteInput{
		UserID: boardUser, Fields: map[string]any{"name": "性能", "tone": "violet"}})
	require.NoError(t, err)
	require.Len(t, saved, 1)

	assert.Equal(t, sync_entity.KindLabel, saved[0].Kind)
	assert.Equal(t, saved[0].SyncID, got.SyncID)
	assert.Equal(t, "性能", payloadKey(t, saved[0].Payload, "name"))
	assert.Equal(t, "violet", payloadKey(t, saved[0].Payload, "tone"))
	assert.EqualValues(t, 1, payloadKey(t, saved[0].Payload, "status"))
	assert.Empty(t, saved[0].OriginFingerprint)
}

// 色调取值域是设计系统那 8 档颜色名，越界即拒：库里落一个渲染不出来的色调，
// 两端的标签 chip 都会掉回兜底底色。
func TestCreateLabel_GivenToneOutsideThePalette_ThenRejected(t *testing.T) {
	ctx, _, _, _, _ := setupWorkspaceTest(t)
	for _, tone := range []string{"purple", "bug", "", "RED"} {
		t.Run(tone, func(t *testing.T) {
			_, err := IssueBoard().CreateLabel(ctx, LabelWriteInput{
				UserID: boardUser, Fields: map[string]any{"name": "x", "tone": tone}})
			assertWriteCode(t, err, code.InvalidParameter)
		})
	}
}

// 重名的标签拒收：名字就是标签的自然键（桌面端 uniq_labels_name_active），
// 两行同名会在下行时被合并到本机同一行上，用户看到的是「删不掉」。
func TestCreateLabel_GivenDuplicateName_ThenRejected(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, []string{sync_entity.KindLabel}).
		Return([]*sync_entity.SyncObject{labelRow(t, "l-bug", "bug", "red")}, nil)

	_, err := IssueBoard().CreateLabel(ctx, LabelWriteInput{
		UserID: boardUser, Fields: map[string]any{"name": "bug", "tone": "amber"}})
	assertWriteCode(t, err, code.InvalidParameter)
}

// 改名 / 换色只覆盖提到的键；改成自己现在的名字不算重名。
func TestUpdateLabel_ThenRenameAndRecolourKeepTheRestOfThePayload(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	existing := labelRow(t, "l-bug", "bug", "red")
	mObj.EXPECT().Find(ctx, boardUser, "l-bug").Return(existing, nil)
	mObj.EXPECT().ListByKinds(ctx, boardUser, []string{sync_entity.KindLabel}).
		Return([]*sync_entity.SyncObject{existing}, nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(380), nil)
	var saved []*sync_entity.SyncObject
	savedRows(mObj, &saved)

	_, err := IssueBoard().UpdateLabel(ctx, LabelWriteInput{
		UserID: boardUser, SyncID: "l-bug",
		Fields: map[string]any{"name": "bug", "tone": "steel"}})
	require.NoError(t, err)
	require.Len(t, saved, 1)
	assert.Equal(t, "bug", payloadKey(t, saved[0].Payload, "name"))
	assert.Equal(t, "steel", payloadKey(t, saved[0].Payload, "tone"))
	assert.Equal(t, int64(380), saved[0].Version)
}

// 删标签落墓碑，并把它身上的全部关联一并落：留着关联行就等于在每一台机器上留下
// 一串指向已消失标签的悬空引用（桌面端 labelAdapter.remove 也是这两步）。
func TestDeleteLabel_ThenTheLabelAndEveryLinkToItAreTombstoned(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mState := registerSyncStateMock(t)
	target := labelRow(t, "l-bug", "bug", "red")
	target.ID = 21
	link1 := linkRow(t, "k-1", "i-1", "l-bug")
	link1.ID = 22
	link2 := linkRow(t, "k-2", "i-2", "l-bug")
	link2.ID = 23
	other := linkRow(t, "k-3", "i-1", "l-docs")
	other.ID = 24
	mObj.EXPECT().Find(ctx, boardUser, "l-bug").Return(target, nil)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardWriteKinds).
		Return([]*sync_entity.SyncObject{target, link1, link2, other}, nil)
	mState.EXPECT().NextVersion(ctx, boardUser, int64(1)).Return(int64(390), nil).Times(3)
	mObj.EXPECT().Tombstone(ctx, int64(22), int64(390), gomock.Any()).Return(int64(1), nil)
	mObj.EXPECT().Tombstone(ctx, int64(23), int64(390), gomock.Any()).Return(int64(1), nil)
	var saved []*sync_entity.SyncObject
	savedRows(mObj, &saved)

	_, err := IssueBoard().DeleteLabel(ctx, boardUser, "l-bug")
	require.NoError(t, err)
	require.Len(t, saved, 1)
	assert.Equal(t, sync_entity.KindLabel, rowOfKind(saved, sync_entity.KindLabel).Kind)
	assert.Positive(t, saved[0].DeletedAt)
}
