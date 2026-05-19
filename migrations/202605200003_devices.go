package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

func migration202605200003() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202605200003",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE devices (
				  id              bigserial PRIMARY KEY,
				  user_id         bigint NOT NULL,
				  name            text NOT NULL,
				  kind            text NOT NULL,
				  platform        text NOT NULL DEFAULT '',
				  version         text NOT NULL DEFAULT '',
				  fingerprint     text NOT NULL,
				  capabilities    jsonb NOT NULL DEFAULT '{}',
				  last_seen_at    bigint NOT NULL DEFAULT 0,
				  status          smallint NOT NULL DEFAULT 1,
				  createtime      bigint NOT NULL DEFAULT 0,
				  updatetime      bigint NOT NULL DEFAULT 0
				);
				CREATE UNIQUE INDEX uk_devices_user_fingerprint
				  ON devices(user_id, fingerprint);
				CREATE INDEX idx_devices_user_active ON devices(user_id) WHERE status = 1;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS devices`).Error
		},
	}
}
