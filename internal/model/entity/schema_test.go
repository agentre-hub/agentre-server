package entity_test

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm/schema"
)

// 0.1.0 首发之后，基线建表语句**就是**这套 schema 的全部——没有更早的迁移会再补列。
// 于是「实体上加了一个字段、建表语句里没加对应列」不再是"下一次迁移会补上"，而是直接
// 在第一次 INSERT 上炸。这条守卫把两边对上：实体的每个列都要在建表语句里存在，建表语句
// 的每张表也都要有实体认领（有实体才谈得上漂移）。

// createTableBlock 匹配一条建表语句。基线里的写法统一是 `CREATE TABLE <name> (` 开头、
// `) ENGINE=` 收尾，中间是列与键的定义。
var createTableBlock = regexp.MustCompile(`(?s)CREATE TABLE (?:\x60(\w+)\x60|(\w+)) \((.*?)\n\s*\) ENGINE`)

// columnDefinition 认一行列定义：行内第一个 token 是列名（可能带反引号），后面跟着类型。
//
// 生成列表达式会跨行，续行形如 `peer_fingerprint, agent_sync_id, backend_type,` ——
// 它的第一个 token 以逗号结尾，靠这一点与真正的列定义区分开。
var columnDefinition = regexp.MustCompile(`^\s*\x60?(\w+)\x60?[ \t]+\S`)

// ddlKeyPrefixes 是建表语句里不是列的那些行。
var ddlKeyPrefixes = []string{"PRIMARY ", "UNIQUE ", "KEY ", "INDEX ", "CONSTRAINT ", "FOREIGN ", "CHECK ", "--"}

// parseBaselineDDL 从 migrations 目录的 Go 源码里把每张表的列名读出来。
//
// 建表语句写在函数体里的 raw string 中，所以这里读的是**源码文本**而不是运行结果：
// 迁移函数没法"跑一下看看"（那需要真库），而源码文本已经足够回答"这一列建了没有"。
func parseBaselineDDL(t *testing.T) map[string]map[string]bool {
	t.Helper()

	paths, err := filepath.Glob(filepath.Join("..", "..", "..", "migrations", "*.go"))
	require.NoError(t, err)
	require.NotEmpty(t, paths, "migrations 目录里没有 Go 文件，守卫会静默不生效")

	tables := map[string]map[string]bool{}
	for _, path := range paths {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		source, err := os.ReadFile(path) //nolint:gosec // 守卫读取仓库内枚举出的迁移源码。
		require.NoError(t, err)

		for _, match := range createTableBlock.FindAllStringSubmatch(string(source), -1) {
			name := match[1]
			if name == "" {
				name = match[2]
			}
			columns := map[string]bool{}
			for _, line := range strings.Split(match[3], "\n") {
				trimmed := strings.TrimSpace(line)
				if trimmed == "" || hasAnyPrefix(trimmed, ddlKeyPrefixes) {
					continue
				}
				column := columnDefinition.FindStringSubmatch(line)
				if column == nil {
					continue
				}
				columns[column[1]] = true
			}
			require.NotEmptyf(t, columns, "%s 的建表语句一列都没解析出来，守卫会静默不生效", name)
			tables[name] = columns
		}
	}

	return tables
}

func hasAnyPrefix(line string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(strings.ToUpper(line), prefix) {
			return true
		}
	}
	return false
}

// TestEntityColumnsExistInBaselineDDL 守住实体与建表语句一一对得上。
//
// 只查会被**写入**的字段：`gorm:"…;->"` 的那两个是查询时 join 出来的投影
// （activity 的 dims_hash、session 的 machine_fingerprint），基线里本就不该有它们
// 对应的列。
func TestEntityColumnsExistInBaselineDDL(t *testing.T) {
	tables := parseBaselineDDL(t)

	cache := &sync.Map{}
	claimed := map[string]bool{}
	for _, model := range allEntities() {
		sch, err := schema.Parse(model, cache, schema.NamingStrategy{})
		require.NoErrorf(t, err, "parse %T", model)
		claimed[sch.Table] = true

		columns, ok := tables[sch.Table]
		if !assert.Truef(t, ok, "实体 %T 的表 %q 在建表语句里不存在", model, sch.Table) {
			continue
		}
		for _, field := range sch.Fields {
			// `gorm:"…;->"` 的字段是**投影**，不是本表的一列：它由查询时的 join
			// 提供（activity 的 dims_hash 是生成列、session 的 machine_fingerprint
			// 来自 agent_session_saves），基线里本就不应该建它。会被写入（Creatable
			// 或 Updatable）的字段才是建表语句必须覆盖的那一批。
			if !field.Creatable && !field.Updatable {
				continue
			}
			assert.Truef(t, columns[field.DBName],
				"实体 %T 的字段 %s 映射到列 %q，但表 %q 的建表语句里没有这一列；"+
					"基线就是 schema 本身，没有更晚的迁移会把它补上",
				model, field.Name, field.DBName, sch.Table)
		}
	}

	// 反向：建表语句里的每张表都要有实体认领，否则两边会各走各的。
	var unclaimed []string
	for table := range tables {
		if !claimed[table] {
			unclaimed = append(unclaimed, table)
		}
	}
	sort.Strings(unclaimed)
	// sync_account_seqs 刻意没有实体：它全部走原生 SQL 取号（见 sync_entity 的注释）。
	assert.Equal(t, []string{"sync_account_seqs"}, unclaimed,
		"建表语句里有表没有实体认领；新表要么补实体，要么在这里写明为什么不需要")
}
