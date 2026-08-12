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
				  device_code         varchar(255) PRIMARY KEY,
				  user_code           varchar(32) NOT NULL,
				  device_kind         varchar(32) NOT NULL,
				  client_fingerprint  varchar(255) NOT NULL,
				  platform            varchar(64) NOT NULL DEFAULT '',
				  version             varchar(64) NOT NULL DEFAULT '',
				  authorized_user_id  bigint NOT NULL DEFAULT 0,
				  approved_at         bigint NOT NULL DEFAULT 0,
				  consumed_at         bigint NOT NULL DEFAULT 0,
				  denied_at           bigint NOT NULL DEFAULT 0,
				  interval_seconds    smallint NOT NULL DEFAULT 5,
				  last_polled_at      bigint NOT NULL DEFAULT 0,
				  expires_at          bigint NOT NULL DEFAULT 0,
				  createtime          bigint NOT NULL DEFAULT 0,
				  pending_user_code varchar(32) GENERATED ALWAYS AS
				    (IF(consumed_at = 0 AND denied_at = 0, user_code, NULL)) STORED,
				  UNIQUE KEY uk_dfc_user_code_pending (pending_user_code),
				  KEY idx_dfc_expires (expires_at)
				);
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS device_flow_codes`).Error
		},
	}
}
