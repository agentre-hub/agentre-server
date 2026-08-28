package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608280002 创建 user_identities 表。
//
// provider / provider_uid 用 utf8mb4_0900_bin 逐字节判等：provider_uid 是 OAuth 提供方
// 给的不透明标识，大小写不敏感地判重会把两个不同的上游账号认成同一个。
//
// email 跟 users.email 保持同一个排序规则（utf8mb4_0900_as_ci，大小写不敏感、不折叠
// 重音）：两列语义相同，排序规则也必须相同——不同排序规则的两列直接比较会被 MySQL
// 判为 illegal mix of collations 而报错。
//
// provider_login 是展示用的用户名，留表默认排序规则。
//
// raw_profile 带上 DEFAULT ('{}')（MySQL 8.0.13+ 的表达式默认值）：让「没有 profile」
// 这件事由 schema 表达一次，而不是在每个写入方各自兜一遍。
func migration202608280002() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608280002",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE user_identities (
				  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id         bigint NOT NULL,
				  provider        varchar(32) COLLATE utf8mb4_0900_bin NOT NULL,
				  provider_uid    varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  provider_login  varchar(255) NOT NULL DEFAULT '',
				  email           varchar(320) COLLATE utf8mb4_0900_as_ci NOT NULL,
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
