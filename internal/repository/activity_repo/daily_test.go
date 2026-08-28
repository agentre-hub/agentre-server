package activity_repo

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/activity_entity"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// dims_hash 是数据库自己算的 STORED 生成列。把它写进 INSERT 的列名单里，MySQL 会
// 当场拒绝整条语句（"The value specified for generated column ... is not allowed"），
// 于是**每一次**上报都失败——而这是一条后台路径，没人在界面上看得见它挂了。
//
// 挡住它的是实体上的 `gorm:"->"`（只读），但那是一个远处的标签：谁把它删掉、或者
// 谁新加一个维度列忘了这回事，只有这条测试会红。所以这里钉的是**整份列名单**，
// 而不是「不含 dims_hash」——多一列少一列都该在这里变红。
func TestReplaceBucketsFrom_NeverWritesTheGeneratedDimsHashColumn(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `agent_activity_daily`")).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(
		"INSERT INTO `agent_activity_daily` (`user_id`,`day`,`peer_fingerprint`," +
			"`agent_sync_id`,`backend_type`,`provider_key`,`model_key`,`project_sync_id`," +
			"`session_count`,`createtime`,`updatetime`) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
	)).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	require.NoError(t, r.ReplaceBucketsFrom(ctx, 7, "fp-1", "2026-08-28",
		[]*activity_entity.DailyBucket{{Day: "2026-08-28", SessionCount: 3}}))
	require.NoError(t, mock.ExpectationsWereMet())
}

// 这一段窗口的答案是**替换**，不是合并。
//
// 一台机器交上来的是它对 [sinceDay, ∞) 这一整段的完整答案。合并（upsert 而不先删）
// 只在维度组合一模一样时才对：一条会话在两轮之间换了模型，新组合是一行新桶，而旧
// 组合那一行还留在库里——那一天的总数因此凭空多了一条对话，而计数没有对照物，多了
// 没有任何地方会报错，界面上只是显示了一个更大的数。会话在机器上被删掉时同理。
//
// 删除**只限这台机器、只限下界之后**：别的机器各有各的行，而下界之前的日子已经是
// 终值（按建立日分桶，过去的日子不会再变），把它们删掉再重建等于每轮重传全部历史。
func TestReplaceBucketsFrom_DeletesTheWindowBeforeWritingIt(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"DELETE FROM `agent_activity_daily` WHERE (user_id=? AND peer_fingerprint=?) AND day>=?",
	)+"$").WithArgs(int64(7), "fp-1", "2026-08-20").
		WillReturnResult(sqlmock.NewResult(0, 4))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `agent_activity_daily`")).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	require.NoError(t, r.ReplaceBucketsFrom(ctx, 7, "fp-1", "2026-08-20",
		[]*activity_entity.DailyBucket{{Day: "2026-08-28", SessionCount: 3}}))
	require.NoError(t, mock.ExpectationsWereMet())
}

// 空下界 = 回填 = 这台机器的**全部**历史都由这一次答复重建。
//
// 少了这一条，一次回填只会把新答案叠在旧行上：旧行是上一次口径下写的，两份历史混在
// 同一张表里，而它们看起来一模一样。
func TestReplaceBucketsFrom_NoLowerBoundReplacesTheMachinesWholeHistory(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"DELETE FROM `agent_activity_daily` WHERE user_id=? AND peer_fingerprint=?",
	)+"$").WithArgs(int64(7), "fp-1").WillReturnResult(sqlmock.NewResult(0, 9))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `agent_activity_daily`")).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	require.NoError(t, r.ReplaceBucketsFrom(ctx, 7, "fp-1", "",
		[]*activity_entity.DailyBucket{{Day: "2026-08-28", SessionCount: 3}}))
	require.NoError(t, mock.ExpectationsWereMet())
}

// 账号与机器由**调用方**钉死，而不是采信 buckets 里带的值。
//
// 这些桶是一台远端机器上报的载荷。让载荷自己说它属于哪个账号、哪台机器，等于把主键
// 的两个组成部分交给了对端：报一个别人的 user_id 就写进了别人的统计，报一个别人的
// 指纹就把两台机器的计数并进同一批行。传输层已经认过调用方是谁，这里就必须用那个
// 结论覆盖载荷。
//
// 一并钉住绑定值：只看 SQL 文本看不出覆盖有没有真的发生。
func TestReplaceBucketsFrom_StampsCallerIdentityOverThePayload(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `agent_activity_daily`")).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO `agent_activity_daily`")).
		WithArgs(
			int64(7), "2026-08-28", "fp-caller", // user_id / day / peer_fingerprint
			"agent-1", "claude_code", "prov-anthropic", "sonnet-4-6", "proj-1",
			int32(3), int64(1000), int64(2000),
		).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	payload := &activity_entity.DailyBucket{
		UserID: 999, PeerFingerprint: "fp-someone-else",
		Day: "2026-08-28", AgentSyncID: "agent-1", BackendType: "claude_code",
		ProviderKey: "prov-anthropic", ModelKey: "sonnet-4-6", ProjectSyncID: "proj-1",
		SessionCount: 3, Createtime: 1000, Updatetime: 2000,
	}
	require.NoError(t, r.ReplaceBucketsFrom(ctx, 7, "fp-caller", "2026-08-28",
		[]*activity_entity.DailyBucket{payload}))
	require.NoError(t, mock.ExpectationsWereMet())

	// 覆盖发生在仓储自己的副本上，调用方交进来的结构体原样不动。载荷通常还要被上报
	// 路径拿去记日志或重试，就地改写它会让那些地方看到一份跟自己发出去的不一样的东西。
	require.Equal(t, int64(999), payload.UserID)
	require.Equal(t, "fp-someone-else", payload.PeerFingerprint)
}

// 一台机器这一天什么都没干是常态，不是错误。GORM 对空切片 Create 直接返回
// ErrEmptySlice,照着写就会把「今天没有活动」变成一次上报失败，而重试多少次都还是空的。
//
// 但**删除照发**：空答复的意思是「这一段我什么都没有」，而不是「这一段别动」。一条
// 在机器上被删掉的会话正是靠这条从服务端消失的。
func TestReplaceBucketsFrom_EmptyReportStillClearsTheWindow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM `agent_activity_daily`")).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectCommit()

	require.NoError(t, r.ReplaceBucketsFrom(ctx, 7, "fp-1", "2026-08-28", nil))
	require.NoError(t, mock.ExpectationsWereMet())
}

// 删除必须限定在 user_id 上，而且行数要如实交回。
//
// 少了 WHERE 就是一次全表清空：这张表没有软删除、没有别处的副本，抹掉之后没有任何
// 途径能把别人的统计找回来。行数交给服务层，是因为「关一个从没开过的账号」与「真的
// 删掉了 300 行」在业务上是两回事，而仓储不该替它判——两者都不是错误。
func TestDeleteByUser_ScopedToTheAccountAndReportsRowsAffected(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(
		"DELETE FROM `agent_activity_daily` WHERE user_id=?",
	) + "$").WithArgs(int64(7)).WillReturnResult(sqlmock.NewResult(0, 300))
	mock.ExpectCommit()

	n, err := r.DeleteByUser(ctx, 7)
	require.NoError(t, err)
	require.Equal(t, int64(300), n)
	require.NoError(t, mock.ExpectationsWereMet())
}

// day 一路都是字符串:发起端按服务端时区切好 "2006-01-02" 报上来,库里是 char(10),
// 读出来原样交给热力图当格子的键,下一次增量拉取又原样送回去当 since_day。
//
// 这条测试守的是「SQL 里不再有任何日期格式化」。它曾经有过 —— 早先 day 是 date 列,
// 而本仓所有 DSN 都带 parseTime=True,驱动把它解成 time.Time,GORM 再塞进 string 字段
// 时用 RFC3339Nano,于是一条朴素的 SELECT 拿回 "2026-08-28T00:00:00+08:00",而那个值会
// 原样变成下一次的 since_day。改成 char(10) 之后没有时区语义可供重新解释,格式化也就
// 无处可加;这里钉住它别回来。
//
// 排序压在 day 上,走 idx_agent_activity_daily_machine (user_id, peer_fingerprint, day)
// 的反向扫描取一行。
func TestLatestDay_ReadsTheStoredDayVerbatim(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT day AS latest_day FROM `agent_activity_daily` "+
			"WHERE user_id=? AND peer_fingerprint=? ORDER BY day DESC LIMIT ?",
	)).WithArgs(int64(7), "fp-1", 1).WillReturnRows(
		sqlmock.NewRows([]string{"latest_day"}).AddRow([]byte("2026-08-28")))

	got, err := r.LatestDay(ctx, 7, "fp-1")
	require.NoError(t, err)
	require.Equal(t, "2026-08-28", got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 一台刚接上来的机器一行都没有。那是「从头拉」，不是错误：把它报成错误，第一次
// 上报就永远走不通，而这台机器恰恰是唯一需要全量拉一次的那台。
func TestLatestDay_NoRowsMeansPullFromTheBeginning(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectQuery(regexp.QuoteMeta("FROM `agent_activity_daily`")).
		WillReturnRows(sqlmock.NewRows([]string{"latest_day"}))

	got, err := r.LatestDay(ctx, 7, "fp-new")
	require.NoError(t, err)
	require.Equal(t, "", got)
	require.NoError(t, mock.ExpectationsWereMet())
}

// ── 总览页的聚合读 ────────────────────────────────────────────────────────────

// SUM 在空集上返回的是 NULL，不是 0，而 database/sql 把 NULL 扫进 int64 会直接报错
// （"converting NULL to int64 is unsupported"）。没有 COALESCE 的话，总览页对一个
// 这段区间里没有活动的账号——新号、刚开开关的号、翻到很早那一页的号——不是显示 0，
// 而是整页 500。这是这条读路径上最常走到的输入，不是边角。
func TestSumTotal_CoalescesTheEmptyRangeToZeroInsteadOfFailing(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT COALESCE(SUM(session_count), 0) FROM `agent_activity_daily` "+
			"WHERE user_id=? AND day>=? AND day<=?",
	)).WithArgs(int64(7), "2026-08-01", "2026-08-28").
		WillReturnRows(sqlmock.NewRows([]string{"total"}).AddRow(int64(0)))

	total, err := r.SumTotal(ctx, DailyQuery{
		UserID: 7, FromDay: "2026-08-01", ToDay: "2026-08-28",
	})
	require.NoError(t, err)
	require.Equal(t, int64(0), total)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 日期区间**两端都含**：界面上选的是「8 月 1 日到 8 月 28 日」，用户数的是 28 天。
// 写成 day<? 会悄悄少掉最后一天——那一天恰恰是今天，也就是用户最可能盯着看的那一格。
// 两端为空表示不设界，那是「全部时间」。
func TestDailyQuery_DayRangeIsInclusiveOnBothEnds(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectQuery(regexp.QuoteMeta("WHERE user_id=? AND day>=? AND day<=?")).
		WithArgs(int64(7), "2026-08-01", "2026-08-28").
		WillReturnRows(sqlmock.NewRows([]string{"total"}).AddRow(int64(5)))
	_, err := r.SumTotal(ctx, DailyQuery{UserID: 7, FromDay: "2026-08-01", ToDay: "2026-08-28"})
	require.NoError(t, err)

	// 不设界时那两个判据根本不该出现：一个空串下界会把 day>='' 加进 WHERE，
	// MySQL 拿它跟 date 比会得到零行，「全部时间」于是变成空页。
	mock.ExpectQuery(regexp.QuoteMeta("WHERE user_id=?") + "$").
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"total"}).AddRow(int64(5)))
	_, err = r.SumTotal(ctx, DailyQuery{UserID: 7})
	require.NoError(t, err)

	require.NoError(t, mock.ExpectationsWereMet())
}

// 热力图这一维直接读 day：库里就是 char(10) 的 "2006-01-02"，没有任何格式化。
// 见 TestLatestDay_ReadsTheStoredDayVerbatim 上那段说明——曾经这里必须在 SQL 里
// 格式化，那是 day 还是 date 列的年代留下的。
func TestSumByDims_Day_ReadsTheStoredDayVerbatim(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT day, SUM(session_count) AS total " +
			"FROM `agent_activity_daily` WHERE user_id=? GROUP BY `day`",
	)).WithArgs(int64(7)).WillReturnRows(
		sqlmock.NewRows([]string{"day", "total"}).
			AddRow([]byte("2026-08-27"), int64(4)).
			AddRow([]byte("2026-08-28"), int64(9)))

	out, err := r.SumByDims(ctx, DailyQuery{UserID: 7}, DimDay)
	require.NoError(t, err)
	require.Len(t, out, 2)
	require.Equal(t, "2026-08-27", out[0].Day)
	require.Equal(t, int64(4), out[0].Total)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 模型分布是**两维一组**：(provider_key, model_key)。同一个模型名在两家供应商下是
// 两个模型，只按 model_key 分组会把它们并成一条，而并出来的那条既没有供应商可标、
// 数字也是两家之和。这一维组合正是把聚合做成「一个方法 + 维度列表」而不是
// 「每维一个方法」的理由。
func TestSumByDims_ProviderAndModel_GroupOnBothColumns(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT provider_key, model_key, SUM(session_count) AS total " +
			"FROM `agent_activity_daily` WHERE user_id=? GROUP BY `provider_key`,`model_key`",
	)).WithArgs(int64(7)).WillReturnRows(
		sqlmock.NewRows([]string{"provider_key", "model_key", "total"}).
			AddRow("prov-anthropic", "sonnet-4-6", int64(9)).
			AddRow("prov-openai", "sonnet-4-6", int64(2)))

	out, err := r.SumByDims(ctx, DailyQuery{UserID: 7}, DimProvider, DimModel)
	require.NoError(t, err)
	require.Len(t, out, 2)
	require.Equal(t, "prov-anthropic", out[0].ProviderKey)
	require.Equal(t, "prov-openai", out[1].ProviderKey)
	require.Equal(t, "sonnet-4-6", out[1].ModelKey)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 空串是**有含义的值**，不是缺失（见 activity_entity 的注释）：ProviderKey 与
// ModelKey 皆空 = 这条对话跟随 Agent 绑定，ProjectSyncID 空 = 未归属项目，
// BackendType 空 = 发起端没报。它必须自成一组交上来，让服务层去决定叫它什么。
//
// 这也是聚合读交回切片而不是 map[string]int64 的原因之一：map 那种形状读起来像
// 「键就是名字」，很容易顺手写出一句 `if k == "" { continue }` 把这一组丢掉——
// 于是总览页各卡片的数字加起来比总计少，而且少得没有规律。
func TestSumByDims_EmptyDimValueIsItsOwnGroupNotADroppedRow(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	mock.ExpectQuery(regexp.QuoteMeta("GROUP BY `agent_sync_id`")).
		WillReturnRows(sqlmock.NewRows([]string{"agent_sync_id", "total"}).
			AddRow("", int64(3)).
			AddRow("agent-1", int64(4)))

	out, err := r.SumByDims(ctx, DailyQuery{UserID: 7}, DimAgent)
	require.NoError(t, err)
	require.Len(t, out, 2)
	require.Equal(t, "", out[0].AgentSyncID)
	require.Equal(t, int64(3), out[0].Total)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 维度是一个白名单枚举而不是调用方给的列名字符串：拼进 GROUP BY 的文本永远只能来自
// 这个包，调用方递不进任何 SQL。认不出的值必须当场报错并且**一条语句都不发**——
// 悄悄跳过它就会让「按后端分布」这张卡片去执行一个没有 GROUP BY 的查询，
// 交回全区间的一个总数，而卡片照样把它画成一个分布。
func TestSumByDims_UnknownDimIsRejectedBeforeAnySQL(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	_, err := r.SumByDims(ctx, DailyQuery{UserID: 7}, Dim(200))
	require.Error(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

// 一个维度都不给同样是错误，理由相同：那会退化成一句无分组的总计，而调用它的地方
// 要的是一个分布。空维度列表在这里没有任何合理含义——要总计的调用方有 SumTotal。
func TestSumByDims_NoDimsIsRejectedRatherThanSilentlyTotalling(t *testing.T) {
	ctx, _, mock := hubtest.Database(t)
	r := NewDaily()

	_, err := r.SumByDims(ctx, DailyQuery{UserID: 7})
	require.Error(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}
