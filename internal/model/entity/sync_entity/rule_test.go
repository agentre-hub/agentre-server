package sync_entity

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// R4：同步版本号较大者胜。
func TestWins_GivenDifferentVersions_ThenHigherVersionWins(t *testing.T) {
	newer := &SyncObject{Version: 9, SourceDeviceID: 1}
	older := &SyncObject{Version: 8, SourceDeviceID: 99}
	assert.True(t, newer.Wins(older))
	assert.False(t, older.Wins(newer))
}

// R4 的兜底：版本号相同时按来源设备标识打破平局。版本号取自账号级单调序列，
// 这一条实际上永不触发，但它保证任意两个版本都可比、任意到达顺序下结果相同。
func TestWins_GivenEqualVersions_ThenSourceDeviceBreaksTie(t *testing.T) {
	a := &SyncObject{Version: 9, SourceDeviceID: 5}
	b := &SyncObject{Version: 9, SourceDeviceID: 4}
	assert.True(t, a.Wins(b))
	assert.False(t, b.Wins(a))
	// 全等时谁也赢不了对方——比较是全序的，不会两边都判胜。
	assert.False(t, a.Wins(&SyncObject{Version: 9, SourceDeviceID: 5}))
}

// 客户端提交的时间戳一律不参与胜负：时间戳更新的那一方版本更低时照样输。
func TestWins_GivenClientTimestamps_ThenTheyDoNotDecide(t *testing.T) {
	stale := &SyncObject{Version: 9, SourceDeviceID: 1, SyncUpdatedAt: 1}
	fresh := &SyncObject{Version: 8, SourceDeviceID: 1, SyncUpdatedAt: 1 << 40}
	assert.True(t, stale.Wins(fresh))
	assert.False(t, fresh.Wins(stale))
}

func TestWins_GivenNilOther_ThenWins(t *testing.T) {
	assert.True(t, (&SyncObject{Version: 1}).Wins(nil))
}
