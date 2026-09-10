package activity_svc

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
)

// TestSettings_ReportsTheStoredSwitch 覆盖设置页那一行：开关的当下状态与最近一次上报。
// 没有设置行是常态（默认关就不写行），那时交回的是零值而不是一次失败。
//
// LastReportAt 取的是 ActivityLastPullAt（最近一次成功拉取），**不是**
// ActivityStatsEnabledAt（最近一次开启）。用后者顶替的话，一个半年前开了开关、上周就
// 断了的账号会显示「最近一次上报：半年前」——那句话的每一个字都不对。这里给两个不同
// 的时刻，正是为了让顶替这件事测得出来。
func TestSettings_ReportsTheStoredSwitch(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).Return(user_entity.Settings{
		UserID: testUserID, ActivityStatsEnabled: true,
		ActivityStatsEnabledAt: 1756300000000,
		ActivityLastPullAt:     1787900000000,
	}, nil)
	f.save.EXPECT().ListByUser(gomock.Any(), testUserID).
		Return(make([]*agent_session_entity.SessionSave, 3), nil)

	view, err := Activity().Settings(f.ctx, testUserID)

	require.NoError(t, err)
	assert.True(t, view.ActivityStatsEnabled)
	assert.Equal(t, int64(1787900000000), view.LastReportAt)
	assert.Equal(t, int64(3), view.SavedConversations)
}

func TestSettings_NeverEnabledIsZeroNotAnError(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID}, nil)
	f.save.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)

	view, err := Activity().Settings(f.ctx, testUserID)

	require.NoError(t, err)
	assert.False(t, view.ActivityStatsEnabled)
	assert.Zero(t, view.LastReportAt)
}

// TestSetActivityStats_EnableOnlyWritesTheSwitch 覆盖开启：只写开关。
// 开启不该顺手删任何东西 —— 一个开过、关掉、又开回来的账号在这一步没有旧数据可删，
// 而这条路径上多一次 DELETE 就是一次谁也没要求的全表清空。
func TestSetActivityStats_EnableOnlyWritesTheSwitch(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().
		SetActivityStats(gomock.Any(), testUserID, true, gomock.Any(), gomock.Any()).Return(nil)

	require.NoError(t, Activity().SetActivityStats(f.ctx, testUserID, true, true))
}

// TestSetActivityStats_DisableAlsoDeletesEveryCount 覆盖关闭确认弹层里明写的那一条：
// 关闭时已有数据一并删除。
//
// 不删就是骗人：用户读到「已有数据一并删除」并点了确认，而那些计数仍然躺在
// agent_activity_daily 里 —— 它们在界面上不再可见，所以没有任何人会发现。
func TestSetActivityStats_DisableAlsoDeletesEveryCount(t *testing.T) {
	f := setup(t)
	f.db.ExpectBegin()
	f.settings.EXPECT().
		SetActivityStats(gomock.Any(), testUserID, false, gomock.Any(), gomock.Any()).Return(nil)
	f.daily.EXPECT().DeleteByUser(gomock.Any(), testUserID).Return(int64(300), nil)
	f.db.ExpectCommit()

	require.NoError(t, Activity().SetActivityStats(f.ctx, testUserID, false, false))
	assert.NoError(t, f.db.ExpectationsWereMet())
}

// TestSetActivityStats_DisableIsAtomicWhenTheDeleteFails 覆盖删除失败。
//
// 整个操作必须失败并回滚，不能留下「开关关了但数据还在」这种半成品状态：那正是弹层
// 承诺的反面，而且从此没有任何入口会再去删它 —— 开关已经是关的，用户再点一次也只是
// 把一个已经关着的开关又关一遍。两次写因此必须在同一个事务里同生共死。
func TestSetActivityStats_DisableIsAtomicWhenTheDeleteFails(t *testing.T) {
	f := setup(t)
	f.db.ExpectBegin()
	f.settings.EXPECT().
		SetActivityStats(gomock.Any(), testUserID, false, gomock.Any(), gomock.Any()).Return(nil)
	f.daily.EXPECT().DeleteByUser(gomock.Any(), testUserID).
		Return(int64(0), errors.New("boom"))
	f.db.ExpectRollback()

	err := Activity().SetActivityStats(f.ctx, testUserID, false, false)

	assert.Error(t, err)
	assert.NoError(t, f.db.ExpectationsWereMet(), "删除失败必须回滚那次开关写入")
}

// TestSetActivityStats_DisableOnAnAccountThatNeverEnabledIt 覆盖删到 0 行：那不是错误。
// 从没开过的账号关一次也是成功，界面上不该弹一个「关闭失败」。
func TestSetActivityStats_DisableOnAnAccountThatNeverEnabledIt(t *testing.T) {
	f := setup(t)
	f.db.ExpectBegin()
	f.settings.EXPECT().
		SetActivityStats(gomock.Any(), testUserID, false, gomock.Any(), gomock.Any()).Return(nil)
	f.daily.EXPECT().DeleteByUser(gomock.Any(), testUserID).Return(int64(0), nil)
	f.db.ExpectCommit()

	require.NoError(t, Activity().SetActivityStats(f.ctx, testUserID, false, false))
}

// TestSetActivityStats_BackfillDecidesTheFloorWrittenAtEnableTime 守那个复选框真的改变
// 了落库的东西。
//
// 「一并回填本机已有的历史」勾上 = 没有下界（空串），取消 = 下界是今天。取消之后
// 如果仍然写空串，第一次拉取就会把这台机器上全部历史搬上来 —— 用户在弹层里亲手取消
// 的那件事照样发生了，而且没有任何地方会提示他。
func TestSetActivityStats_BackfillDecidesTheFloorWrittenAtEnableTime(t *testing.T) {
	t.Run("勾了回填就没有下界", func(t *testing.T) {
		f := setup(t)
		f.settings.EXPECT().
			SetActivityStats(gomock.Any(), testUserID, true, "", gomock.Any()).Return(nil)

		require.NoError(t, Activity().SetActivityStats(f.ctx, testUserID, true, true))
	})

	t.Run("没勾回填就从今天起", func(t *testing.T) {
		f := setup(t)
		f.settings.EXPECT().
			SetActivityStats(gomock.Any(), testUserID, true, day(0), gomock.Any()).Return(nil)

		require.NoError(t, Activity().SetActivityStats(f.ctx, testUserID, true, false))
	})
}

// TestReportedThrough_MapsEachMachineToTheDayItHasReported 覆盖设置面板里逐台机器
// 那一行「已上报到 X 月 X 日」。
//
// 从没上报过的机器**不在 map 里**，而不是映到空串：调用方要据此决定「不画这一段」，
// 而一个空串在界面上会被渲染成一个空的日期占位 —— 那是编出来的状态。
func TestReportedThrough_MapsEachMachineToTheDayItHasReported(t *testing.T) {
	f := setup(t)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, "fp-a").Return(day(1), nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, "fp-b").Return("", nil)

	got, err := Activity().ReportedThrough(f.ctx, testUserID, []string{"fp-a", "fp-b"})

	require.NoError(t, err)
	assert.Equal(t, map[string]string{"fp-a": day(1)}, got)
}

// TestReportedThrough_NoMachinesTouchesNothing 守空输入：一条语句都不发。
// 一个刚注册、还没有任何设备的账号会走到这里，而它不该产生一次数据库往返。
func TestReportedThrough_NoMachinesTouchesNothing(t *testing.T) {
	f := setup(t)

	got, err := Activity().ReportedThrough(f.ctx, testUserID, nil)

	require.NoError(t, err)
	assert.Empty(t, got)
}
