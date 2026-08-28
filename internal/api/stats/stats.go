// Package stats 定义账号活跃统计那一页的读写契约（`/v1/stats/*`）：总览一条读，
// 设置一读一写。
//
// 三条端点都只服务 web 控制台，桌面端不调它们——形状因此完全按前端那份契约
// （frontend/src/lib/stats.ts）来，逐字段对齐，包括几个「有含义的空」：
//
//   - 四张分布与热力图的日期列表一律是**空切片而不是 nil**：nil 在 JSON 里是 null，
//     而前端对它们是直接 map 的，一个刚注册的账号会让整页白屏。
//   - BusiestDay 没有活动时是 null，不是一个 count 为 0 的假日期——后者画得出来。
//   - 设置里那三个可选字段用 omitempty：取不到就**不画那一段**，而不是摆一排「未知」。
package stats

import "github.com/cago-frame/cago/server/mux"

// ---------- 总览 ----------

// OverviewRequest 读一次总览。账号取自浏览器会话，请求里没有任何身份字段。
type OverviewRequest struct {
	mux.Meta `path:"/v1/stats/overview" method:"GET"`
	// Range 是顶栏那个分段控件的三档，只管摘要与四张分布（热力图始终是一年）。
	// 认不出来的值在**绑定层**就被挡住：非法值不该走到服务层再换一个业务错误码回来。
	// 不传按 30d 算，由控制器补——与控制台首屏落在同一档（Overview.tsx 的初始 range），
	// 免得「默认」在两侧是两个不同的值。
	Range string `form:"range" binding:"omitempty,oneof=7d 30d all"`
}

// Summary 是顶上那几格。
type Summary struct {
	Conversations      int64 `json:"conversations"`
	ConversationsTotal int64 `json:"conversations_total"`
	StreakDays         int   `json:"streak_days"`
	LongestStreakDays  int   `json:"longest_streak_days"`
	ActiveDays         int   `json:"active_days"`
	WindowDays         int   `json:"window_days"`
	// DevicesOnline / DevicesTotal 是**设备域**的事实，活跃统计服务刻意不给：
	// 由控制器从设备清单上数出来补进这里。
	DevicesOnline int `json:"devices_online"`
	DevicesTotal  int `json:"devices_total"`
}

// Day 是热力图上的一格。
type Day struct {
	Day   string `json:"day"`
	Count int64  `json:"count"`
}

// Heatmap 是那张一年的格子图，From / To 两端都含。Days 只列出有行的那些天，
// 不补零：前端按 From / To 画满网格，没列出来的那天就是 0。
type Heatmap struct {
	From string `json:"from"`
	To   string `json:"to"`
	Days []Day  `json:"days"`
	// BusiestDay 是指针且**不带 omitempty**：没有活动时它要如实序列化成 null，
	// 前端据此不画那张卡。
	BusiestDay      *Day    `json:"busiest_day"`
	AvgPerActiveDay float64 `json:"avg_per_active_day"`
}

// AgentRow / BackendRow / ModelRow / ProjectRow 是四张分布卡的一行。键上的空串是这一组
// 的**真实键**而不是缺省值（未命名 / 未归属 / 没上报 / 跟随 Agent 绑定），由界面决定
// 怎么称呼它。
type AgentRow struct {
	SyncID string `json:"sync_id"`
	Count  int64  `json:"count"`
}

type BackendRow struct {
	BackendType string `json:"backend_type"`
	Count       int64  `json:"count"`
}

type ModelRow struct {
	ProviderKey string `json:"provider_key"`
	ModelKey    string `json:"model_key"`
	Count       int64  `json:"count"`
}

type ProjectRow struct {
	SyncID string `json:"sync_id"`
	Count  int64  `json:"count"`
}

// OverviewResponse 是总览页的一次完整答复。Scope 为 "saved" 时这些数字只覆盖账号里
// 已保存的对话——前端据此显示那条说明条，两种口径共用同一套渲染。
type OverviewResponse struct {
	ActivityStatsEnabled bool         `json:"activity_stats_enabled"`
	Scope                string       `json:"scope"`
	TimeZone             string       `json:"time_zone"`
	Summary              Summary      `json:"summary"`
	Heatmap              Heatmap      `json:"heatmap"`
	Agents               []AgentRow   `json:"agents"`
	Backends             []BackendRow `json:"backends"`
	Models               []ModelRow   `json:"models"`
	Projects             []ProjectRow `json:"projects"`
}

// ---------- 设置 ----------

// SettingsRequest 读一次活跃统计设置。
type SettingsRequest struct {
	mux.Meta `path:"/v1/stats/settings" method:"GET"`
}

// SaveSettingsRequest 开 / 关活跃统计。
type SaveSettingsRequest struct {
	mux.Meta `path:"/v1/stats/settings" method:"PUT"`
	// ActivityStatsEnabled 是指针 + required：布尔的零值就是一个合法取值，用值类型的话
	// 「显式关闭」与「压根没带这个字段」在服务端长得一模一样。
	ActivityStatsEnabled *bool `json:"activity_stats_enabled" binding:"required"`
	// Backfill 是开启弹层里那个「一并回填本机已有的历史」，只在开启那一次有意义；
	// 关闭时前端不发它，收到的就是零值 false——关闭没有回填这回事。
	Backfill bool `json:"backfill"`
}

// DeviceReport 是一台机器的上报进度。
type DeviceReport struct {
	DeviceID int64  `json:"device_id"`
	Name     string `json:"name"`
	Online   bool   `json:"online"`
	// ReportedThrough 是「已上报到哪一天」（YYYY-MM-DD）。从没上报过的机器**没有这个
	// 字段**，而不是一个空串：空串在前端是一个画得出来的空日期占位。
	ReportedThrough string `json:"reported_through,omitempty"`

	// 这里刻意**没有** pending_backfill_days（前端契约里有这个可选字段）：服务端今天
	// 没有任何地方知道一台机器还差多少天的回填——ReportedThrough 给的是「上报到哪天」，
	// 从它减不出「还差几天」，因为拉取下界本身可以是「没有下界」。编一个数字出来比不给
	// 更糟，前端已经写好了「服务端没有逐台进度可交时就不画这一段」。等数据层真有进度
	// 可交时，在这里加上它。
}

// SettingsResponse 是设置页那一节的全部材料，GET 与 PUT 共用同一份组装。
type SettingsResponse struct {
	ActivityStatsEnabled bool `json:"activity_stats_enabled"`
	// LastReportAt 是最近一次成功拉取的时刻，**Unix 毫秒**（不是秒）。
	//
	// omitempty：0 = 从未拉过 = 「还没有这个事实」，与「服务端给不出」是同一件事，
	// 界面上都该少说一句而不是显示 1970 年。
	LastReportAt int64 `json:"last_report_at,omitempty"`
	// SavedConversations 是账号里已保存的对话条数。
	//
	// **刻意没有 omitempty**：0 是一个要说出来的答案（「还没有保存过对话」），而
	// omitempty 会把它和「服务端给不出这个数」压成同一种线上表现——前端判的是
	// `!== undefined`，于是最常见的新账号反而什么都不显示。
	SavedConversations int64 `json:"saved_conversations"`
	// Today 是**服务端**此刻的日界（YYYY-MM-DD），与 ReportedThrough 同一套时区。
	//
	// 它存在的唯一理由是让前端判得出「这台机器已经上报到今天了」。少了它，前端只能
	// 拿浏览器的今天去比，而两者跨时区时差一天：服务端在 UTC+8 的早上 07:00，浏览器
	// 算出来的今天还是昨天，一台刚上报完的机器会被显示成「已上报到 <一个看起来像未来
	// 的日期>」。
	Today   string         `json:"today"`
	Devices []DeviceReport `json:"devices,omitempty"`
}
