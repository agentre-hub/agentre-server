package migrations

import (
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

// ddlRecorder 是一个只记录、永远匹配的 sqlmock QueryMatcher：迁移的 DDL 不需要被
// 逐句比对，需要的是把它们收集起来对整体做策略断言。
type ddlRecorder struct{ seen *[]string }

func (r ddlRecorder) Match(_, actualSQL string) error {
	*r.seen = append(*r.seen, actualSQL)
	return nil
}

// captureMigrationDDL 直接调用每个迁移的 Migrate，收集它发出的全部 SQL。
//
// 不走 RunMigrations：那会把 gormigrate 自己的建表/记账语句也混进来，而这里要断言的
// 只是我们写的 DDL。
func captureMigrationDDL(t *testing.T) string {
	t.Helper()
	var seen []string
	sqlDB, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(ddlRecorder{seen: &seen}))
	require.NoError(t, err)
	defer func() { _ = sqlDB.Close() }()

	gormDB, err := gorm.Open(mysql.New(mysql.Config{
		Conn: sqlDB, SkipInitializeWithVersion: true,
	}), &gorm.Config{})
	require.NoError(t, err)

	for range 64 {
		mock.ExpectExec(".*").WillReturnResult(sqlmock.NewResult(0, 0))
	}
	for _, m := range migrationList() {
		require.NoError(t, m.Migrate(gormDB), "migration %s", m.ID)
	}
	require.NotEmpty(t, seen)
	return strings.Join(seen, "\n")
}

// 排序规则必须显式选 NO PAD 的那一族。utf8mb4_bin 是 **PAD SPACE**：在它下面
// 'x' 与 'x ' 比较相等，于是尾随空格不同的两个 sync_id 会撞上唯一键、
// `WHERE sync_id=?` 也会取回另一行。PG 的 text 是逐字节比较、尾随空格显著，
// utf8mb4_0900_bin 才是与之等价的那个。这个差别在任何单测和肉眼 review 里都看不出来，
// 只能靠这条断言挡住。
func TestMigrationDDL_NeverUsesPadSpaceCollation(t *testing.T) {
	ddl := captureMigrationDDL(t)

	// utf8mb4_bin 后面不能紧跟别的字符（否则会把 utf8mb4_0900_bin 也匹配掉）。
	padSpace := regexp.MustCompile(`utf8mb4_bin\b`)
	assert.Empty(t, padSpace.FindAllString(ddl, -1),
		"utf8mb4_bin 是 PAD SPACE，会忽略尾随空格；标识列要用 utf8mb4_0900_bin")
}

// 每张表都要钉住引擎与字符集，否则 schema 会随服务器的 character_set_server 变化——
// 同一份迁移在两台配置不同的 MySQL 上会建出语义不同的表。
func TestMigrationDDL_PinsEngineAndCharsetOnEveryTable(t *testing.T) {
	ddl := captureMigrationDDL(t)

	creates := regexp.MustCompile(`(?i)CREATE TABLE\s+(\w+)`).FindAllStringSubmatch(ddl, -1)
	pinned := regexp.MustCompile(`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
	assert.Len(t, pinned.FindAllString(ddl, -1), len(creates),
		"CREATE TABLE 的数量与钉住 ENGINE/CHARSET 的数量必须相等")
}

// 人手输入的标识符按大小写不敏感判等，机器生成的不透明标识按逐字节判等。
//
// email 与 user_code 是人打出来的：同一个人用 "A@b.C" 和 "a@b.c" 注册必须是同一个账号，
// 用小写敲验证码也必须能对上。但用的是 as_ci 而不是表默认的 ai_ci——ai_ci 连重音都折叠，
// 会把 e@x.c 和 é@x.c 当成同一个邮箱，那是两个不同的收件人。
func TestMigrationDDL_HumanEnteredIdentifiersAreCaseInsensitive(t *testing.T) {
	ddl := captureMigrationDDL(t)

	for _, want := range []string{
		"email           varchar(320) COLLATE utf8mb4_0900_as_ci NOT NULL",  // users
		"email           varchar(320) COLLATE utf8mb4_0900_as_ci NOT NULL,", // user_identities
		"user_code           varchar(16) COLLATE utf8mb4_0900_as_ci NOT NULL",
	} {
		assert.Contains(t, ddl, want)
	}
}

// 不透明标识（客户端/服务端生成的同步标识、指纹、凭据、哈希）必须逐字节判等：
// 大小写或尾随空格不同的两个值是两个不同的东西，折叠它们会让同步张冠李戴、
// 也会凭空放宽一个 bearer 凭据的匹配条件。
func TestMigrationDDL_OpaqueIdentifiersAreByteExact(t *testing.T) {
	ddl := captureMigrationDDL(t)

	for _, col := range []string{
		"sync_id", "project_sync_id", "agentred_fingerprint",
		"fingerprint", "client_fingerprint", "device_fingerprint", "session_id",
		"device_code", "refresh_token_hash", "access_jti", "content_hash",
		"provider_uid",
	} {
		pattern := regexp.MustCompile(`\b` + col + `\s+varchar\(\d+\) COLLATE utf8mb4_0900_bin\b`)
		assert.Regexp(t, pattern, ddl, "%s 必须是 utf8mb4_0900_bin", col)
	}
}
