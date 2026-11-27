package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202611250101 建 personal_tokens：账号下带范围、可轮换、可吊销的个人 token
// （规格 2026-11-25-agrctl-account-peer「个人 token 与范围」）。
//
// 排序规则：
//   - token_hash 是密钥明文的 sha256 十六进制，与 device_tokens.access_token_hash 同理用
//     utf8mb4_0900_bin 逐字节判等——它上面挂唯一键，大小写不敏感等于放宽一个 bearer
//     凭据的匹配条件。
//   - peer_fingerprint 会被 agentred 拿去与会话的发起方指纹比较，与 devices.fingerprint
//     同一个 utf8mb4_0900_bin。
//   - name 是人起的名字，账号内唯一且大小写不敏感（"Deploy" 与 "deploy" 是同一枚），
//     用 utf8mb4_0900_as_ci——与 users.email 同一个理由，交给排序规则比在每个写入方各自
//     lower() 一遍可靠；名字只收 ASCII（personal_token_entity.NormalizeName），重音折叠
//     与否无关。
//   - scopes 是固定字面量的逗号串，只读不比较，bin 即可。
//
// expires_at / lifetime_ms 为 0 表示永不过期。删除即吊销（硬删），名字随之可以复用。
// 三个唯一键之外没有别的索引：解析按 token_hash、管理按 (user_id, name)、列表按 user_id
// 走 uk_personal_tokens_user_name 的最左前缀。DDL 在 MySQL 8.4 与 9.x 上同样成立。
func migration202611250101() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202611250101",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
		CREATE TABLE personal_tokens (
		  id                    bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id               bigint NOT NULL,
		  name                  varchar(64) COLLATE utf8mb4_0900_as_ci NOT NULL,
		  token_hash            varchar(64) COLLATE utf8mb4_0900_bin NOT NULL,
		  scopes                varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  peer_fingerprint      varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  created_by_device_id  bigint NOT NULL DEFAULT 0,
		  lifetime_ms           bigint NOT NULL DEFAULT 0,
		  expires_at            bigint NOT NULL DEFAULT 0,
		  last_used_at          bigint NOT NULL DEFAULT 0,
		  rotated_at            bigint NOT NULL DEFAULT 0,
		  createtime            bigint NOT NULL DEFAULT 0,
		  updatetime            bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_personal_tokens_user_name (user_id, name),
		  UNIQUE KEY uk_personal_tokens_token_hash (token_hash),
		  UNIQUE KEY uk_personal_tokens_peer_fingerprint (peer_fingerprint)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec("DROP TABLE IF EXISTS personal_tokens").Error
		},
	}
}
