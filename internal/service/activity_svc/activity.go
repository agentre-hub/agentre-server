// Package activity_svc 是账号活跃统计那一页的业务层：把「某天、某台机器、某个维度组合
// 下有几条对话」这一堆计数，折算成总览页上那几个数字与四张分布；并管着那个决定服务端
// 到底拉不拉这些计数的开关。
//
// 这一页有**两条路**，由开关说了算，而它们产出的是同一个结构体（OverviewView）：
//
//   - 开关开着（ScopeFull）：数字来自各台机器上报的日滚存（activity_repo）。
//   - 开关关着（ScopeSaved）：一条计数都不曾上报过，于是退回账号里**已保存的对话**
//     这一份本来就存在的数据，在 Go 里聚合出同样的形状。
//
// 同形是硬约束，不是巧合：前端只看 scope 决定要不要显示那条说明条，不走两套渲染。
// 两条路因此在 series 上汇合，视图只由 series.view 一处组装 —— 加一个字段时不可能
// 只加在一条路上。
//
// 日界是 char(10) 的 "2006-01-02"，按**服务端机器所在时区**切，这一层不再做任何时区
// 转换：一个账号下的机器可能分散在不同时区，日界只能有一套，否则同一天的活动会被劈
// 到两格上（activity_entity.DailyBucket.Day 的注释）。
//
// 五个维度上的空串都是**有含义的值**而不是缺失：provider 与 model 皆空 = 这条对话跟
// 随 Agent 绑定；project 空 = 未归属项目；backend 空 = 发起端没报。它们各自成组，既不
// 并进「未知」，也不被跳过 —— 跳过的后果是各卡片加起来比总计少，且少得没有规律，
// 而没有任何地方会报错。
package activity_svc

import (
	"context"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// 这一页的两种口径。它们是响应里的字面值，前端照它分支，改动会破坏前端。
const (
	// ScopeFull：数字来自机器上报的日滚存 —— 开关开着，口径是「全部对话」。
	ScopeFull = "full"
	// ScopeSaved：开关关着，数字只覆盖账号里**已保存的对话**。这是一个更窄的口径，
	// 界面上必须明说，否则用户会把它读成全部。
	ScopeSaved = "saved"
)

// dayLayout 是日界的字面形式，与 agent_activity_daily.day、上报协议的 since_day、
// 以及热力图格子的键逐字一致。它一生都是这个字符串，没有别的表示法。
const dayLayout = "2006-01-02"

type ActivitySvc interface {
	// Overview 组装总览页。rangeKey 是 activitystats 的区间键（"7d" / "30d" / "all"），
	// 认不出的键是错误而不是某个默认值。
	//
	// 热力图**永远是一年**，不跟随 rangeKey：一年的格子图是这一页的主角，跟着顶栏那
	// 个控件缩成七格就没有意义了。控件管的是摘要与三张分布。
	//
	// 设备在线数不在这里：那是设备域的事实，由控制器补上。
	Overview(ctx context.Context, userID int64, rangeKey string) (OverviewView, error)
	// Settings 交出这个账号的活跃统计设置。没有设置行是常态（默认关就不写行），
	// 那时交回的是「关」而不是一次失败。
	Settings(ctx context.Context, userID int64) (SettingsView, error)
	// SetActivityStats 写开关。**关闭同时删掉这个账号的全部计数**：关闭确认弹层里明写
	// 了这一条，两次写在同一个事务里同生共死。
	//
	// backfill 是开启弹层里那个「一并回填本机已有的历史」，**只在 enabled 为真时有
	// 意义**：它决定落库的拉取下界日 —— 勾上写空串（没有下界），取消写今天。关闭时
	// 传什么都被忽略，关闭不表达任何关于回填的意见。
	//
	// 回填不是当场跑一趟，而是**改一个下界**：下一轮定时拉取自然会把历史带上来。这样
	// 一台此刻离线的机器几个月后回来照样补得齐，而当场跑那条路会把它永久漏掉。
	SetActivityStats(ctx context.Context, userID int64, enabled, backfill bool) error
	// ReportedThrough 交出这些机器各自「已上报到哪一天」，键是设备指纹。
	//
	// **从没上报过的机器不在 map 里**，不是映到空串：调用方要据此决定「不画这一段」，
	// 而一个空串会被渲染成一个空的日期占位——那是编出来的状态。
	ReportedThrough(ctx context.Context, userID int64, fingerprints []string) (map[string]string, error)
	// Pull 从一台机器拉一次日滚存并落库。开关关着时直接返回，一个字节都不发。
	Pull(ctx context.Context, userID int64, peer ActivityPeer, peerFingerprint string) error
}

// ActivityPeer 是一台机器上「交出日滚存」这一件事，**只有这一个方法**。
//
// mirror_svc 的 machineConn 结构性满足它。窄到只剩一个方法是刻意的：滚存回包里只有
// 天、几个不透明标识和一个计数，镜像回包里有标题与转录内容。把它并进 RelaySession
// 会让镜像那一侧也够得着滚存，而这两件事的隐私边界不一样（machineconn.go 的注释）。
type ActivityPeer interface {
	ActivityRollup(
		ctx context.Context, req *agentrewire.ActivityRollupRequest,
	) (*agentrewire.ActivityRollupResponse, error)
}

// OverviewView 是总览页的一次完整答复。
//
// 四张分布与热力图的日期列表一律是**空切片而不是 nil**：nil 在 JSON 里是 null，而前端
// 对它们是直接 map 的 —— 一个刚注册、还没有任何对话的账号会让整页白屏，而那正是最常见
// 的输入。
type OverviewView struct {
	ActivityStatsEnabled bool `json:"activity_stats_enabled"`
	// Scope 是这一页数字的口径：ScopeFull 或 ScopeSaved。
	Scope string `json:"scope"`
	// TimeZone 是切日界用的那个时区（服务端机器自己的）。界面上要写出来：
	// 一个在另一个时区的用户否则会觉得自己的「今天」错了一格。
	TimeZone string         `json:"time_zone"`
	Summary  SummaryView    `json:"summary"`
	Heatmap  HeatmapView    `json:"heatmap"`
	Agents   []AgentCount   `json:"agents"`
	Backends []BackendCount `json:"backends"`
	Models   []ModelCount   `json:"models"`
	Projects []ProjectCount `json:"projects"`
}

// SummaryView 是顶上那几格。
type SummaryView struct {
	// Conversations 是**区间内**的总计，ConversationsTotal 是不设界的总计。
	// 两者都在，是因为界面上「近 30 天 143 条」旁边那句「累计 486 条」不是同一个数。
	Conversations      int64 `json:"conversations"`
	ConversationsTotal int64 `json:"conversations_total"`
	// StreakDays / LongestStreakDays 看的是**全部历史**而不是当前区间：一段跨年的
	// 连续记录不该因为控件切到「近 7 天」而缩水。
	StreakDays        int `json:"streak_days"`
	LongestStreakDays int `json:"longest_streak_days"`
	// ActiveDays / WindowDays 是「18 / 30 天」那一格。区间为「全部」时 WindowDays 是 0
	// ——不设界就没有分母可言，界面上那一格该换个说法而不是显示 0。
	ActiveDays int `json:"active_days"`
	WindowDays int `json:"window_days"`
}

// HeatmapView 是那张一年的格子图。From / To 两端都含。
type HeatmapView struct {
	From string     `json:"from"`
	To   string     `json:"to"`
	Days []DayCount `json:"days"`
	// BusiestDay 在没有任何活动时是 nil 而不是一个计数为 0 的假日期：那张卡片此时
	// 根本不该出现，而 {"day":"","count":0} 是画得出来的。
	BusiestDay *DayCount `json:"busiest_day"`
	// AvgPerActiveDay 只除以**有活动的**天数，保留一位小数。除以 365 会把每一个正常
	// 账号都算成「每天 0.4 条」。
	AvgPerActiveDay float64 `json:"avg_per_active_day"`
}

// DayCount 是热力图上的一格。Days 只列出有行的那些天，不补零：前端按 From / To 画满
// 一年的网格，没列出来的那天就是 0。
type DayCount struct {
	Day   string `json:"day"`
	Count int64  `json:"count"`
}

// AgentCount / BackendCount / ModelCount / ProjectCount 是四张分布卡的一行。
//
// 键上的空串是这一组的**真实键**，不是缺省值，所以这里没有「其它」这种兜底组：
// 空的 SyncID = 未命名 / 未归属，由界面决定怎么称呼它。
type AgentCount struct {
	SyncID string `json:"sync_id"`
	Count  int64  `json:"count"`
}

type BackendCount struct {
	BackendType string `json:"backend_type"`
	Count       int64  `json:"count"`
}

// ModelCount 的两维是一组：provider 与 model 皆空 = 跟随 Agent 绑定、provider 非空
// 而 model 空 = 该供应商当前默认。拆成两张卡会把这三种状态混成一堆。
type ModelCount struct {
	ProviderKey string `json:"provider_key"`
	ModelKey    string `json:"model_key"`
	Count       int64  `json:"count"`
}

type ProjectCount struct {
	SyncID string `json:"sync_id"`
	Count  int64  `json:"count"`
}

// SettingsView 是设置页那一行开关。
type SettingsView struct {
	ActivityStatsEnabled bool `json:"activity_stats_enabled"`
	// LastReportAt 是最近一次**成功拉取**的时刻（Unix 毫秒），0 = 从未拉过，取自
	// user_settings.activity_last_pull_at。
	//
	// 它刻意不取 activity_stats_enabled_at（最近一次开启）：一个半年前开了开关、上周
	// 断掉的账号会因此显示「最近一次上报：半年前」。也不取 agent_activity_daily 的
	// MAX(updatetime)：一台一周没干活的机器每轮都在正常上报空结果，那个值却停在一周前。
	// 这个数字存在的全部理由是让用户看出管子断没断。
	LastReportAt int64 `json:"last_report_at"`
	// SavedConversations 是账号里**已保存的对话**条数——设置页上「已保存的对话」那一段。
	//
	// 它与活跃统计是两件事，摆在同一个面板里是因为它们是同一条隐私边界的两侧：一条
	// 对话被保存过，它的标题与转录才会到服务端来（agent_session_saves 就是那个开关）。
	SavedConversations int64 `json:"saved_conversations"`
	// Today 是**服务端**此刻的日界（"2006-01-02"），与 ReportedThrough 交回的那些日子
	// 同一套时区。
	//
	// 它交出去的唯一理由是让界面判得出「这台机器已经上报到今天了」。少了它，前端只能
	// 拿浏览器的今天去比，而两者跨时区时差一天：服务端在 UTC+8 的早上 07:00，浏览器
	// 算出来的今天还是昨天，一台刚上报完的机器会被显示成「已上报到某个看起来像未来的
	// 日期」。
	Today string `json:"today"`
}

type activitySvc struct{}

var defaultActivity ActivitySvc = &activitySvc{}

func Activity() ActivitySvc { return defaultActivity }

// SetDefault 换掉这个包的默认实现，供控制器测试在真实路由树上注入桩（与
// engine_svc / device_svc 同一条约定：接线点归服务包，控制器不持有状态）。
func SetDefault(s ActivitySvc) { defaultActivity = s }

// New 交出一份真实实现，供测试用完还原。
func New() ActivitySvc { return &activitySvc{} }
