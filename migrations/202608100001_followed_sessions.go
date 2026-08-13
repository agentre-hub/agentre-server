package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608100001 建账号级关注名单表（R12 后端 / R14）。
//
// 这是 agentre-server 本轮唯一的服务端新增表，也是硬不变量（server 不持有任何
// 会话内容）的唯一例外，且它存的是「指向」——目标设备指纹 + 会话标识 + 关注时间，
// 不含标题、消息或转录。表按 (user_id, device_fingerprint, session_id) 唯一，
// 关注/取消因此幂等：重复关注命中唯一索引时那条 INSERT 什么都不改（gorm 的 DoNothing
// 在 MySQL 下发出 ON DUPLICATE KEY UPDATE 的自赋值形式），不新增行、
// 不重置首次关注时间；取消就是一条 DELETE，删不到也是成功。
//
// device_fingerprint 与 session_id 是目标设备与会话的不透明标识，用 utf8mb4_bin
// 逐字节判等：大小写不敏感会把两个不同的会话认成同一个，名单就指错了对象。
func migration202608100001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608100001",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE followed_sessions (
				  id                 bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id            bigint NOT NULL,
				  device_fingerprint varchar(255) COLLATE utf8mb4_bin NOT NULL,
				  session_id         varchar(255) COLLATE utf8mb4_bin NOT NULL,
				  followed_at        bigint NOT NULL DEFAULT 0,
				  createtime         bigint NOT NULL DEFAULT 0,
				  updatetime         bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_followed_sessions_identity
				    (user_id, device_fingerprint, session_id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`
				DROP TABLE IF EXISTS followed_sessions;
			`).Error
		},
	}
}
