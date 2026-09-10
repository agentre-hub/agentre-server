// Package activitystats 是活跃统计的纯计算：从「日期 → 计数」这一份序列派生出总览页
// 上那几个数字。
//
// 它不认识数据库、不认识 HTTP，也不认识时区——日界在进来之前就已经切好了（切在服务端
// 机器的时区上，见 activity_entity.DailyBucket.Day）。
package activitystats

import "time"

// dayLayout 是日界的字面形式，与 agent_activity_daily.day 及上报协议逐字一致。
const dayLayout = "2006-01-02"

// Streaks 从「日期 → 计数」算出当前连续活跃天数与历史最长连续天数。
//
// today 是服务端时区下的今天。**今天还没有活动时，当前连续算到昨天为止，不归 0**：
// 归 0 会让每天早上打开控制台的人看到自己的连续记录被清空——而它其实还在，只是今天才
// 刚开始。这个数字是给人看的。真正的中断是昨天也没有活动。
//
// 计数为 0 的那些天不算活跃：服务端删掉某台机器的数据后可能留下这样的行，把它算成活跃
// 会凭空续上连续记录。
func Streaks(counts map[string]int, today string) (current, longest int) {
	active := make(map[string]bool, len(counts))
	for day, count := range counts {
		if count > 0 {
			active[day] = true
		}
	}
	if len(active) == 0 {
		return 0, 0
	}

	anchor, err := time.Parse(dayLayout, today)
	if err != nil {
		return 0, longestRun(active)
	}
	// 今天没活动就从昨天起数——见上面那条。
	cursor := anchor
	if !active[cursor.Format(dayLayout)] {
		cursor = cursor.AddDate(0, 0, -1)
	}
	for active[cursor.Format(dayLayout)] {
		current++
		cursor = cursor.AddDate(0, 0, -1)
	}
	return current, longestRun(active)
}

// longestRun 数出 active 里最长的一段连续日期。
//
// 从每一段的**起点**（前一天不活跃的那天）往前走，所以每段只被走一遍，总代价是天数的
// 线性倍数，而不是按天数平方。
func longestRun(active map[string]bool) int {
	longest := 0
	for day := range active {
		parsed, err := time.Parse(dayLayout, day)
		if err != nil {
			continue
		}
		if active[parsed.AddDate(0, 0, -1).Format(dayLayout)] {
			continue // 不是段的起点
		}
		run := 0
		for cursor := parsed; active[cursor.Format(dayLayout)]; cursor = cursor.AddDate(0, 0, 1) {
			run++
		}
		if run > longest {
			longest = run
		}
	}
	return longest
}
