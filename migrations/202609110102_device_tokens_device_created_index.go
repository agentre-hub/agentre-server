package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609110102 给 device_tokens 加一根按设备 + 签发时间查询的索引。
//
// ListRevokedJTIByUser 原本要对整张表做扫描再与 devices 哈希连接；加上
// (device_id, createtime) 后是一次嵌套循环、每台设备只读少数几行（决策 12）。
// RevokeChain / ListAccessJTIByDevice 两条既有查询继续吃 idx_dtokens_device_active，
// 不受这根新索引影响。
func migration202609110102() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609110102",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				ALTER TABLE device_tokens
				ADD INDEX idx_dtokens_device_created (device_id, createtime),
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`
				ALTER TABLE device_tokens
				DROP INDEX idx_dtokens_device_created,
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error
		},
	}
}
