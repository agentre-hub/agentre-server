package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

func migration202605200004() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202605200004",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE device_tokens (
				  id                  bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  device_id           bigint NOT NULL,
				  access_jti          varchar(255) NOT NULL DEFAULT '',
				  refresh_token_hash  varchar(64) NOT NULL,
				  refresh_expires_at  bigint NOT NULL DEFAULT 0,
				  last_used_at        bigint NOT NULL DEFAULT 0,
				  rotated_from_id     bigint NOT NULL DEFAULT 0,
				  revoked_at          bigint NOT NULL DEFAULT 0,
				  user_agent          varchar(512) NOT NULL DEFAULT '',
				  ip                  varchar(45),
				  createtime          bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_dtokens_refresh_hash (refresh_token_hash),
				  KEY idx_dtokens_device_active (device_id, revoked_at)
				);
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS device_tokens`).Error
		},
	}
}
