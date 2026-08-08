// Package migrations 汇总并执行 agentre-server PostgreSQL 全部迁移。
//
// 规范：
//   - 文件名前缀 = 时间戳排序键（YYYYMMDDNNNN），调用顺序按时间升序。
//   - 每个迁移返回一个 *gormigrate.Migration。
//   - 一次迁移只做一件事。
//   - DDL 用原生 SQL，不依赖 GORM AutoMigrate。
//   - 禁止改动既有迁移；修复请新增补丁迁移。
package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// RunMigrations 执行所有迁移。
func RunMigrations(db *gorm.DB) error {
	m := gormigrate.New(db, gormigrate.DefaultOptions, migrationList())
	return m.Migrate()
}

func migrationList() []*gormigrate.Migration {
	return []*gormigrate.Migration{
		migration202605200001(),
		migration202605200002(),
		migration202605200003(),
		migration202605200004(),
		migration202605200005(),
	}
}
