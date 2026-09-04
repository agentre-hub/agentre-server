package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609040107 建账号级「保存的对话」名单表（R12 后端 / R14）。
//
// 这是 agentre-server 本轮唯一的服务端新增表，也是硬不变量（server 不持有任何
// 会话内容）的唯一例外，且它存的是「指向」——目标设备指纹 + 会话身份 + 关注时间，
// 不含标题、消息或转录。表名与列名退出实现比喻，并到 agent_session_* 这个域上
// （2026-08-27-schema-overhaul.md 决策 19/12）：「保存」是这份名单的动作，不是域名。
//
// 身份是 (user_id, conversation_id)
// （2026-08-31-conversation-centric-addressing.md「会话身份」）：conversation_id 是
// 一条对话在桌面端、agentred 与 server 三套库以及线格式上的**同一个**身份（决策 1），
// 由发起端铸 UUIDv7。保存/删除因此幂等：重复保存命中唯一索引时那条 INSERT 什么都不改
// （gorm 的 DoNothing 在 MySQL 下发出 ON DUPLICATE KEY UPDATE 的自赋值形式），
// 不新增行、不重置首次保存时间；删除就是一条 DELETE，删不到也是成功。
//
// conversation_id 用 char(36) 而不是 varchar(36)：规范形式的 uuid 恒为 36 字符，
// 定长省掉每行一个长度前缀。COLLATE utf8mb4_0900_bin 与同表其余标识同理——这是个不透明
// 标识，大小写不敏感的比较会把两条不同的对话认成同一条。
//
// peer_fingerprint 留着，但已经**退出身份**，只是来源标注与授权用的普通列。
// device_fingerprint 是目标设备的不透明标识，用 utf8mb4_0900_bin 逐字节判等；
// 它要能和 devices.fingerprint 比较，两列排序规则必须一致。
func migration202609040107() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609040107",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				CREATE TABLE agent_session_saves (
				  id                 bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id            bigint NOT NULL,
				  conversation_id    char(36) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  device_fingerprint varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  peer_fingerprint   varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  followed_at        bigint NOT NULL DEFAULT 0,
				  createtime         bigint NOT NULL DEFAULT 0,
				  updatetime         bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_agent_session_saves_identity (user_id, conversation_id),
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
