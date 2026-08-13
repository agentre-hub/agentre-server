package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202605200002 创建 user_identities 表。
//
// provider / provider_uid / email 是外部身份的自然键，用 utf8mb4_bin 逐字节判等：
// provider_uid 是 OAuth 提供方给的不透明标识，大小写不敏感地判重会把两个不同的
// 上游账号认成同一个。provider_login 是展示用的用户名，留默认排序规则。
//
// raw_profile 带上 DEFAULT ('{}')（MySQL 8.0.13+ 的表达式默认值）：让「没有 profile」
// 这件事由 schema 表达一次，而不是在每个写入方各自兜一遍。
func migration202605200002() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202605200002",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE user_identities (
				  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id         bigint NOT NULL,
				  provider        varchar(32) COLLATE utf8mb4_bin NOT NULL,
				  provider_uid    varchar(255) COLLATE utf8mb4_bin NOT NULL,
				  provider_login  varchar(255) NOT NULL DEFAULT '',
				  email           varchar(320) COLLATE utf8mb4_bin NOT NULL,
				  raw_profile     json NOT NULL DEFAULT ('{}'),
				  createtime      bigint NOT NULL DEFAULT 0,
				  updatetime      bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_user_identities_provider_uid (provider, provider_uid),
				  KEY idx_user_identities_user (user_id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS user_identities`).Error
		},
	}
}
