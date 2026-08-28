package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608280007 建账号级「保存的对话」名单表（R12 后端 / R14）。
//
// 这是 agentre-server 本轮唯一的服务端新增表，也是硬不变量（server 不持有任何
// 会话内容）的唯一例外，且它存的是「指向」——目标设备指纹 + 会话标识 + 关注时间，
// 不含标题、消息或转录。表名与列名退出实现比喻，并到 agent_session_* 这个域上
// （2026-08-27-schema-overhaul.md 决策 19/12）：「保存」是这份名单的动作，不是域名，
// 而 session_id 在桌面端指的是本机会话，这里指的是**发起端**的会话号。表按 (user_id, peer_fingerprint, peer_session_id) 唯一，
// 保存/删除因此幂等：重复保存命中唯一索引时那条 INSERT 什么都不改（gorm 的 DoNothing
// 在 MySQL 下发出 ON DUPLICATE KEY UPDATE 的自赋值形式），不新增行、
// 不重置首次保存时间；删除就是一条 DELETE，删不到也是成功。
//
// device_fingerprint 与 peer_session_id 是目标设备与会话的不透明标识，用
// utf8mb4_0900_bin 逐字节判等：大小写不敏感会把两个不同的会话认成同一个，名单就指错了
// 对象。device_fingerprint 要能和 devices.fingerprint 比较，两列排序规则必须一致。
func migration202608280007() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608280007",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE agent_session_saves (
				  id                 bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id            bigint NOT NULL,
				  device_fingerprint varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  peer_fingerprint   varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  peer_session_id    varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  followed_at        bigint NOT NULL DEFAULT 0,
				  createtime         bigint NOT NULL DEFAULT 0,
				  updatetime         bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_agent_session_saves_identity
				    (user_id, peer_fingerprint, peer_session_id),
				  KEY idx_agent_session_saves_machine (user_id, device_fingerprint)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`
				DROP TABLE IF EXISTS agent_session_saves;
			`).Error
		},
	}
}
