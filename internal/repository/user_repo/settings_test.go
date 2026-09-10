package user_repo

import (
	"errors"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/require"

	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// 没有行 = 全部取默认值，而默认必须是「关」。
//
// 绝大多数账号从来不会有 user_settings 行——开关默认关，不开就不写。所以「查不到」
// 是这条读路径上最常见的结果，把它当错误会让每一次读设置都失败；把它当
// (nil, nil)（本仓 FindXxx 的既有约定）则要求每个调用方记得判 nil，而漏判一次拿到的
// 是一个 panic，或者更糟——某个 `if s != nil && s.ActivityStatsEnabled` 的反面被写成了
// 「没有行就当开着」，于是从没同意过的账号开始上报。
//
// 交回值类型而不是指针，就是为了让「没有 nil 这回事」成为类型上的事实：调用方
// 想漏判也无从漏起。
func TestSettingsGet_NoRowMeansDefaultsOffNotAnError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectQuery(regexp.QuoteMeta("FROM `user_settings` WHERE user_id=? LIMIT ?")).
		WithArgs(int64(7), 1).
		WillReturnRows(sqlmock.NewRows([]string{"user_id", "activity_stats_enabled"}))

	got, err := r.Get(ctx, 7)
	require.NoError(t, err)
	require.False(t, got.ActivityStatsEnabled)
	require.Equal(t, int64(0), got.ActivityStatsEnabledAt)
	// 账号号仍要填上：调用方拿着这个零值去渲染设置页，它得知道这是谁的设置。
	require.Equal(t, int64(7), got.UserID)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 「没有行」与「读不到」是两回事，只有前者是默认值。
//
// 连库失败、超时、权限错都必须原样往上抛。把它们一起吞成零值，等于在数据库出问题的
// 那一刻对每个账号回答「你没开过活跃统计」——设置页会把一个开着的开关画成关的，
// 而用户点一下「开启」就是一次真实的状态覆盖。
func TestSettingsGet_ARealQueryErrorIsNotSwallowedIntoDefaults(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	boom := errors.New("connection refused")
	mock.ExpectQuery(regexp.QuoteMeta("FROM `user_settings`")).WillReturnError(boom)

	_, err := r.Get(ctx, 7)
	require.ErrorIs(t, err, boom)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestSettingsGet_ReturnsTheStoredRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectQuery(regexp.QuoteMeta("FROM `user_settings` WHERE user_id=? LIMIT ?")).
		WithArgs(int64(7), 1).
		WillReturnRows(sqlmock.NewRows([]string{
			"user_id", "activity_stats_enabled", "activity_stats_enabled_at",
		}).AddRow(int64(7), true, int64(1700000000000)))

	got, err := r.Get(ctx, 7)
	require.NoError(t, err)
	require.True(t, got.ActivityStatsEnabled)
	require.Equal(t, int64(1700000000000), got.ActivityStatsEnabledAt)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 开启走 upsert，一条语句：这个账号从来没有过设置行是常态（默认关就不写），
// 所以「先查再插或改」在这里是主路径而不是边角，而它在两个副本上会双双查空、
// 双双 INSERT，竞败方撞主键拿到一个约束错误——用户点一下开关看到 500。
//
// user_settings 上只有主键这一个唯一键，因此 ON DUPLICATE KEY UPDATE 命中的必然是它
// （docs/architecture.md「只在表恰好一个唯一键时安全」）。
//
// createtime 不在赋值列里：命中已有行时保留它首次落地的时间。
// activity_last_pull_at 出现在插入列里（新行从未拉过，写 0），但**刻意不在赋值列里**：
// 命中已有行时，用户按一下开关不该把「最近一次上报」抹掉。下面钉死的赋值列锚到行尾，
// 它一旦混进去这里就红。
func TestSetActivityStats_EnableIsASingleUpsertThatStampsTheMoment(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"INSERT INTO `user_settings` (`activity_stats_enabled`,"+
			"`activity_stats_enabled_at`,`activity_last_pull_at`,`activity_backfill_from`,"+
			"`createtime`,`updatetime`,`user_id`) VALUES (?,?,?,?,?,?,?) "+
			"ON DUPLICATE KEY UPDATE `activity_stats_enabled`=VALUES(`activity_stats_enabled`),"+
			"`activity_stats_enabled_at`=VALUES(`activity_stats_enabled_at`),"+
			"`activity_backfill_from`=VALUES(`activity_backfill_from`),"+
			"`updatetime`=VALUES(`updatetime`)",
	)+"$").WithArgs(
		true, int64(1700000000000), int64(0), "2026-08-28",
		int64(1700000000000), int64(1700000000000), int64(7),
	).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	require.NoError(t, r.SetActivityStats(ctx, 7, true, "2026-08-28", 1700000000000))
	require.NoError(t, mock.ExpectationsWereMet())
}

// 关闭时 activity_stats_enabled_at **不在赋值列里**。
//
// 那一列的含义是「最近一次开启的时刻」（见实体注释），关闭并不改变最近一次开启是
// 什么时候。让它跟着一起写，关闭就会把它抹成 0，而 0 的含义是「从未开启」——一个开过
// 又关掉的账号从此与一个从没开过的账号在数据上完全一样，再也分不出来。
//
// 这条判断压在 SQL 的赋值列上而不是交给调用方传值，是因为它是这一行自身的不变量，
// 不是某个调用方的业务选择：放出去就意味着任何一处调用写错一个参数都能把它毁掉。
// 新插入的那一行仍然写 0，因为它确实从未开启过。
func TestSetActivityStats_DisableKeepsTheLastEnabledMoment(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"INSERT INTO `user_settings` (`activity_stats_enabled`,"+
			"`activity_stats_enabled_at`,`activity_last_pull_at`,`activity_backfill_from`,"+
			"`createtime`,`updatetime`,`user_id`) VALUES (?,?,?,?,?,?,?) "+
			"ON DUPLICATE KEY UPDATE `activity_stats_enabled`=VALUES(`activity_stats_enabled`),"+
			"`updatetime`=VALUES(`updatetime`)",
	)+"$").WithArgs(
		false, int64(0), int64(0), "", int64(1700000000000), int64(1700000000000), int64(7),
	).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	require.NoError(t, r.SetActivityStats(ctx, 7, false, "2026-08-28", 1700000000000))
	require.NoError(t, mock.ExpectationsWereMet())
}

// TestSettings_TouchActivityPull_RecordsEverySuccessfulPull 覆盖「最近一次上报」的写入。
//
// 它只写 activity_last_pull_at 与 updatetime：开关本身、开启时刻都不能被这条路径碰到。
// 拉取每轮都跑，一旦它顺手写了 activity_stats_enabled，某一次并发写就会把用户刚关掉的
// 开关重新打开——而那是一个隐私开关。
func TestSettings_TouchActivityPull_RecordsEverySuccessfulPull(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"ON DUPLICATE KEY UPDATE `activity_last_pull_at`=VALUES(`activity_last_pull_at`)," +
			"`updatetime`=VALUES(`updatetime`)",
	)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	require.NoError(t, r.TouchActivityPull(ctx, 7, 1787900000000))
	require.NoError(t, mock.ExpectationsWereMet())
}

// TestSetActivityStats_BackfillAsksForNoFloorAtAll 覆盖「勾了回填」那一次开启。
//
// 空串是**有含义的值**：没有下界，也就是「把你有的全给我」。它与「没勾回填」写的当天
// 走的是同一条语句、同一个赋值列——两者的区别只有这一个参数的值，而不是两种模式。
func TestSetActivityStats_BackfillAsksForNoFloorAtAll(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("`activity_backfill_from`=VALUES(`activity_backfill_from`)")).
		WithArgs(true, int64(1700000000000), int64(0), "",
			int64(1700000000000), int64(1700000000000), int64(7)).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	require.NoError(t, r.SetActivityStats(ctx, 7, true, "", 1700000000000))
	require.NoError(t, mock.ExpectationsWereMet())
}

// TestSetActivityStats_DisableLeavesTheFloorAlone 守关闭**不碰**下界。
//
// 关闭是「停止上报并删掉已有计数」，它不表达任何关于回填的意见。让下界跟着关闭一起被
// 写成空串，用户下一次开启（哪怕明确不勾回填）也会被当成要回填——他上一次亲手取消的
// 那个选择，被一次无关的关闭动作翻了过来。
func TestSetActivityStats_DisableLeavesTheFloorAlone(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"ON DUPLICATE KEY UPDATE `activity_stats_enabled`=VALUES(`activity_stats_enabled`),"+
			"`updatetime`=VALUES(`updatetime`)",
	) + "$").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	require.NoError(t, r.SetActivityStats(ctx, 7, false, "", 1700000000000))
	require.NoError(t, mock.ExpectationsWereMet())
}

// TestSettings_ListEnabledUserIDs_OnlyTheAccountsThatSaidYes 是定时拉取那一轮的取材。
//
// 它按开关过滤而不是「全表扫一遍再在 Go 里判」：这张表上绝大多数账号根本没有行，而
// 有行的账号里还有关掉的。把过滤写在 SQL 里，是让「没同意过的账号一台机器都不会被拨」
// 成为这条路径的结构，而不是某个 if 的正确性。
func TestSettings_ListEnabledUserIDs_OnlyTheAccountsThatSaidYes(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT `user_id` FROM `user_settings` WHERE activity_stats_enabled=?")).
		WithArgs(true).
		WillReturnRows(sqlmock.NewRows([]string{"user_id"}).AddRow(int64(7)).AddRow(int64(9)))

	got, err := r.ListEnabledUserIDs(ctx)
	require.NoError(t, err)
	require.Equal(t, []int64{7, 9}, got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// TestSettings_ListEnabledUserIDs_NobodyOptedInIsAnEmptySliceNotAnError 守空结果。
//
// 一个谁都没开过的部署是最常见的部署。它必须是「这一轮没有账号要拉」，而不是一次失败
// ——失败会让定时任务每个周期在日志里留一条错误，把一个完全正常的状态报成故障。
func TestSettings_ListEnabledUserIDs_NobodyOptedInIsAnEmptySliceNotAnError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectQuery(regexp.QuoteMeta("FROM `user_settings`")).
		WillReturnRows(sqlmock.NewRows([]string{"user_id"}))

	got, err := r.ListEnabledUserIDs(ctx)
	require.NoError(t, err)
	require.Empty(t, got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// TestSettings_ActivityStatsEnabledForUpdate_LocksTheSwitchRow 覆盖落库前的那次复核。
//
// 拉取是「读开关 → 发 RPC（往返以秒计）→ 落库」。用户在往返途中关掉开关时，关闭那条
// 路会在一个事务里落开关并删光计数，而这次在途的拉取随后把桶写了回去 —— 开关是关的，
// 数据却在，而且从此没有任何入口会再去删它。
//
// 复核必须**带行锁**而不是普通读：两条路都要碰 user_settings 的同一行，行锁让它们排队
// —— 要么拉取先落库、关闭随后连新写的一起删掉，要么关闭先提交、复核读到「关」，一行
// 都不落。不带锁的读只是把窗口从几秒缩到几微秒，而竞态还在。
func TestSettings_ActivityStatsEnabledForUpdate_LocksTheSwitchRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT `activity_stats_enabled` FROM `user_settings` WHERE user_id=? LIMIT ? FOR UPDATE")).
		WithArgs(int64(7), 1).
		WillReturnRows(sqlmock.NewRows([]string{"activity_stats_enabled"}).AddRow(true))

	got, err := r.ActivityStatsEnabledForUpdate(ctx, 7)
	require.NoError(t, err)
	require.True(t, got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// TestSettings_ActivityStatsEnabledForUpdate_NoRowIsOffNotAnError 守没有行那一路。
// 没有设置行 = 从没开过 = 关，与 Get 同一条约定；把它当错误会让一次正常的拉取失败。
func TestSettings_ActivityStatsEnabledForUpdate_NoRowIsOffNotAnError(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewSettings()

	mock.ExpectQuery(regexp.QuoteMeta("FROM `user_settings`")).
		WillReturnRows(sqlmock.NewRows([]string{"activity_stats_enabled"}))

	got, err := r.ActivityStatsEnabledForUpdate(ctx, 7)
	require.NoError(t, err)
	require.False(t, got)
	require.NoError(t, mock.ExpectationsWereMet())
}
