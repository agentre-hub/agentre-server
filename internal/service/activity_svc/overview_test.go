package activity_svc

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/activitystats"
	"github.com/agentre-hub/agentre-server/internal/repository/activity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/activity_repo/mock_activity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo/mock_agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

const testUserID = int64(7)

// fixture 把四个仓储都换成 mock。四个都装上而不是只装用得着的那个，是为了让「这条路
// **不该**碰某个仓储」变成一条会红的断言：没写 EXPECT 的 mock 被调到时 gomock 当场
// 失败，而一个没注册的仓储只会 nil 解引用 panic —— 两者都停下来，但只有前者说得出
// 是谁越界了。
type fixture struct {
	ctx      context.Context
	settings *mock_user_repo.MockSettingsRepo
	daily    *mock_activity_repo.MockDailyRepo
	summary  *mock_agent_session_repo.MockSummaryRepo
	save     *mock_agent_session_repo.MockSaveRepo
	db       sqlmock.Sqlmock
}

func setup(t *testing.T) *fixture {
	t.Helper()
	ctrl := gomock.NewController(t)
	ctx, _, dbMock := testutils.Database(t)
	f := &fixture{
		ctx:      ctx,
		settings: mock_user_repo.NewMockSettingsRepo(ctrl),
		daily:    mock_activity_repo.NewMockDailyRepo(ctrl),
		summary:  mock_agent_session_repo.NewMockSummaryRepo(ctrl),
		save:     mock_agent_session_repo.NewMockSaveRepo(ctrl),
		db:       dbMock,
	}
	user_repo.RegisterSettings(f.settings)
	activity_repo.RegisterDaily(f.daily)
	agent_session_repo.RegisterSummary(f.summary)
	agent_session_repo.RegisterSave(f.save)
	return f
}

// day 交出「今天往前第 n 天」的日界，按服务端时区 —— 与服务算 today 的那一条同源。
// 测试不能钉死一个字面日期：窗口是相对今天算的，写死的日期明天就落到窗口外面去了。
func day(n int) string {
	_, loc := activitystats.ServerZone()
	return time.Now().In(loc).AddDate(0, 0, -n).Format("2006-01-02")
}

// atDay 交出那一天正午的 Unix 毫秒。正午而不是零点：零点在夏令时切换那天可能不存在，
// 而这个时刻要被服务原样按服务端时区切回同一天。
func atDay(n int) int64 {
	_, loc := activitystats.ServerZone()
	d := time.Now().In(loc).AddDate(0, 0, -n)
	return time.Date(d.Year(), d.Month(), d.Day(), 12, 0, 0, 0, loc).UnixMilli()
}

// TestOverview_UnknownRangeIsAnError 覆盖未知区间键：报错，且一个仓储都不碰。
//
// 静默落到某个默认值的后果是界面上写着「近 7 天」而数字是近 30 天的 —— 一个说谎的
// 标签比一个错误页糟得多，因为没人会发现（activitystats.Window 的注释同）。判区间键
// 排在读设置之前，是为了让一个打错的参数不去打一趟数据库。
func TestOverview_UnknownRangeIsAnError(t *testing.T) {
	f := setup(t)

	_, err := Activity().Overview(f.ctx, testUserID, "90d")

	assert.Error(t, err)
}

// TestOverview_DisabledFallsBackToSavedSessionsWithoutTouchingRollups 是这一页的核心
// 约束：开关关着时，总览必须**完全不碰** agent_activity_daily。
//
// 那张表在开关关着时按约定是空的，但「碰不碰」不能靠它恰好是空的来保证：只要读路径
// 上还留着一条读它的语句，一个开过又关掉、而删除因故没删干净的账号就会在自己明确
// 关掉统计之后，仍然看见由上报数据画出来的图。这里没给 daily 写任何 EXPECT，
// 任何一次调用都会当场红。
func TestOverview_DisabledFallsBackToSavedSessionsWithoutTouchingRollups(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID}, nil)
	f.summary.EXPECT().ListSummariesByUser(gomock.Any(), testUserID).Return(
		[]*agent_session_entity.SessionSummary{
			{LastMessageAt: atDay(0), AgentSyncID: "a1", BackendType: "claudecode"},
			{LastMessageAt: atDay(1), AgentSyncID: "a1", BackendType: "claudecode"},
		}, nil)

	view, err := Activity().Overview(f.ctx, testUserID, "30d")

	require.NoError(t, err)
	assert.Equal(t, ScopeSaved, view.Scope)
	assert.False(t, view.ActivityStatsEnabled)
	assert.Equal(t, int64(2), view.Summary.Conversations)
	assert.Equal(t, int64(2), view.Summary.ConversationsTotal)
	assert.Equal(t, 2, view.Summary.ActiveDays)
	assert.Equal(t, 2, view.Summary.StreakDays)
}

// TestOverview_SavedPathIgnoresSessionsThatNeverReportedATurn 覆盖 LastMessageAt == 0。
//
// 0 不是 1970-01-01，是「对端从没报过一轮」。按 0 切日界会在热力图最左边凭空长出一格
// 1970，并且把「历史最长连续」的起点拉到那一天；更要紧的是这条对话根本没有活动，
// 计进任何一天都是在无中生有。
func TestOverview_SavedPathIgnoresSessionsThatNeverReportedATurn(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID}, nil)
	f.summary.EXPECT().ListSummariesByUser(gomock.Any(), testUserID).Return(
		[]*agent_session_entity.SessionSummary{
			{LastMessageAt: atDay(0)},
			{LastMessageAt: 0},
		}, nil)

	view, err := Activity().Overview(f.ctx, testUserID, "30d")

	require.NoError(t, err)
	assert.Equal(t, int64(1), view.Summary.Conversations)
	assert.Equal(t, int64(1), view.Summary.ConversationsTotal)
	for _, d := range view.Heatmap.Days {
		assert.NotEqual(t, "1970-01-01", d.Day, "从没报过一轮的对话不该长出一格 1970")
	}
}

// TestOverview_SavedPathKeepsBlankDimensionsAsTheirOwnGroup 覆盖五个维度上的空串。
//
// 空串是**有含义的值**而不是缺失：provider 与 model 皆空 = 这条对话跟随 Agent 绑定；
// project 空 = 未归属项目；backend 空 = 发起端没报（activity_entity 的注释）。顺手写下
// 的 `if k == "" { continue }` 会把这一组整个丢掉，于是各卡片加起来比总计少，且少得
// 没有规律 —— 没有任何地方会报错。
func TestOverview_SavedPathKeepsBlankDimensionsAsTheirOwnGroup(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID}, nil)
	f.summary.EXPECT().ListSummariesByUser(gomock.Any(), testUserID).Return(
		[]*agent_session_entity.SessionSummary{
			{
				LastMessageAt: atDay(0), AgentSyncID: "a1", BackendType: "claudecode",
				ProviderKey: "anthropic", ModelKey: "claude-sonnet-5", ProjectSyncID: "p1",
			},
			{LastMessageAt: atDay(0)},
		}, nil)

	view, err := Activity().Overview(f.ctx, testUserID, "30d")

	require.NoError(t, err)
	assert.Contains(t, view.Agents, AgentCount{SyncID: "", Count: 1})
	assert.Contains(t, view.Backends, BackendCount{BackendType: "", Count: 1})
	assert.Contains(t, view.Models, ModelCount{ProviderKey: "", ModelKey: "", Count: 1})
	assert.Contains(t, view.Projects, ProjectCount{SyncID: "", Count: 1})
	// 各卡片之和 == 区间总计。这是空串成组这条约束的可观察后果。
	assert.Equal(t, view.Summary.Conversations, sumAgents(view.Agents))
	assert.Equal(t, view.Summary.Conversations, sumBackends(view.Backends))
	assert.Equal(t, view.Summary.Conversations, sumModels(view.Models))
	assert.Equal(t, view.Summary.Conversations, sumProjects(view.Projects))
}

func sumAgents(items []AgentCount) int64 {
	var total int64
	for _, i := range items {
		total += i.Count
	}
	return total
}

func sumBackends(items []BackendCount) int64 {
	var total int64
	for _, i := range items {
		total += i.Count
	}
	return total
}

func sumModels(items []ModelCount) int64 {
	var total int64
	for _, i := range items {
		total += i.Count
	}
	return total
}

func sumProjects(items []ProjectCount) int64 {
	var total int64
	for _, i := range items {
		total += i.Count
	}
	return total
}

// TestOverview_EnabledReadsRollupsAndKeepsTheHeatmapAtAYear 覆盖开关开着那条路。
//
// 两条约束一起钉：
//
//  1. 摘要与三张分布跟随区间控件，**热力图不跟随** —— 一年的格子图是这一页的主角，
//     跟着控件缩成七格就没有意义了。d(100) 那一天落在一年里、落在 30 天外：它必须
//     出现在热力图上，又必须不计进「18 / 30 天」那个活跃天数。
//  2. 连续天数看的是**全部历史**而不是窗口，所以按天那一份是不设界地读回来的。
func TestOverview_EnabledReadsRollupsAndKeepsTheHeatmapAtAYear(t *testing.T) {
	f := setup(t)
	today := day(0)
	from, to, _, err := activitystats.Window("30d", today)
	require.NoError(t, err)
	allQ := activity_repo.DailyQuery{UserID: testUserID}
	winQ := activity_repo.DailyQuery{UserID: testUserID, FromDay: from, ToDay: to}

	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().SumTotal(gomock.Any(), winQ).Return(int64(143), nil)
	f.daily.EXPECT().SumTotal(gomock.Any(), allQ).Return(int64(486), nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), allQ, activity_repo.DimDay).Return([]activity_repo.DimSum{
		{Day: day(0), Total: 11},
		{Day: day(1), Total: 5},
		{Day: day(100), Total: 1},
		{Day: day(400), Total: 7},
	}, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), winQ, activity_repo.DimAgent).
		Return([]activity_repo.DimSum{{AgentSyncID: "a1", Total: 42}}, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), winQ, activity_repo.DimBackendType).
		Return([]activity_repo.DimSum{{BackendType: "claudecode", Total: 90}}, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), winQ, activity_repo.DimProvider, activity_repo.DimModel).
		Return([]activity_repo.DimSum{
			{ProviderKey: "anthropic", ModelKey: "claude-sonnet-5", Total: 60},
		}, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), winQ, activity_repo.DimProject).
		Return([]activity_repo.DimSum{{ProjectSyncID: "p1", Total: 46}}, nil)

	view, err := Activity().Overview(f.ctx, testUserID, "30d")

	require.NoError(t, err)
	assert.Equal(t, ScopeFull, view.Scope)
	assert.True(t, view.ActivityStatsEnabled)
	zoneName, _ := activitystats.ServerZone()
	assert.Equal(t, zoneName, view.TimeZone)
	assert.NotEqual(t, "Local", view.TimeZone, "界面上要写出这个名字，写「Local」等于没写")
	assert.Equal(t, int64(143), view.Summary.Conversations)
	assert.Equal(t, int64(486), view.Summary.ConversationsTotal)
	assert.Equal(t, 30, view.Summary.WindowDays)
	assert.Equal(t, 2, view.Summary.ActiveDays, "d(100) 在一年里，但不在 30 天窗口里")
	assert.Equal(t, 2, view.Summary.StreakDays)
	assert.Equal(t, 2, view.Summary.LongestStreakDays)

	yearFrom, yearTo := activitystats.YearWindow(today)
	assert.Equal(t, yearFrom, view.Heatmap.From)
	assert.Equal(t, yearTo, view.Heatmap.To)
	assert.Equal(t, []DayCount{
		{Day: day(100), Count: 1}, {Day: day(1), Count: 5}, {Day: day(0), Count: 11},
	}, view.Heatmap.Days, "热力图按日期升序，且只有一年之内的那些天")
	require.NotNil(t, view.Heatmap.BusiestDay)
	assert.Equal(t, DayCount{Day: day(0), Count: 11}, *view.Heatmap.BusiestDay)
	assert.InDelta(t, 5.7, view.Heatmap.AvgPerActiveDay, 0.001, "17 / 3 保留一位小数")

	assert.Equal(t, []AgentCount{{SyncID: "a1", Count: 42}}, view.Agents)
	assert.Equal(t, []BackendCount{{BackendType: "claudecode", Count: 90}}, view.Backends)
	assert.Equal(t, []ModelCount{
		{ProviderKey: "anthropic", ModelKey: "claude-sonnet-5", Count: 60},
	}, view.Models)
	assert.Equal(t, []ProjectCount{{SyncID: "p1", Count: 46}}, view.Projects)
}

// TestOverview_EnabledKeepsBlankDimensionsAsTheirOwnGroup 是空串成组在开关开着那条路
// 上的同一条约束。两条路各自实现聚合，所以这条必须两边各钉一次。
func TestOverview_EnabledKeepsBlankDimensionsAsTheirOwnGroup(t *testing.T) {
	f := setup(t)
	today := day(0)
	from, to, _, err := activitystats.Window("7d", today)
	require.NoError(t, err)
	allQ := activity_repo.DailyQuery{UserID: testUserID}
	winQ := activity_repo.DailyQuery{UserID: testUserID, FromDay: from, ToDay: to}

	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().SumTotal(gomock.Any(), winQ).Return(int64(3), nil)
	f.daily.EXPECT().SumTotal(gomock.Any(), allQ).Return(int64(3), nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), allQ, activity_repo.DimDay).
		Return([]activity_repo.DimSum{{Day: day(0), Total: 3}}, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), winQ, activity_repo.DimAgent).
		Return([]activity_repo.DimSum{{AgentSyncID: "", Total: 3}}, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), winQ, activity_repo.DimBackendType).
		Return([]activity_repo.DimSum{{BackendType: "", Total: 3}}, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), winQ, activity_repo.DimProvider, activity_repo.DimModel).
		Return([]activity_repo.DimSum{{ProviderKey: "", ModelKey: "", Total: 3}}, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), winQ, activity_repo.DimProject).
		Return([]activity_repo.DimSum{{ProjectSyncID: "", Total: 3}}, nil)

	view, err := Activity().Overview(f.ctx, testUserID, "7d")

	require.NoError(t, err)
	assert.Equal(t, []AgentCount{{SyncID: "", Count: 3}}, view.Agents)
	assert.Equal(t, []BackendCount{{BackendType: "", Count: 3}}, view.Backends)
	assert.Equal(t, []ModelCount{{ProviderKey: "", ModelKey: "", Count: 3}}, view.Models)
	assert.Equal(t, []ProjectCount{{SyncID: "", Count: 3}}, view.Projects)
}

// TestOverview_DistributionsAreRankedDeterministically 覆盖次序。
//
// map 的遍历序在 Go 里每次都不一样。不排序的话同一份数据两次刷新会画出两张次序不同的
// 图，而用户会以为数字变了。计数相同时按键排，否则并列的两项仍然会互相换位。
func TestOverview_DistributionsAreRankedDeterministically(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID}, nil)
	rows := []*agent_session_entity.SessionSummary{
		{LastMessageAt: atDay(0), AgentSyncID: "a2"},
		{LastMessageAt: atDay(0), AgentSyncID: "a1"},
		{LastMessageAt: atDay(0), AgentSyncID: "a3"},
		{LastMessageAt: atDay(0), AgentSyncID: "a3"},
	}
	f.summary.EXPECT().ListSummariesByUser(gomock.Any(), testUserID).Return(rows, nil)

	view, err := Activity().Overview(f.ctx, testUserID, "7d")

	require.NoError(t, err)
	assert.Equal(t, []AgentCount{
		{SyncID: "a3", Count: 2}, {SyncID: "a1", Count: 1}, {SyncID: "a2", Count: 1},
	}, view.Agents, "计数降序，并列时按键升序")
}

// TestOverview_EmptyAccountRendersEmptyListsNotNull 覆盖全新账号。
//
// 分布交空切片而不是 nil：nil 在 JSON 里是 null，而前端对这四个字段是直接 map 的，
// null 会让整页白屏 —— 一个刚注册、还没有任何对话的账号正是最常见的输入。
// 没有活动的日子也就没有「最忙的一天」，那一格是 nil 而不是一个计数为 0 的假日期。
func TestOverview_EmptyAccountRendersEmptyListsNotNull(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID}, nil)
	f.summary.EXPECT().ListSummariesByUser(gomock.Any(), testUserID).Return(nil, nil)

	view, err := Activity().Overview(f.ctx, testUserID, "30d")

	require.NoError(t, err)
	assert.NotNil(t, view.Agents)
	assert.NotNil(t, view.Backends)
	assert.NotNil(t, view.Models)
	assert.NotNil(t, view.Projects)
	assert.NotNil(t, view.Heatmap.Days)
	assert.Empty(t, view.Agents)
	assert.Nil(t, view.Heatmap.BusiestDay)
	assert.Zero(t, view.Heatmap.AvgPerActiveDay)
	assert.Zero(t, view.Summary.StreakDays)
}

// TestOverview_AllRangeLeavesBothEndsOpen 覆盖「全部时间」：两端不设界，窗口天数为 0。
// 仓储把空串当「这一端不设界」，所以判据里两端都必须是空串而不是某个猜出来的日期。
func TestOverview_AllRangeLeavesBothEndsOpen(t *testing.T) {
	f := setup(t)
	allQ := activity_repo.DailyQuery{UserID: testUserID}

	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().SumTotal(gomock.Any(), allQ).Return(int64(486), nil).Times(2)
	f.daily.EXPECT().SumByDims(gomock.Any(), allQ, activity_repo.DimDay).
		Return([]activity_repo.DimSum{{Day: day(0), Total: 11}, {Day: day(400), Total: 7}}, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), allQ, activity_repo.DimAgent).Return(nil, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), allQ, activity_repo.DimBackendType).Return(nil, nil)
	f.daily.EXPECT().
		SumByDims(gomock.Any(), allQ, activity_repo.DimProvider, activity_repo.DimModel).
		Return(nil, nil)
	f.daily.EXPECT().SumByDims(gomock.Any(), allQ, activity_repo.DimProject).Return(nil, nil)

	view, err := Activity().Overview(f.ctx, testUserID, "all")

	require.NoError(t, err)
	assert.Zero(t, view.Summary.WindowDays, "不设界就没有「窗口共几天」可言")
	assert.Equal(t, 2, view.Summary.ActiveDays, "两端不设界时活跃天数数的是全部历史")
	assert.Len(t, view.Heatmap.Days, 1, "热力图仍然只有一年")
}

// TestOverview_RollupReadFailureSurfaces 覆盖读失败：原样往上抛，不悄悄画一张空图。
// 一张画着 0 的图与一次读失败在界面上长得一样，而它们要用户做的事完全不同。
func TestOverview_RollupReadFailureSurfaces(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{}, errors.New("boom"))

	_, err := Activity().Overview(f.ctx, testUserID, "30d")

	assert.Error(t, err)
}
