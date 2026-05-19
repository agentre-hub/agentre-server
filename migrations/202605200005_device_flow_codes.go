package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

func migration202605200005() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202605200005",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE device_flow_codes (
				  device_code         text PRIMARY KEY,
				  user_code           text NOT NULL,
				  device_kind         text NOT NULL,
				  client_fingerprint  text NOT NULL,
				  client_capabilities jsonb NOT NULL DEFAULT '{}',
				  platform            text NOT NULL DEFAULT '',
				  version             text NOT NULL DEFAULT '',
				  authorized_user_id  bigint NOT NULL DEFAULT 0,
				  approved_at         bigint NOT NULL DEFAULT 0,
				  consumed_at         bigint NOT NULL DEFAULT 0,
				  denied_at           bigint NOT NULL DEFAULT 0,
				  interval_seconds    smallint NOT NULL DEFAULT 5,
				  last_polled_at      bigint NOT NULL DEFAULT 0,
				  expires_at          bigint NOT NULL DEFAULT 0,
				  createtime          bigint NOT NULL DEFAULT 0
				);
				CREATE UNIQUE INDEX uk_dfc_user_code_pending
				  ON device_flow_codes(user_code)
				  WHERE consumed_at = 0 AND denied_at = 0;
				CREATE INDEX idx_dfc_expires ON device_flow_codes(expires_at);
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS device_flow_codes`).Error
		},
	}
}
