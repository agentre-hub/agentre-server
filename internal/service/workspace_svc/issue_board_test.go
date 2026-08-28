package workspace_svc

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

// ── 看板读路径（规格 2026-08-27-issues-board-project-scope「`agentre-server` 端」）──
//
// 一次 ListByKinds 取回账号下的 project / label / issue / issue_label，六个条件、
// 列头的「命中 / 全部」与项目选择器的子树计数**全部在 Go 里算**（决策 15）。
// 这些测试因此只喂同步对象、只断言算出来的东西，没有任何投影表可以偷懒。

const boardUser = int64(7)

// boardKinds 是读路径那一次取数的类型集合：项目在里面，因为范围与子树计数要用它。
var boardKinds = []string{
	sync_entity.KindProject, sync_entity.KindLabel,
	sync_entity.KindIssue, sync_entity.KindIssueLabel,
}

func projectRow(t *testing.T, syncID, name, parent string) *sync_entity.SyncObject {
	t.Helper()
	row := orgRow(t, sync_entity.KindProject, syncID, map[string]any{
		"name": name, "parent_sync_id": parent})
	row.UserID = boardUser
	return row
}

func labelRow(t *testing.T, syncID, name, tone string) *sync_entity.SyncObject {
	t.Helper()
	row := orgRow(t, sync_entity.KindLabel, syncID, map[string]any{
		"name": name, "tone": tone, "status": 1})
	row.UserID = boardUser
	return row
}

func linkRow(t *testing.T, syncID, issueSyncID, labelSyncID string) *sync_entity.SyncObject {
	t.Helper()
	row := orgRow(t, sync_entity.KindIssueLabel, syncID, map[string]any{
		"issue_sync_id": issueSyncID, "label_sync_id": labelSyncID})
	row.UserID = boardUser
	return row
}

// issueRow 造一行任务同步对象。载荷键名由桌面端 sync_svc/adapter_issue.go 定死，
// 这一侧逐字消费——键名写错在这里就是「读不出来」。
func issueRow(t *testing.T, syncID, title, stage, projectSyncID string) *sync_entity.SyncObject {
	t.Helper()
	row := orgRow(t, sync_entity.KindIssue, syncID, map[string]any{
		"title": title, "description": "", "stage": stage, "position": 0,
		"project_sync_id": projectSyncID, "closed_at": 0})
	row.UserID = boardUser
	return row
}

func withPayload(t *testing.T, row *sync_entity.SyncObject, fields map[string]any) *sync_entity.SyncObject {
	t.Helper()
	next, err := withOrgFields(row.Payload, fields)
	require.NoError(t, err)
	row.Payload = next
	return row
}

func withTimes(row *sync_entity.SyncObject, created, updated int64) *sync_entity.SyncObject {
	row.Createtime, row.SyncUpdatedAt = created, updated
	return row
}

// freezeBoardNow 把「现在」钉死：保留窗口是相对当下算的，测试不能跟着真实时钟走。
// 时刻由服务端就地取，不从请求里收——客户端的钟不可信，而这个数要和服务端自己记的
// 时刻相比。
func freezeBoardNow(t *testing.T, now int64) {
	t.Helper()
	prev := boardNow
	boardNow = func() int64 { return now }
	t.Cleanup(func() { boardNow = prev })
}

func issueSyncIDs(view *IssueBoardView) []string {
	out := make([]string, 0, len(view.Issues))
	for _, it := range view.Issues {
		out = append(out, it.SyncID)
	}
	return out
}

// 项目范围收窄到「选中项目 + 它的整棵子树」：兄弟项目与未归属都不在板上。
func TestIssueBoard_GivenProjectScope_ThenOnlyTheSubtreeIsOnTheBoard(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		projectRow(t, "p-root", "后端", ""),
		projectRow(t, "p-child", "网关", "p-root"),
		projectRow(t, "p-grand", "限流", "p-child"),
		projectRow(t, "p-other", "前端", ""),
		issueRow(t, "i-root", "根项目的卡", "todo", "p-root"),
		issueRow(t, "i-child", "子项目的卡", "todo", "p-child"),
		issueRow(t, "i-grand", "孙项目的卡", "doing", "p-grand"),
		issueRow(t, "i-other", "兄弟项目的卡", "todo", "p-other"),
		issueRow(t, "i-none", "未归属的卡", "todo", ""),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{
		UserID: boardUser, Scope: IssueScopeProject, ProjectSyncID: "p-root"})
	require.NoError(t, err)

	assert.ElementsMatch(t, []string{"i-root", "i-child", "i-grand"}, issueSyncIDs(view))
}

// 「某个项目」这一档漏填项目时当场拒：空串会被子树展开当成「没挂项目」那个键，
// 于是 scope=project 静默变成一块未归属的板——那是另一个档，不能从一个漏填的参数
// 里冒出来。
func TestIssueBoard_GivenProjectScopeWithoutAProject_ThenRejected(t *testing.T) {
	ctx, _, _, _, _ := setupWorkspaceTest(t)

	_, err := IssueBoard().Board(ctx, IssueBoardQuery{
		UserID: boardUser, Scope: IssueScopeProject})
	assertWriteCode(t, err, code.InvalidParameter)
}

// 未归属是一档**确定的范围**，不是「不加条件」：只有 project_sync_id 为空的卡在板上。
func TestIssueBoard_GivenUnassignedScope_ThenOnlyIssuesWithoutAProjectAreOnTheBoard(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		projectRow(t, "p-root", "后端", ""),
		issueRow(t, "i-root", "有项目", "todo", "p-root"),
		issueRow(t, "i-none", "没项目", "todo", ""),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{
		UserID: boardUser, Scope: IssueScopeUnassigned})
	require.NoError(t, err)

	assert.Equal(t, []string{"i-none"}, issueSyncIDs(view))
}

// 关键词匹配标题与描述，大小写不敏感；`#编号` 那一半在这一侧退化成去掉井号后的
// 文本匹配——同步载荷里没有任何一端的本地编号，server 手上根本没有那个数。
func TestIssueBoard_GivenKeyword_ThenTitleAndDescriptionMatchCaseInsensitively(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		issueRow(t, "i-title", "修 Gateway 超时", "todo", ""),
		withPayload(t, issueRow(t, "i-body", "另一件事", "todo", ""),
			map[string]any{"description": "顺带看看 gateway 的连接池"}),
		issueRow(t, "i-miss", "毫不相干", "todo", ""),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{UserID: boardUser, Keyword: " gateway "})
	require.NoError(t, err)

	assert.ElementsMatch(t, []string{"i-title", "i-body"}, issueSyncIDs(view))
}

// 标签的三种语义各不相同：任意一个 / 全部满足 / 只看没有标签的。
func TestIssueBoard_GivenLabelConditions_ThenAnyAllAndNoLabelEachSelectDifferently(t *testing.T) {
	rows := func(t *testing.T) []*sync_entity.SyncObject {
		return []*sync_entity.SyncObject{
			labelRow(t, "l-bug", "bug", "red"),
			labelRow(t, "l-docs", "docs", "gray"),
			issueRow(t, "i-both", "两个标签都有", "todo", ""),
			issueRow(t, "i-bug", "只有 bug", "todo", ""),
			issueRow(t, "i-bare", "没有标签", "todo", ""),
			linkRow(t, "k-1", "i-both", "l-bug"),
			linkRow(t, "k-2", "i-both", "l-docs"),
			linkRow(t, "k-3", "i-bug", "l-bug"),
		}
	}

	t.Run("任意一个", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)
		view, err := IssueBoard().Board(ctx, IssueBoardQuery{
			UserID: boardUser, LabelSyncIDs: []string{"l-bug", "l-docs"}})
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"i-both", "i-bug"}, issueSyncIDs(view))
	})

	t.Run("全部满足", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)
		view, err := IssueBoard().Board(ctx, IssueBoardQuery{
			UserID: boardUser, LabelSyncIDs: []string{"l-bug", "l-docs"}, LabelMatchAll: true})
		require.NoError(t, err)
		assert.Equal(t, []string{"i-both"}, issueSyncIDs(view))
	})

	t.Run("只看没有标签的", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)
		view, err := IssueBoard().Board(ctx, IssueBoardQuery{UserID: boardUser, NoLabel: true})
		require.NoError(t, err)
		assert.Equal(t, []string{"i-bare"}, issueSyncIDs(view))
	})

	// 卡片自己带着标签正文：看板要画 chip，再问一次服务端就是两趟。
	t.Run("卡片带标签正文", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)
		view, err := IssueBoard().Board(ctx, IssueBoardQuery{
			UserID: boardUser, LabelSyncIDs: []string{"l-docs"}})
		require.NoError(t, err)
		require.Len(t, view.Issues, 1)
		names := make([]string, 0, 2)
		for _, l := range view.Issues[0].Labels {
			names = append(names, l.Name)
		}
		assert.ElementsMatch(t, []string{"bug", "docs"}, names)
	})
}

// 三类时间范围各管各的：更新时间、创建时间，以及「已完成保留多久」——最后一条
// **只裁剪已完成的卡**，未完成的一张都不受它影响。
func TestIssueBoard_GivenTimeRanges_ThenEachNarrowsItsOwnAxis(t *testing.T) {
	const day = int64(24 * 60 * 60 * 1000)
	now := int64(1_800_000_000_000)
	rows := func(t *testing.T) []*sync_entity.SyncObject {
		return []*sync_entity.SyncObject{
			withTimes(issueRow(t, "i-fresh", "刚改过", "todo", ""), now-40*day, now-1*day),
			withTimes(issueRow(t, "i-stale", "很久没动", "todo", ""), now-40*day, now-40*day),
			withTimes(withPayload(t, issueRow(t, "i-done-old", "很久前完成", "done", ""),
				map[string]any{"closed_at": now - 100*day}), now-200*day, now-100*day),
			withTimes(withPayload(t, issueRow(t, "i-done-new", "刚完成", "done", ""),
				map[string]any{"closed_at": now - 2*day}), now-200*day, now-2*day),
		}
	}

	t.Run("更新时间", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		freezeBoardNow(t, now)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)
		view, err := IssueBoard().Board(ctx, IssueBoardQuery{
			UserID: boardUser, UpdatedFrom: now - 7*day})
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"i-fresh", "i-done-new"}, issueSyncIDs(view))
	})

	t.Run("创建时间", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		freezeBoardNow(t, now)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)
		view, err := IssueBoard().Board(ctx, IssueBoardQuery{
			UserID: boardUser, CreatedFrom: now - 60*day, CreatedTo: now})
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"i-fresh", "i-stale"}, issueSyncIDs(view))
	})

	t.Run("已完成保留多久", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		freezeBoardNow(t, now)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)
		view, err := IssueBoard().Board(ctx, IssueBoardQuery{
			UserID: boardUser, DoneWithinDays: 30})
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"i-fresh", "i-stale", "i-done-new"}, issueSyncIDs(view),
			"保留窗口只裁剪已完成的卡，未完成的一张都不许少")
	})

	// 上界单独成条：只给上界时下界不该跟着冒出来，`>` 与 `>=` 的差别也只有在这里
	// 才看得见（两条区间测试的下界都远离边界值）。
	t.Run("只给上界", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		freezeBoardNow(t, now)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)
		view, err := IssueBoard().Board(ctx, IssueBoardQuery{
			UserID: boardUser, UpdatedTo: now - 2*day})
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"i-stale", "i-done-old", "i-done-new"}, issueSyncIDs(view),
			"区间是闭的：正好落在上界那一刻的卡要留在板上")
	})

	// 两端都是闭区间：边界那一刻的卡在里面，差一毫秒的在外面。
	t.Run("边界是闭的", func(t *testing.T) {
		ctx, mObj, _, _, _ := setupWorkspaceTest(t)
		freezeBoardNow(t, now)
		mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)
		view, err := IssueBoard().Board(ctx, IssueBoardQuery{
			UserID: boardUser, CreatedFrom: now - 200*day, CreatedTo: now - 40*day})
		require.NoError(t, err)
		assert.ElementsMatch(t,
			[]string{"i-fresh", "i-stale", "i-done-old", "i-done-new"}, issueSyncIDs(view))
	})
}

// 历史卡没记下关闭时刻（closed_at = 0）时，保留窗口退回最后修改时间——照字面比
// 「0 >= 下界」的话，`sync_id` 早于关闭时刻这个键的每一张已完成的卡都会被静默吞掉。
func TestIssueBoard_GivenADoneCardWithoutAClosedAt_ThenTheRetentionWindowFallsBackToUpdatedAt(t *testing.T) {
	const day = int64(24 * 60 * 60 * 1000)
	now := int64(1_800_000_000_000)
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	freezeBoardNow(t, now)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		// 两张都没有 closed_at，只有最后修改时间分得出新旧。
		withTimes(issueRow(t, "i-legacy-new", "老卡刚动过", "done", ""), now-300*day, now-3*day),
		withTimes(issueRow(t, "i-legacy-old", "老卡很久没动", "done", ""), now-300*day, now-90*day),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{
		UserID: boardUser, DoneWithinDays: 30})
	require.NoError(t, err)
	assert.Equal(t, []string{"i-legacy-new"}, issueSyncIDs(view),
		"没有关闭时刻就按最后修改时间算，而不是当成 0 一律裁掉")
}

// 空串与不认识的阶段一律归到第一列：把它们留在一个不存在的列里，等于让用户再也
// 看不见那张卡——它既不在板上，也不在任何一个列头的计数里。
func TestIssueBoard_GivenAnEmptyOrUnknownStage_ThenTheCardLandsInTheFirstColumn(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		issueRow(t, "i-empty", "迁移默认的空阶段", "", ""),
		issueRow(t, "i-unknown", "另一端加出来的阶段", "archived", ""),
		issueRow(t, "i-doing", "正常的卡", "doing", ""),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{UserID: boardUser})
	require.NoError(t, err)

	byID := map[string]string{}
	for _, it := range view.Issues {
		byID[it.SyncID] = it.Stage
	}
	assert.Equal(t, "todo", byID["i-empty"])
	assert.Equal(t, "todo", byID["i-unknown"])
	assert.Equal(t, "doing", byID["i-doing"])
	assert.Equal(t, int64(2), view.StageCounts["todo"], "两张都要数进第一列，不能凭空消失")
	assert.Equal(t, int64(2), view.StageTotals["todo"])
}

// 两台机器各自给同一件事挂过同一个标签时，账号里会有两条同步标识不同、指向同一对
// (任务, 标签) 的关联行。卡上不能因此出现两枚一模一样的 chip，「被 N 个任务使用」
// 也不能把一张卡数成两张。
func TestIssueBoard_GivenTwoLinkRowsForTheSamePair_ThenTheChipAndTheUsageCountAreCountedOnce(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		labelRow(t, "l-bug", "bug", "red"),
		issueRow(t, "i-1", "一张卡", "todo", ""),
		linkRow(t, "il-a", "i-1", "l-bug"),
		linkRow(t, "il-b", "i-1", "l-bug"),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{UserID: boardUser})
	require.NoError(t, err)

	require.Len(t, view.Issues, 1)
	assert.Len(t, view.Issues[0].Labels, 1, "同一对只画一枚 chip")
	require.Len(t, view.Labels, 1)
	assert.Equal(t, int64(1), view.Labels[0].UsageCount, "同一张卡只数一次")
}

// 「只看没有标签的」说了就不再看选中的是哪些标签：两个条件一起判必然一张卡都留不下，
// 那是一块解释不了的空板，不是用户表达的意思。
func TestIssueBoard_GivenNoLabelTogetherWithChosenLabels_ThenNoLabelWins(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		labelRow(t, "l-bug", "bug", "red"),
		issueRow(t, "i-bare", "没有标签", "todo", ""),
		issueRow(t, "i-tagged", "挂着标签", "todo", ""),
		linkRow(t, "il-1", "i-tagged", "l-bug"),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{
		UserID: boardUser, NoLabel: true, LabelSyncIDs: []string{"l-bug"}})
	require.NoError(t, err)
	assert.Equal(t, []string{"i-bare"}, issueSyncIDs(view))
}

// 列头的「命中 / 全部」是两把尺子各量一次：命中吃全部筛选条件，全部只吃项目范围。
// 零命中的列照常在计数里出现，界面才留得住那一列。
func TestIssueBoard_ThenStageCountsHonourFiltersAndTotalsOnlyTheScope(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		projectRow(t, "p-a", "甲", ""),
		issueRow(t, "i-1", "命中的卡", "todo", "p-a"),
		issueRow(t, "i-2", "同列不命中", "todo", "p-a"),
		issueRow(t, "i-3", "另一列不命中", "doing", "p-a"),
		issueRow(t, "i-4", "范围外的卡", "todo", ""),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{
		UserID: boardUser, Scope: IssueScopeProject, ProjectSyncID: "p-a", Keyword: "命中的"})
	require.NoError(t, err)

	assert.Equal(t, int64(1), view.StageCounts["todo"])
	assert.Equal(t, int64(2), view.StageTotals["todo"])
	assert.Equal(t, int64(0), view.StageCounts["doing"], "零命中的列也要有数，界面才留得住它")
	assert.Equal(t, int64(1), view.StageTotals["doing"])
	assert.Equal(t, int64(0), view.StageTotals["done"], "四列一列都不少")
}

// 项目选择器右侧的计数是「该项目及其子树里**未完成**的任务数」，且**不随筛选变**
// ——打开选择器就是为了判断该切到哪，这个数跟着筛选缩水就失去了用途。
func TestIssueBoard_ThenProjectCountsRollUpTheSubtreeAndIgnoreTheFilters(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		projectRow(t, "p-root", "后端", ""),
		projectRow(t, "p-child", "网关", "p-root"),
		projectRow(t, "p-other", "前端", ""),
		issueRow(t, "i-1", "根上的", "todo", "p-root"),
		issueRow(t, "i-2", "子项目的", "doing", "p-child"),
		issueRow(t, "i-3", "子项目已完成的", "done", "p-child"),
		issueRow(t, "i-4", "未归属的", "todo", ""),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{
		UserID: boardUser, Scope: IssueScopeProject, ProjectSyncID: "p-other", Keyword: "根上的"})
	require.NoError(t, err)

	counts := map[string]int64{}
	for _, c := range view.ProjectCounts {
		counts[c.ProjectSyncID] = c.Count
	}
	assert.Equal(t, int64(2), counts["p-root"], "根 = 自己 1 + 子树 1，已完成的不算")
	assert.Equal(t, int64(1), counts["p-child"])
	assert.Equal(t, int64(0), counts["p-other"])
	assert.Equal(t, int64(1), counts[""], "未归属自成一档，不挂在任何项目下")
}

// 标签目录随看板一起下发，每个带「被 N 个任务使用」——删一个标签之前要说得出
// 爆炸半径。已落墓碑的任务不算数（ListByKinds 本就不返回墓碑）。
func TestIssueBoard_ThenLabelCatalogueCarriesUsageCount(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		labelRow(t, "l-bug", "bug", "red"),
		labelRow(t, "l-idle", "refactor", "steel"),
		issueRow(t, "i-1", "一", "todo", ""),
		issueRow(t, "i-2", "二", "todo", ""),
		linkRow(t, "k-1", "i-1", "l-bug"),
		linkRow(t, "k-2", "i-2", "l-bug"),
		// 指向已不在的任务的关联行不算使用：它在别的机器上删掉了，墓碑还没到。
		linkRow(t, "k-3", "i-gone", "l-bug"),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{UserID: boardUser, Keyword: "一"})
	require.NoError(t, err)

	usage := map[string]int64{}
	for _, l := range view.Labels {
		usage[l.SyncID] = l.UsageCount
	}
	assert.Equal(t, int64(2), usage["l-bug"], "使用数是账号口径，不随筛选缩水")
	assert.Equal(t, int64(0), usage["l-idle"])
	assert.Len(t, view.Labels, 2, "一个标签都不能因为没被用到就从目录里消失")
}

// 软删（载荷里 status 不是 ACTIVE）的标签不出现在目录里，也不再把卡片染上颜色。
// 桌面端刻意把 status 放进载荷，就是因为 server 没有本地行可判（adapter_issue.go）。
func TestIssueBoard_GivenSoftDeletedLabel_ThenItLeavesTheCatalogueAndTheCards(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		labelRow(t, "l-live", "bug", "red"),
		withPayload(t, labelRow(t, "l-dead", "docs", "gray"), map[string]any{"status": 2}),
		issueRow(t, "i-1", "一", "todo", ""),
		linkRow(t, "k-1", "i-1", "l-live"),
		linkRow(t, "k-2", "i-1", "l-dead"),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{UserID: boardUser})
	require.NoError(t, err)

	require.Len(t, view.Labels, 1)
	assert.Equal(t, "l-live", view.Labels[0].SyncID)
	require.Len(t, view.Issues, 1)
	require.Len(t, view.Issues[0].Labels, 1)
	assert.Equal(t, "l-live", view.Issues[0].Labels[0].SyncID)
}

// 次序只有一种：按列、列内按 position（决策 10「不给看板加排序」），并且稳定。
func TestIssueBoard_GivenAnyBoard_ThenColumnOrderIsPositionOnly(t *testing.T) {
	rows := func(t *testing.T) []*sync_entity.SyncObject {
		return []*sync_entity.SyncObject{
			withTimes(withPayload(t, issueRow(t, "i-b", "乙", "todo", ""),
				map[string]any{"position": 200}), 0, 300),
			withTimes(withPayload(t, issueRow(t, "i-a", "甲", "todo", ""),
				map[string]any{"position": 100}), 0, 100),
			withTimes(withPayload(t, issueRow(t, "i-c", "丙", "doing", ""),
				map[string]any{"position": 50}), 0, 200),
		}
	}

	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return(rows(t), nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{UserID: boardUser})

	require.NoError(t, err)
	assert.Equal(t, []string{"i-c", "i-a", "i-b"}, issueSyncIDs(view))
}

// 执行归属三个字段原样往返：本轮没有任何路径读它们，但它们必须能被看见与保存，
// 否则表单打开时那三颗 pill 会是空的。
func TestIssueBoard_ThenExecutionAssignmentSurvivesTheReadPath(t *testing.T) {
	ctx, mObj, _, _, _ := setupWorkspaceTest(t)
	mObj.EXPECT().ListByKinds(ctx, boardUser, boardKinds).Return([]*sync_entity.SyncObject{
		withPayload(t, issueRow(t, "i-1", "一", "todo", ""), map[string]any{
			"agent_sync_id": "a-1", "agent_backend_sync_id": "b-1",
			"llm_provider_key": "anthropic-main", "llm_model_key": "anthropic-opus-01"}),
	}, nil)

	view, err := IssueBoard().Board(ctx, IssueBoardQuery{UserID: boardUser})
	require.NoError(t, err)

	require.Len(t, view.Issues, 1)
	got := view.Issues[0]
	assert.Equal(t, "a-1", got.AgentSyncID)
	assert.Equal(t, "b-1", got.AgentBackendSyncID)
	assert.Equal(t, "anthropic-main", got.LLMProviderKey)
	assert.Equal(t, "anthropic-opus-01", got.LLMModelKey)
}
