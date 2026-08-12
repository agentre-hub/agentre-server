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
				  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id         bigint NOT NULL,
				  name            varchar(255) NOT NULL,
				  kind            varchar(32) NOT NULL,
				  platform        varchar(64) NOT NULL DEFAULT '',
				  version         varchar(64) NOT NULL DEFAULT '',
				  fingerprint     varchar(255) NOT NULL,
				  last_seen_at    bigint NOT NULL DEFAULT 0,
				  status          smallint NOT NULL DEFAULT 1,
				  createtime      bigint NOT NULL DEFAULT 0,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_devices_user_fingerprint (user_id, fingerprint),
				  KEY idx_devices_user_active (user_id, status)
				);
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS devices`).Error
		},
	}
}
