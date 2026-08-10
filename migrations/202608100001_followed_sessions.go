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
// 关注/取消因此幂等：重复关注命中唯一索引时 ON CONFLICT DO NOTHING，不新增行、
// 不重置首次关注时间；取消就是一条 DELETE，删不到也是成功。
func migration202608100001() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608100001",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE followed_sessions (
				  id                 bigserial PRIMARY KEY,
				  user_id            bigint NOT NULL,
				  device_fingerprint text NOT NULL,
				  session_id         text NOT NULL,
				  followed_at        bigint NOT NULL DEFAULT 0,
				  createtime         bigint NOT NULL DEFAULT 0,
				  updatetime         bigint NOT NULL DEFAULT 0
				);
				CREATE UNIQUE INDEX uk_followed_sessions_identity
				  ON followed_sessions(user_id, device_fingerprint, session_id);
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`
				DROP TABLE IF EXISTS followed_sessions;
			`).Error
		},
	}
}
