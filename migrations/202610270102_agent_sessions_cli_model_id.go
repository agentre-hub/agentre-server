package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202610270102 给 agent_sessions 加 CLI 模型 id 列：仅 cli_model_mode=fixed
// 时有值，其余为空。与 202610270101 分开一条，原因与写法见那里。
func migration202610270102() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202610270102",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE agent_sessions ADD COLUMN cli_model varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '', ALGORITHM=INSTANT, LOCK=DEFAULT`).Error
		},
	}
}
