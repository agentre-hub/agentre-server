package activitystats_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/pkg/activitystats"
)

// TestWindow_CountsTodayAsOneOfTheDays 覆盖窗口的两端都含。
//
// 「近 7 天」在界面上数的是 7 格,含今天。写成「今天往前 7 天」会得到 8 格,而摘要格上
// 那句「18 / 30 天」的分母也会跟着错一天。
func TestWindow_CountsTodayAsOneOfTheDays(t *testing.T) {
	from, to, days, err := activitystats.Window("7d", "2026-08-28")
	require.NoError(t, err)
	assert.Equal(t, "2026-08-22", from)
	assert.Equal(t, "2026-08-28", to)
	assert.Equal(t, 7, days)
}

func TestWindow_ThirtyDays(t *testing.T) {
	from, to, days, err := activitystats.Window("30d", "2026-08-28")
	require.NoError(t, err)
	assert.Equal(t, "2026-07-30", from)
	assert.Equal(t, "2026-08-28", to)
	assert.Equal(t, 30, days)
}

// TestWindow_AllLeavesBothEndsOpen 覆盖「全部」:两端不设界。
//
// 空串而不是某个很早的日期 —— 仓储层把空串当「这一端不设界」,填一个「足够早」的日期
// 是在猜账号的年龄,总有一天猜错。
func TestWindow_AllLeavesBothEndsOpen(t *testing.T) {
	from, to, days, err := activitystats.Window("all", "2026-08-28")
	require.NoError(t, err)
	assert.Empty(t, from)
	assert.Empty(t, to)
	assert.Zero(t, days, "不设界就没有「窗口共几天」可言")
}

// TestWindow_UnknownRangeIsAnError 覆盖未知区间键:报错,不静默落到某个默认值。
//
// 静默落默认的后果是界面上写着「近 7 天」而数字是近 30 天的 —— 一个说谎的标签比一个
// 错误页糟得多,因为没人会发现。
func TestWindow_UnknownRangeIsAnError(t *testing.T) {
	_, _, _, err := activitystats.Window("90d", "2026-08-28")
	assert.Error(t, err)
}

// TestYearWindow_CoversTheLastThreeHundredSixtyFiveDays 覆盖热力图那一年。
//
// 它与顶栏那个区间控件**互不影响**:控件切到「近 7 天」时热力图仍然是一整年 —— 一年的
// 格子图是这一页的主角,跟着控件缩成七格就没有意义了。
func TestYearWindow_CoversTheLastThreeHundredSixtyFiveDays(t *testing.T) {
	from, to := activitystats.YearWindow("2026-08-28")
	assert.Equal(t, "2025-08-29", from)
	assert.Equal(t, "2026-08-28", to)
}
