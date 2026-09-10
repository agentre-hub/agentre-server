package activitystats

import (
	"fmt"
	"time"
)

// 区间键。它们同时是 HTTP 查询参数的取值，改动会破坏前端。
const (
	Range7Days  = "7d"
	Range30Days = "30d"
	RangeAll    = "all"
)

// heatmapDays 是热力图固定回看的天数。
//
// 它**不跟随**顶栏那个区间控件：一年的格子图是这一页的主角，跟着控件缩成七格就没有
// 意义了。控件管的是摘要与三张分布卡。
const heatmapDays = 365

// Window 把区间键翻成 [from, to] 两端都含的日界，以及窗口共几天。
//
// 两端都含：界面上「近 7 天」数的是 7 格、含今天。写成开区间会悄悄少掉最后一天——而那
// 一天通常是今天，也就是用户最想看的那一天。
//
// RangeAll 交回两个空串：仓储层把空串当「这一端不设界」。填一个「足够早」的日期是在猜
// 账号的年龄，总有一天猜错。
//
// 未知的区间键报错而不是落到某个默认值：静默落默认的后果是界面上写着「近 7 天」而数字
// 是近 30 天的——一个说谎的标签比一个错误页糟得多，因为没人会发现。
func Window(rangeKey, today string) (from, to string, days int, err error) {
	switch rangeKey {
	case RangeAll:
		return "", "", 0, nil
	case Range7Days:
		days = 7
	case Range30Days:
		days = 30
	default:
		return "", "", 0, fmt.Errorf("activitystats: unknown range %q", rangeKey)
	}

	anchor, err := time.Parse(dayLayout, today)
	if err != nil {
		return "", "", 0, fmt.Errorf("activitystats: parse today %q: %w", today, err)
	}
	// days-1：今天算窗口里的一天。
	return anchor.AddDate(0, 0, -(days - 1)).Format(dayLayout), today, days, nil
}

// YearWindow 交回热力图那一年的两端（都含）。
func YearWindow(today string) (from, to string) {
	anchor, err := time.Parse(dayLayout, today)
	if err != nil {
		return "", ""
	}
	return anchor.AddDate(0, 0, -(heatmapDays - 1)).Format(dayLayout), today
}
