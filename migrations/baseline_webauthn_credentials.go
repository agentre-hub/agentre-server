package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// baselineWebAuthnCredentials 创建 webauthn_credentials 表（通行密钥）。
//
// credential_id / public_key / aaguid 用 **varbinary** 而不是 varchar：它们是认证器
// 给出的原始字节，不是文本。存 base64 也能塞进 varchar，但那样每次读写都要多一层
// 编解码，而且唯一索引会落在编码后的字符串上——同一把凭证换一种 base64 变体
// （标准 / URL-safe、带不带 padding）就会被认成两把。
//
// credential_id 上是**全局**唯一键，不是 (user_id, credential_id)：登录时不要求任何
// 标识，只能拿凭证 ID 反查账号，那条查询必须唯一命中一行。它同时也是「同一把认证器
// 不许注册两次」的真正裁决处——选项里的 excludeCredentials 只是给浏览器的提示，
// 浏览器完全可以不理会。
//
// 宽度 512 字节：规范允许凭证 ID 最长 1023 字节，但那超出 InnoDB 单列唯一索引在
// 多字节字符集下的舒适区，而现实中的认证器（U2F 64 字节、平台认证器 16~64 字节）
// 都远小于此。varbinary 每字节就是一字节，512 的索引键长在 3072 上限内。
//
// last_used_at 与 createtime 分开：清单要同时给出「什么时候加的」与「上次用是什么
// 时候」，前者永不变、后者每次登录都写。从未用过是 0，不是 createtime——把两者混起来
// 会让一把从没用过的密钥看上去刚刚用过。
//
// (user_id, id) 的联合索引而不是单列 user_id：清单按账号取、按 id 倒序排，联合索引
// 让排序直接走索引，不必回表再排。
func baselineWebAuthnCredentials() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "webauthn_credentials",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE webauthn_credentials (
				  id               bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id          bigint NOT NULL,
				  credential_id    varbinary(512) NOT NULL,
				  public_key       varbinary(1024) NOT NULL,
				  aaguid           varbinary(16) NOT NULL DEFAULT '',
				  sign_count       int unsigned NOT NULL DEFAULT 0,
				  transports       varchar(128) NOT NULL DEFAULT '',
				  name             varchar(64) NOT NULL,
				  backup_eligible  boolean NOT NULL DEFAULT false,
				  backup_state     boolean NOT NULL DEFAULT false,
				  last_used_at     bigint NOT NULL DEFAULT 0,
				  createtime       bigint NOT NULL DEFAULT 0,
				  updatetime       bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_webauthn_credentials_credential_id (credential_id),
				  KEY idx_webauthn_credentials_user (user_id, id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS webauthn_credentials`).Error
		},
	}
}
