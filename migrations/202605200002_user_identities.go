package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

func migration202605200002() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202605200002",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE user_identities (
				  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id         bigint NOT NULL,
				  provider        varchar(32) NOT NULL,
				  provider_uid    varchar(255) NOT NULL,
				  provider_login  varchar(255) NOT NULL DEFAULT '',
				  email           varchar(320) NOT NULL,
				  raw_profile     json NOT NULL,
				  createtime      bigint NOT NULL DEFAULT 0,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_user_identities_provider_uid (provider, provider_uid),
				  KEY idx_user_identities_user (user_id)
				);
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS user_identities`).Error
		},
	}
}
