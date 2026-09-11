package entity_test

import (
	"sort"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm/schema"
)

// TestNoEntityDeclaresTypeOrNotNull 守住决策 11：实体上不再声明 `type:` /
// `not null`，只保留 `default:`。
//
// 这两个标签只有 GORM 的 AutoMigrate/Migrator 会读；这个项目从不调用它们
// （migrations/migrations.go 里只有一句注释，DDL 全部来自 migrations/*.go 的原生
// SQL），所以它们在运行时没有任何效果，只是与 DDL 渐渐漂移的一份影子声明——正是
// device_entity / device_flow_entity 等六个实体已经出现的 `type:text` 对不上真实
// varchar/mediumtext 列这种情况。`default:` 不在此列：GORM 在 Create 时用它替换
// 零值（schema/field.go 解析、callbacks/create.go 在写入前应用），是有运行时语义
// 的，必须保留。
func TestNoEntityDeclaresTypeOrNotNull(t *testing.T) {
	cache := &sync.Map{}
	var offenders []string
	for _, model := range allEntities() {
		sch, err := schema.Parse(model, cache, schema.NamingStrategy{})
		require.NoErrorf(t, err, "parse %T", model)
		for _, field := range sch.Fields {
			if _, ok := field.TagSettings["TYPE"]; ok {
				offenders = append(offenders, sch.Table+"."+field.DBName+" (type)")
			}
			if _, ok := field.TagSettings["NOT NULL"]; ok {
				offenders = append(offenders, sch.Table+"."+field.DBName+" (not null)")
			}
		}
	}
	sort.Strings(offenders)
	assert.Empty(t, offenders, "以下实体字段仍声明 type:/not null，这两个标签只对不会被调用的 "+
		"GORM Migrator 有意义，且会与 migrations/*.go 的真实 DDL 漂移: %v", offenders)
}
