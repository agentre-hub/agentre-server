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
				  id              bigserial PRIMARY KEY,
				  email           text NOT NULL,
				  email_verified  boolean NOT NULL DEFAULT false,
				  display_name    text NOT NULL DEFAULT '',
				  avatar_url      text NOT NULL DEFAULT '',
				  status          smallint NOT NULL DEFAULT 1,
				  createtime      bigint NOT NULL DEFAULT 0,
				  updatetime      bigint NOT NULL DEFAULT 0
				);
				CREATE UNIQUE INDEX uk_users_email_active ON users(email) WHERE status = 1;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS users`).Error
		},
	}
}
