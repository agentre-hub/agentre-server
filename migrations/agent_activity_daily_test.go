package migrations

import (
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

// recordDDL 收集一条迁移发出的全部 SQL。DDL 不需要逐句比对，需要的是对整体做策略断言。
type recordDDL struct{ seen *[]string }

func (r recordDDL) Match(_, actualSQL string) error {
	*r.seen = append(*r.seen, actualSQL)
	return nil
}

func captureDDL(t *testing.T, migrate func(*gorm.DB) error) string {
	t.Helper()
	var seen []string
	sqlDB, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(recordDDL{seen: &seen}))
	require.NoError(t, err)
	t.Cleanup(func() { _ = sqlDB.Close() })
	mock.MatchExpectationsInOrder(false)
	mock.ExpectExec(".*").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(".*").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(".*").WillReturnResult(sqlmock.NewResult(0, 0))

	gormDB, err := gorm.Open(mysql.New(mysql.Config{Conn: sqlDB, SkipInitializeWithVersion: true}), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, migrate(gormDB))
	return strings.Join(seen, "\n")
}

// TestActivityMigration_CreatesBothTables 守这条迁移建出活跃统计要用的两张表:
// 日滚存本身,以及那个默认关闭的开关住的地方。
func TestActivityMigration_CreatesBothTables(t *testing.T) {
	ddl := captureDDL(t, migration202608280002().Migrate)
	assert.Contains(t, ddl, "CREATE TABLE agent_activity_daily")
	assert.Contains(t, ddl, "CREATE TABLE user_settings")
}

// TestActivityMigration_PrimaryKeyDoesNotConcatenateTheDimensionColumns 守主键的形状。
//
// 「(账号, 日期, 六个维度)」是这张表的天然唯一键,但六个 varchar(255) 直接拼进主键有
// 5000+ 字节,超过 InnoDB 3072 字节的索引上限,建表当场就失败。所以维度折成一列
// dims_hash 参与主键,维度本身仍作为普通列留着供分组。
//
// 这条断言钉的是「主键里没有维度列名」——它比「有 dims_hash」更难被绕过:有人把维度
// 塞回主键时,这里必红。
func TestActivityMigration_PrimaryKeyDoesNotConcatenateTheDimensionColumns(t *testing.T) {
	ddl := captureDDL(t, migration202608280002().Migrate)

	start := strings.Index(ddl, "PRIMARY KEY (user_id, day")
	require.NotEqual(t, -1, start, "主键必须从 (user_id, day 起头")
	primaryKey := ddl[start : start+strings.Index(ddl[start:], ")")+1]

	assert.Contains(t, primaryKey, "dims_hash")
	for _, dimension := range []string{"agent_sync_id", "backend_type", "provider_key", "model_key", "project_sync_id"} {
		assert.NotContains(t, primaryKey, dimension,
			"维度列不能直接进主键：六个 varchar(255) 拼起来超过 InnoDB 的索引上限")
	}
}

// TestActivityMigration_DimensionsCompareByteForByte 守维度列的排序规则。
//
// 同步标识是不透明标识,大小写不敏感的比较会把两个不同的标识认成同一个,两个 Agent 的
// 计数就并进了一个桶 —— 而这是一张只读作统计的表,并错了没人会发现。
func TestActivityMigration_DimensionsCompareByteForByte(t *testing.T) {
	ddl := captureDDL(t, migration202608280002().Migrate)
	for _, dimension := range []string{"peer_fingerprint", "agent_sync_id", "provider_key", "model_key", "project_sync_id"} {
		line := ""
		for _, candidate := range strings.Split(ddl, "\n") {
			if strings.Contains(candidate, dimension+" ") {
				line = candidate
				break
			}
		}
		require.NotEmpty(t, line, "找不到列 %s", dimension)
		assert.Contains(t, line, "utf8mb4_0900_bin", "%s 必须逐字节判等", dimension)
	}
}

// TestActivityMigration_ActivityStatsAreOffByDefault 守那个开关的默认值。
//
// 默认开等于替用户做了决定,而这个开关的全部意义就是「用户显式同意之后才上报」。
// DEFAULT 0 是这条承诺在 schema 上的落点。
func TestActivityMigration_ActivityStatsAreOffByDefault(t *testing.T) {
	ddl := captureDDL(t, migration202608280002().Migrate)
	assert.Regexp(t, `activity_stats_enabled\s+tinyint\(1\) NOT NULL DEFAULT 0`, ddl)
}

// TestActivityMigration_DayIsStoredAsTextNotDate 守 day 的列类型。
//
// 看着像退步，其实是这一列唯一正确的形状：日界在发起端就按服务端时区切成
// "2006-01-02" 了，它的一生都是这个字符串——前端拿它当热力图格子的键，下一次增量拉取
// 又原样送回去当 since_day。
//
// 换回 date 会立刻重新引入一个真实的 bug：本仓所有 DSN 都带 parseTime=True，驱动把
// date 解成 time.Time，GORM 再塞进实体的 string 字段时用 RFC3339Nano——整行扫回来的
// day 是 "2026-08-28T00:00:00+08:00"，而那个值会原样发给机器当 since_day。
func TestActivityMigration_DayIsStoredAsTextNotDate(t *testing.T) {
	ddl := captureDDL(t, migration202608280002().Migrate)
	assert.Regexp(t, `day\s+char\(10\) COLLATE utf8mb4_0900_bin NOT NULL`, ddl)
	assert.NotRegexp(t, `day\s+date`, ddl, "day 不能是 date：见本测试的注释")
}

// TestActivityMigration_UserSettingsRecordsTheLastSuccessfulPull 守「最近一次上报」
// 有自己的落点。
//
// 界面上那句「已开启 · 最近一次上报 12 分钟前」回答的是「这条管子还通着吗」。拿
// activity_stats_enabled_at（最近一次**开启**）顶替它是句假话;拿
// agent_activity_daily 的 MAX(updatetime) 顶替也不对 —— 一台一周没干活的机器每轮都
// 成功上报一个空结果,那个值却停在一周前,于是界面报「一周没上报」而实际上一直在通。
//
// 所以它必须由 Pull 自己在每一次成功之后写下,不管这一轮有没有拉到桶。
func TestActivityMigration_UserSettingsRecordsTheLastSuccessfulPull(t *testing.T) {
	ddl := captureDDL(t, migration202608280002().Migrate)
	assert.Regexp(t, `activity_last_pull_at\s+bigint NOT NULL DEFAULT 0`, ddl)
}

// TestActivityMigration_UserSettingsCarriesTheBackfillFloor 守「不回填」这个选择真的
// 存得下来。
//
// 开启弹层里那个「一并回填本机已有的历史」复选框是可以取消的，而取消它之后必须有一
// 个**持久**的下界：拉取的 since_day 取自「这台机器已经收到的最后一天」，一台从没上
// 报过的机器那个值是空串，而空串的意思正是「把你有的全给我」—— 少了这一列，取消回填
// 与勾上回填跑出来的结果一模一样，用户的选择静默失效。
//
// 存成 char(10) 而不是 date，与 agent_activity_daily.day 同一条理由：它一生都是那个
// 字符串。空串是有含义的值 —— 「没有下界」，也就是回填。
func TestActivityMigration_UserSettingsCarriesTheBackfillFloor(t *testing.T) {
	ddl := captureDDL(t, migration202608280002().Migrate)

	line := ""
	for _, candidate := range strings.Split(ddl, "\n") {
		if strings.Contains(candidate, "activity_backfill_from") {
			line = candidate
			break
		}
	}
	require.NotEmpty(t, line, "user_settings 必须有 activity_backfill_from 这一列")
	assert.Contains(t, line, "char(10)", "下界与 day 同形，一生都是 YYYY-MM-DD 这个字符串")
	assert.Contains(t, line, "DEFAULT ''", "空串 = 没有下界 = 回填，这是老行的正确取值")
}
