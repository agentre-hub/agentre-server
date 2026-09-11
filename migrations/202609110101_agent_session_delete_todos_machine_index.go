package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609110101 给 agent_session_delete_todos 加一根按机器查询的索引。
//
// ListPendingMachines 每 60 秒巡检一次，真库上按 device_fingerprint 分组要建临时表；
// 加上 (user_id, device_fingerprint) 后是一次覆盖扫描，不再建临时表（决策 12）。这根
// 索引是非唯一的：AddDeleteTodo 的 ON DUPLICATE KEY UPDATE 语义依赖这张表只有一个
// 唯一键（uk_agent_session_delete_todos_identity），加一个新的唯一键会让「撞的是哪一
// 行」变得含混，所以这里显式用非唯一 KEY。
func migration202609110101() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609110101",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`
				ALTER TABLE agent_session_delete_todos
				ADD KEY idx_agent_session_delete_todos_machine (user_id, device_fingerprint),
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`
				ALTER TABLE agent_session_delete_todos
				DROP INDEX idx_agent_session_delete_todos_machine,
				ALGORITHM=INPLACE, LOCK=NONE;
			`).Error
		},
	}
}
