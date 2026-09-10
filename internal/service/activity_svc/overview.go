package activity_svc

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/agentre-hub/agentre-server/internal/pkg/activitystats"
	"github.com/agentre-hub/agentre-server/internal/repository/activity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
)

func (s *activitySvc) Overview(
	ctx context.Context, userID int64, rangeKey string,
) (OverviewView, error) {
	_, loc := activitystats.ServerZone()
	today := time.Now().In(loc).Format(dayLayout)
	// 先判区间键，再读任何东西：一个打错的参数不该先打一趟数据库；而落到某个默认值
	// 会让界面上写着「近 7 天」、数字却是近 30 天的 —— 那种说谎的标签没人会发现。
	from, to, windowDays, err := activitystats.Window(rangeKey, today)
	if err != nil {
		return OverviewView{}, err
	}
	settings, err := user_repo.Settings().Get(ctx, userID)
	if err != nil {
		return OverviewView{}, err
	}

	var counted *series
	if settings.ActivityStatsEnabled {
		counted, err = reportedSeries(ctx, userID, from, to)
	} else {
		counted, err = savedSeries(ctx, userID, from, to)
	}
	if err != nil {
		return OverviewView{}, err
	}
	return counted.view(settings.ActivityStatsEnabled, today, from, to, windowDays), nil
}

// modelKey 是模型分布那一组的键：两维一起，不拆。
type modelKey struct {
	provider string
	model    string
}

// series 是两条路汇合的地方：一份不设界的「日 → 计数」，两个总计，四张分布。
//
// 让上报与已保存两条路都先落到它上面，是「两条路产出的结构体必须完全同形」这条约束的
// 兑现方式：视图只由 view 一处组装，加一个字段时不可能只加在一条路上。
type series struct {
	// allDays 不设界。热力图只要一年，但「历史最长连续」看的是全部历史 —— 只读一年
	// 会让一段更早的记录凭空消失，而它在数据里明明还在。
	allDays map[string]int64
	// total 不设界，windowTotal 是当前区间内的。
	total       int64
	windowTotal int64
	agents      map[string]int64
	backends    map[string]int64
	models      map[modelKey]int64
	projects    map[string]int64
}

func newSeries() *series {
	return &series{
		allDays:  map[string]int64{},
		agents:   map[string]int64{},
		backends: map[string]int64{},
		models:   map[modelKey]int64{},
		projects: map[string]int64{},
	}
}

// reportedSeries 是开关开着那条路：全部数字来自机器上报的日滚存。
//
// 两个总计走 SumTotal 而不是把日序列在 Go 里再加一遍：四张分布卡与它共用仓储那一处
// scoped 判据，卡片加起来因此必然等于它。判据分成两份写（一份在 SQL、一份在这里）
// 正是「这张卡片的数跟总计差了 3」的来源。
//
// 按天那一份是**不设界**读回来的：热力图裁到一年是在这一层做的，而连续天数要全部历史。
func reportedSeries(ctx context.Context, userID int64, from, to string) (*series, error) {
	daily := activity_repo.Daily()
	allQ := activity_repo.DailyQuery{UserID: userID}
	winQ := activity_repo.DailyQuery{UserID: userID, FromDay: from, ToDay: to}

	out := newSeries()
	var err error
	if out.windowTotal, err = daily.SumTotal(ctx, winQ); err != nil {
		return nil, err
	}
	if out.total, err = daily.SumTotal(ctx, allQ); err != nil {
		return nil, err
	}

	days, err := daily.SumByDims(ctx, allQ, activity_repo.DimDay)
	if err != nil {
		return nil, err
	}
	for _, row := range days {
		out.allDays[row.Day] += row.Total
	}

	agents, err := daily.SumByDims(ctx, winQ, activity_repo.DimAgent)
	if err != nil {
		return nil, err
	}
	for _, row := range agents {
		// 键原样落进 map，空串也是。它是「未命名 Agent」那一组的真实键，被跳过的话
		// 这张卡片加起来就比总计少。
		out.agents[row.AgentSyncID] += row.Total
	}

	backends, err := daily.SumByDims(ctx, winQ, activity_repo.DimBackendType)
	if err != nil {
		return nil, err
	}
	for _, row := range backends {
		out.backends[row.BackendType] += row.Total
	}

	models, err := daily.SumByDims(ctx, winQ, activity_repo.DimProvider, activity_repo.DimModel)
	if err != nil {
		return nil, err
	}
	for _, row := range models {
		out.models[modelKey{provider: row.ProviderKey, model: row.ModelKey}] += row.Total
	}

	projects, err := daily.SumByDims(ctx, winQ, activity_repo.DimProject)
	if err != nil {
		return nil, err
	}
	for _, row := range projects {
		out.projects[row.ProjectSyncID] += row.Total
	}
	return out, nil
}

// savedSeries 是开关关着那条路：一条计数都不曾上报过，于是退回账号里**已保存的对话**
// 这一份本来就存在的数据，在 Go 里聚合出同样的形状。
//
// 一条对话按它**最后一次活动**落在一天上，计 1。上报那条路数的是「那天**建立**了几条
// 对话」（activityrollup.Aggregate），两者因此不是同一个口径 —— 响应里的 scope 必须如实
// 说出是哪一条，界面上那条说明条就是为这个差别存在的。
//
// 这里用不了建立时刻：镜像行上的 createtime 是**服务端第一次知道这条对话**的时刻，不是
// 用户建它的时刻。一次补齐会把一批老对话的 createtime 全写成今天，整张热力图塌到一格上
// ——那比口径不一致糟得多。而这条路每次都从完整名单重算，不像上报那条要靠增量累积，所以
// 「最后活动日会走」在这里不构成问题：它自洽。
//
// LastMessageAt == 0 的会话不计数：0 不是 1970-01-01，是「对端从没报过一轮」。按 0 切
// 日界会在热力图最左边凭空长出一格 1970，并把「历史最长连续」的起点拉到那一天。
func savedSeries(ctx context.Context, userID int64, from, to string) (*series, error) {
	// 只读统计用得上的那几列：热力图问的是整段历史（连续天数只有全量答得出），
	// 行数省不掉，但标题与 cwd 这些最占字节的列一个都用不上。
	rows, err := agent_session_repo.Summary().ListSummaryStats(ctx, userID)
	if err != nil {
		return nil, err
	}
	// 日界切在**服务端时区**上，与上报那条路同一套：一个账号下的机器分散在各地，
	// 两套日界会把同一天的活动劈到两格上。
	_, loc := activitystats.ServerZone()
	out := newSeries()
	for _, row := range rows {
		// 0 不是 1970-01-01，是「对端从没报过一轮」。查询已经把这一档筛掉了，这里
		// 仍然判一次：它是这段聚合自己的前提，而不是那条查询顺手带来的性质。
		if row.LastMessageAt == 0 {
			continue
		}
		day := time.UnixMilli(row.LastMessageAt).In(loc).Format(dayLayout)
		out.allDays[day]++
		out.total++
		if !inWindow(day, from, to) {
			continue
		}
		out.windowTotal++
		// 五个维度原样入组，空串也是：它是「跟随 Agent 绑定」「未归属项目」「发起端
		// 没报」这三件事的真实键。
		out.agents[row.AgentSyncID]++
		out.backends[row.BackendType]++
		out.models[modelKey{provider: row.ProviderKey, model: row.ModelKey}]++
		out.projects[row.ProjectSyncID]++
	}
	return out, nil
}

// inWindow 判一天在不在 [from, to] 里，两端都含；空串表示那一端不设界。
//
// 直接比字符串：日界是 "2006-01-02"，逐字节的排序恰好就是日期序（这正是它在库里存成
// char(10) 的理由之一）。解析成 time.Time 再比只会多一处可能出错的地方。
func inWindow(day, from, to string) bool {
	if from != "" && day < from {
		return false
	}
	if to != "" && day > to {
		return false
	}
	return true
}

func (s *series) view(enabled bool, today, from, to string, windowDays int) OverviewView {
	scope := ScopeSaved
	if enabled {
		scope = ScopeFull
	}
	current, longest := activitystats.Streaks(intCounts(s.allDays), today)

	activeDays := 0
	for day, count := range s.allDays {
		if count > 0 && inWindow(day, from, to) {
			activeDays++
		}
	}

	// 交出去的时区名与上面切 today 的那个位置是同一次解析的两半（ServerZone）：
	// 界面上写出来的那个名字，必须就是这些日界被切出来的地方。
	zoneName, _ := activitystats.ServerZone()
	return OverviewView{
		ActivityStatsEnabled: enabled,
		Scope:                scope,
		TimeZone:             zoneName,
		Summary: SummaryView{
			Conversations:      s.windowTotal,
			ConversationsTotal: s.total,
			StreakDays:         current,
			LongestStreakDays:  longest,
			ActiveDays:         activeDays,
			WindowDays:         windowDays,
		},
		Heatmap:  s.heatmap(today),
		Agents:   agentView(s.agents),
		Backends: backendView(s.backends),
		Models:   modelView(s.models),
		Projects: projectView(s.projects),
	}
}

// heatmap 裁出那一年。它**不看** from / to：一年的格子图是这一页的主角，跟着顶栏那个
// 区间控件缩成七格就没有意义了。
func (s *series) heatmap(today string) HeatmapView {
	from, to := activitystats.YearWindow(today)
	days := make([]DayCount, 0, len(s.allDays))
	for day, count := range s.allDays {
		if inWindow(day, from, to) {
			days = append(days, DayCount{Day: day, Count: count})
		}
	}
	sort.Slice(days, func(i, j int) bool { return days[i].Day < days[j].Day })

	var busiest *DayCount
	var activeDays int
	var total int64
	for i := range days {
		// 计数为 0 的行不是活跃的一天：删掉某台机器的数据后可能留下这样的行，把它
		// 算进分母会让「日均」凭空变小。
		if days[i].Count <= 0 {
			continue
		}
		activeDays++
		total += days[i].Count
		if busiest == nil || days[i].Count > busiest.Count {
			day := days[i]
			busiest = &day
		}
	}
	avg := 0.0
	if activeDays > 0 {
		// 保留一位小数：float64 的除法会得出 5.666666666666667，原样进 JSON 就是界面
		// 上那一串小数。四舍五入压在这里而不是交给前端，是因为它是这个数字的定义的
		// 一部分 —— 两个前端各舍各的会得出不同的值。
		avg = math.Round(float64(total)/float64(activeDays)*10) / 10
	}
	return HeatmapView{From: from, To: to, Days: days, BusiestDay: busiest, AvgPerActiveDay: avg}
}

// intCounts 把日计数摊成 activitystats.Streaks 要的形状。
func intCounts(m map[string]int64) map[string]int {
	out := make(map[string]int, len(m))
	for day, count := range m {
		out[day] = int(count)
	}
	return out
}

// ranked 是一张分布排定之后的一行。
type ranked[K comparable] struct {
	key   K
	count int64
}

// rank 把一张「键 → 计数」摊成按计数降序、并列时按键升序排定的切片。
//
// 次序是输出的一部分：map 的遍历序在 Go 里每次都不一样，不排的话同一份数据两次刷新会
// 画出两张次序不同的图，而用户会以为数字变了。并列时再按键排，否则两个同样大的条目
// 仍然会互相换位。
func rank[K comparable](m map[K]int64, order func(K) string) []ranked[K] {
	out := make([]ranked[K], 0, len(m))
	for key, count := range m {
		out = append(out, ranked[K]{key: key, count: count})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].count != out[j].count {
			return out[i].count > out[j].count
		}
		return order(out[i].key) < order(out[j].key)
	})
	return out
}

func sameKey(k string) string { return k }

func agentView(m map[string]int64) []AgentCount {
	out := make([]AgentCount, 0, len(m))
	for _, row := range rank(m, sameKey) {
		out = append(out, AgentCount{SyncID: row.key, Count: row.count})
	}
	return out
}

func backendView(m map[string]int64) []BackendCount {
	out := make([]BackendCount, 0, len(m))
	for _, row := range rank(m, sameKey) {
		out = append(out, BackendCount{BackendType: row.key, Count: row.count})
	}
	return out
}

func modelView(m map[modelKey]int64) []ModelCount {
	// 并列时的次序键把两维接起来，中间那个分隔符是 US（0x1F）：它不会出现在标识里，
	// 所以 ("a", "bc") 与 ("ab", "c") 不会撞成同一个次序键。
	order := func(k modelKey) string { return k.provider + "\x1f" + k.model }
	out := make([]ModelCount, 0, len(m))
	for _, row := range rank(m, order) {
		out = append(out, ModelCount{
			ProviderKey: row.key.provider, ModelKey: row.key.model, Count: row.count,
		})
	}
	return out
}

func projectView(m map[string]int64) []ProjectCount {
	out := make([]ProjectCount, 0, len(m))
	for _, row := range rank(m, sameKey) {
		out = append(out, ProjectCount{SyncID: row.key, Count: row.count})
	}
	return out
}
