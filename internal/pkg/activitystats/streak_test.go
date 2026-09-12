package activitystats_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/pkg/activitystats"
)

// TestStreaks_CountsBackFromToday 覆盖「当前连续活跃」的常规算法:从今天往回数连续有
// 活动的天数。
func TestStreaks_CountsBackFromToday(t *testing.T) {
	counts := map[string]int{"2026-08-26": 1, "2026-08-27": 3, "2026-08-28": 2}
	current, longest := activitystats.Streaks(counts, "2026-08-28")
	assert.Equal(t, 3, current)
	assert.Equal(t, 3, longest)
}

// TestStreaks_TodayIdleStillCountsThroughYesterday 覆盖设计稿明写的一条:今天还没干活
// 时,连续天数算到昨天为止,**不归 0**。
//
// 归 0 会让每天早上打开控制台的人看到自己的连续记录被清空 —— 而它其实还在,只是今天
// 才刚开始。这个数字是给人看的,不是给判题机看的。
func TestStreaks_TodayIdleStillCountsThroughYesterday(t *testing.T) {
	counts := map[string]int{"2026-08-26": 1, "2026-08-27": 3}
	current, _ := activitystats.Streaks(counts, "2026-08-28")
	assert.Equal(t, 2, current, "今天没活动时算到昨天为止")
}

// TestStreaks_BreaksOnATwoDayGap 覆盖真正的中断:昨天也没有活动时,连续记录才结束。
func TestStreaks_BreaksOnATwoDayGap(t *testing.T) {
	counts := map[string]int{"2026-08-25": 1, "2026-08-26": 1}
	current, longest := activitystats.Streaks(counts, "2026-08-28")
	assert.Equal(t, 0, current, "昨天和今天都没有活动 = 连续记录已经断了")
	assert.Equal(t, 2, longest)
}

// TestStreaks_LongestSpansAnEarlierRun 覆盖「最长连续」看的是全部历史,不是当前这一段。
func TestStreaks_LongestSpansAnEarlierRun(t *testing.T) {
	counts := map[string]int{
		"2026-01-01": 1, "2026-01-02": 1, "2026-01-03": 1, "2026-01-04": 1,
		"2026-08-27": 1, "2026-08-28": 1,
	}
	current, longest := activitystats.Streaks(counts, "2026-08-28")
	assert.Equal(t, 2, current)
	assert.Equal(t, 4, longest)
}

// TestStreaks_ZeroCountsAreNotActivity 覆盖「有行但计数为 0」:那不是活跃的一天。
// 服务端删掉某台机器的数据后可能留下这样的行,把它算成活跃会凭空续上连续记录。
func TestStreaks_ZeroCountsAreNotActivity(t *testing.T) {
	counts := map[string]int{"2026-08-26": 1, "2026-08-27": 0, "2026-08-28": 1}
	current, longest := activitystats.Streaks(counts, "2026-08-28")
	assert.Equal(t, 1, current)
	assert.Equal(t, 1, longest)
}

// TestStreaks_EmptyHistory 覆盖全新账号:没有任何活动时两个数字都是 0,而不是 1。
func TestStreaks_EmptyHistory(t *testing.T) {
	current, longest := activitystats.Streaks(map[string]int{}, "2026-08-28")
	assert.Zero(t, current)
	assert.Zero(t, longest)
}
