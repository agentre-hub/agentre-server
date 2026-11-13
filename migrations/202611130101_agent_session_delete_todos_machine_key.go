package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202611130101 把 agent_session_delete_todos 的身份键从 (user_id, conversation_id)
// 换成 (user_id, conversation_id, device_fingerprint)：一条对话可以同时欠两台机器的删除
// （承载端 + 发起端），按旧键第二条会被 ON CONFLICT 吞掉。
//
// 加新唯一键与删旧唯一键放在同一条 ALTER 里原子完成，MySQL 8.4 / 9.x 都接受；新键是旧键
// 的超集，已有数据不可能违反它。idx_agent_session_delete_todos_machine
// (user_id, device_fingerprint) 不动——ListDeleteTodosByDevice / RemoveDeleteTodosByDevice
// / ListPendingMachines 都靠它。
func migration202611130101() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202611130101",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE agent_session_delete_todos
  DROP INDEX uk_agent_session_delete_todos_identity,
  ADD UNIQUE KEY uk_agent_session_delete_todos_identity (user_id, conversation_id, device_fingerprint)`).Error
		},
	}
}
