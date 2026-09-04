package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609040003 把 agent_session_delete_todos.peer_fingerprint 改名为
// device_fingerprint —— 这一列存的从来就是**承载**那条对话的机器（补删时要拨的
// 就是它），名字却说它是发起端。
//
// 这不是别名统一，是名字说了假话。工作区里同一个值空间有四个角色，承载端与发起端
// 是其中最容易混的一对：它们的取值范围重叠（本机开的对话两者同值），所以拿错了列
// 不会有任何一处报错，只会把待办拨给一台从来没跑过这条对话的机器。这张表上现在
// 靠三段注释（实体、仓储接口、saved_session_svc.Delete）提醒读者别按发起端筛，
// 而注释拦不住人。
//
// 其余四个别名（agentred_ / daemon_ / machine_ / sync_origin_）不动：它们指的角色
// 是对的，只是换了个词，而 agentred_fingerprint 同时是同步载荷的字段名，跨三个仓
// 改一个已发布的线格式换不来任何行为收益。约定见
// agentre/docs/architecture.md 的「Device fingerprints」。
//
// 该列不在任何键里——身份键在 202609010003 之后是 (user_id, conversation_id)——
// 所以这是一条纯改名，不重建索引。
func migration202609040003() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609040003",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec("ALTER TABLE agent_session_delete_todos " +
				"RENAME COLUMN peer_fingerprint TO device_fingerprint").Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec("ALTER TABLE agent_session_delete_todos " +
				"RENAME COLUMN device_fingerprint TO peer_fingerprint").Error
		},
	}
}
