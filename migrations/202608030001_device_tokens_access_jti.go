package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

func migration202608030001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608030001",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				ALTER TABLE device_tokens ADD COLUMN access_jti text NOT NULL DEFAULT '';
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE device_tokens DROP COLUMN IF EXISTS access_jti`).Error
		},
	}
}
