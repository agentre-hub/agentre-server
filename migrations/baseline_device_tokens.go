package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// baselineDeviceTokens 创建 device_tokens 表。
//
// refresh_token_hash 是 sha256 的十六进制（device_svc 里 hex.EncodeToString，恒为
// 64 位小写），access_jti 是 ULID：两者都是机器生成的凭据/标识，用
// utf8mb4_0900_bin 逐字节判等。尤其 refresh_token_hash 上挂着唯一键，
// 大小写不敏感会让两个不同的哈希互相顶掉，也等于放宽一个 bearer 凭据的匹配条件。
//
// ip 与 user_agent 只写不读（审计用，从不出现在任何 WHERE 里），显式排序规则对它们
// 没有意义，留表默认即可——只在真正参与比较的列上写排序规则，读的人才知道哪些列的
// 判等语义是被刻意选过的。
//
// idx_dtokens_device_active 把 revoked_at 放进键里代替 PG 的 `WHERE revoked_at = 0`，
// 理由同 devices：一条复合索引就能服务查询，不必为此加生成列。
func baselineDeviceTokens() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "device_tokens",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE device_tokens (
				  id                  bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  device_id           bigint NOT NULL,
				  access_jti          varchar(64) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  refresh_token_hash  varchar(64) COLLATE utf8mb4_0900_bin NOT NULL,
				  refresh_expires_at  bigint NOT NULL DEFAULT 0,
				  last_used_at        bigint NOT NULL DEFAULT 0,
				  rotated_from_id     bigint NOT NULL DEFAULT 0,
				  revoked_at          bigint NOT NULL DEFAULT 0,
				  user_agent          varchar(512) NOT NULL DEFAULT '',
				  ip                  varchar(45),
				  createtime          bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_dtokens_refresh_hash (refresh_token_hash),
				  KEY idx_dtokens_device_active (device_id, revoked_at),
				  KEY idx_dtokens_revoked (revoked_at),
				  KEY idx_dtokens_refresh_expiry (refresh_expires_at)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`DROP TABLE IF EXISTS device_tokens`).Error
		},
	}
}
