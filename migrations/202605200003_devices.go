package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202605200003 创建 devices 表。
//
// fingerprint 是设备的自然键、由桌面端生成，kind 是枚举字面量，两者都用
// utf8mb4_bin：指纹大小写不敏感地判重会把两台不同的机器认成同一台，进而让第二台
// 的注册撞上 uk_devices_user_fingerprint。name 是用户可改的展示名，留默认排序规则。
//
// idx_devices_user_active 是普通复合索引而不是部分索引：PG 那边写的是
// `WHERE status = 1`，MySQL 没有部分索引，但把 status 放进键里同样能服务
// `WHERE user_id=? AND status=?`，只是索引会连非活跃行一起收——设备表很小，不值得
// 为此再加一个生成列。
func migration202605200003() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202605200003",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE devices (
				  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id         bigint NOT NULL,
				  name            varchar(255) NOT NULL,
				  kind            varchar(32) COLLATE utf8mb4_bin NOT NULL,
				  platform        varchar(64) NOT NULL DEFAULT '',
				  version         varchar(64) NOT NULL DEFAULT '',
				  fingerprint     varchar(255) COLLATE utf8mb4_bin NOT NULL,
				  last_seen_at    bigint NOT NULL DEFAULT 0,
				  status          smallint NOT NULL DEFAULT 1,
				  createtime      bigint NOT NULL DEFAULT 0,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_devices_user_fingerprint (user_id, fingerprint),
				  KEY idx_devices_user_active (user_id, status)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS devices`).Error
		},
	}
}
