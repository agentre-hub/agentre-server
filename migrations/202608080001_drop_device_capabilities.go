package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608080001 删掉「设备能力」的两个落点。这两列从来只是设备自报的展示
// 值：服务端不校验、不裁剪，也没有任何一处据它做过权限判断，授权一台设备拿到的
// 始终是账号的完整权限。留着它们等于在库里继续记一份不兑现的承诺。
func migration202608080001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608080001",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.Exec(`ALTER TABLE devices DROP COLUMN IF EXISTS capabilities`).Error; err != nil {
				return err
			}
			return tx.Exec(`ALTER TABLE device_flow_codes DROP COLUMN IF EXISTS client_capabilities`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			if err := tx.Exec(`ALTER TABLE devices ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}'`).Error; err != nil {
				return err
			}
			return tx.Exec(`ALTER TABLE device_flow_codes ADD COLUMN client_capabilities jsonb NOT NULL DEFAULT '{}'`).Error
		},
	}
}
