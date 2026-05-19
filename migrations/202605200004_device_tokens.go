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
				  id                  bigserial PRIMARY KEY,
				  device_id           bigint NOT NULL,
				  refresh_token_hash  text NOT NULL,
				  refresh_expires_at  bigint NOT NULL DEFAULT 0,
				  last_used_at        bigint NOT NULL DEFAULT 0,
				  rotated_from_id     bigint NOT NULL DEFAULT 0,
				  revoked_at          bigint NOT NULL DEFAULT 0,
				  user_agent          text NOT NULL DEFAULT '',
				  ip                  inet,
				  createtime          bigint NOT NULL DEFAULT 0
				);
				CREATE UNIQUE INDEX uk_dtokens_refresh_hash ON device_tokens(refresh_token_hash);
				CREATE INDEX idx_dtokens_device_active ON device_tokens(device_id) WHERE revoked_at = 0;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS device_tokens`).Error
		},
	}
}
