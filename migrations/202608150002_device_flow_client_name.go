package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608150002 给 device_flow_codes 加上客户端自报的显示名。
//
// 设备流此前没有任何途径接收设备名：授权请求只收 device_kind / fingerprint /
// platform / version，换取 token 时只能把指纹截前 8 个字符当名字。而 daemon 与桌面端
// 的规范指纹是 sha256:<64 位 hex>，截出来的是 "sha256:" 加一个十六进制字符——整个
// 账号下的机器最多只有 16 种名字。名字要有意义，就必须由客户端在授权时报上来，
// 而授权与换取 token 是两次独立的请求，中间只有这一行 flow 记录能承载它。
//
//
// NOT NULL DEFAULT ”：老客户端不带 name，既有的未消费 flow 行也没有这一列，
// 空串表示「没自报」，由 device_entity.DisplayName 回退到指纹缩写。
//
// varchar(128) 与授权端点的 binding `max=128` 对齐，也与同表 platform / version 那批
// 有界 varchar 的写法一致——这张表里没有 text 列。
func migration202608150002() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608150002",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(
				"ALTER TABLE device_flow_codes ADD COLUMN client_name varchar(128) NOT NULL DEFAULT ''",
			).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec("ALTER TABLE device_flow_codes DROP COLUMN client_name").Error
		},
	}
}
