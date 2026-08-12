package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202605200001 创建 users 表。
func migration202605200001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202605200001",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE users (
				  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  email           varchar(320) NOT NULL,
				  email_verified  boolean NOT NULL DEFAULT false,
				  display_name    varchar(255) NOT NULL DEFAULT '',
				  avatar_url      varchar(2048) NOT NULL DEFAULT '',
				  status          smallint NOT NULL DEFAULT 1,
				  createtime      bigint NOT NULL DEFAULT 0,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  active_email varchar(320) GENERATED ALWAYS AS (IF(status = 1, email, NULL)) STORED,
				  UNIQUE KEY uk_users_email_active (active_email)
				);
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS users`).Error
		},
	}
}
