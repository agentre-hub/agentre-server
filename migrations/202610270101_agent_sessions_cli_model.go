package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202610270101 给 agent_sessions 加「CLI 自带模型选择」的模式列（规格
// 2026-10-26-cli-native-model-switch「会话镜像」）。逐字镜像发起端那一列：空 = 跟随
// Agent 绑定、cli-default = 用 CLI 自己的默认、fixed = 钉死某个 CLI 模型。
//
// 一条迁移一个 ALTER、一列：schema 守卫（entity/schema_test.go）按 ADD COLUMN 语句
// 逐条认列。类型照抄同表 provider_key。ALGORITHM=INSTANT 在 MySQL 8.4（线上）与 9.7
// （dev）上都可执行，不重建表；LOCK=DEFAULT 让引擎自己挑最宽松的锁。
func migration202610270101() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202610270101",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE agent_sessions ADD COLUMN cli_model_mode varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '', ALGORITHM=INSTANT, LOCK=DEFAULT`).Error
		},
	}
}
