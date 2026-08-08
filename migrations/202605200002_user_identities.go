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
				  id              bigserial PRIMARY KEY,
				  user_id         bigint NOT NULL,
				  provider        text NOT NULL,
				  provider_uid    text NOT NULL,
				  provider_login  text NOT NULL DEFAULT '',
				  email           text NOT NULL,
				  raw_profile     jsonb NOT NULL DEFAULT '{}',
				  createtime      bigint NOT NULL DEFAULT 0,
				  updatetime      bigint NOT NULL DEFAULT 0
				);
				CREATE UNIQUE INDEX uk_user_identities_provider_uid
				  ON user_identities(provider, provider_uid);
				CREATE INDEX idx_user_identities_user ON user_identities(user_id);
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS user_identities`).Error
		},
	}
}
