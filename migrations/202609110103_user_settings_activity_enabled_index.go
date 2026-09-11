package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609110103 给 user_settings 加一根覆盖 ListEnabledUserIDs 的索引。
//
// 原本只有 uk_user_settings_identity(user_id)，按 activity_stats_enabled 过滤要
// 全表扫描；加上 (activity_stats_enabled, user_id) 后是一次覆盖索引查找，
// 不用回表（决策 12）。
func migration202609110103() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609110103",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				ALTER TABLE user_settings
				ADD INDEX idx_user_settings_activity_enabled (activity_stats_enabled, user_id),
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`
				ALTER TABLE user_settings
				DROP INDEX idx_user_settings_activity_enabled,
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error
		},
	}
}
