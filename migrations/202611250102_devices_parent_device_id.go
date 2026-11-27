package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202611250102 给 devices 加 parent_device_id：桌面代签出来的 cli 子设备指回签发
// 它的那台桌面（规格 2026-11-25-agrctl-account-peer「身份与登录 → 桌面代签」）。撤销桌面时
// 按它连带撤销全部子设备，因此桌面离线时在控制台删掉它也能收回子设备。
//
// 0 表示没有上级（既有设备、Device Flow 授权出来的设备都是 0），NOT NULL DEFAULT 0 让既有
// 行无需回填。索引 (parent_device_id, status) 服务「列某台桌面名下仍在用的子设备」；
// 两个子句合并成一条 ALTER，在 MySQL 8.4 与 9.x 上同样成立。
func migration202611250102() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202611250102",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
		ALTER TABLE devices
		  ADD COLUMN parent_device_id bigint NOT NULL DEFAULT 0 AFTER fingerprint,
		  ADD KEY idx_devices_parent (parent_device_id, status)`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`
		ALTER TABLE devices
		  DROP KEY idx_devices_parent,
		  DROP COLUMN parent_device_id`).Error
		},
	}
}
