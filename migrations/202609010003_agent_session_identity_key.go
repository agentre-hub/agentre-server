package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609010003 把四张镜像表的身份键换成 (user_id, conversation_id)
// （agent_session_notification_journal 带 seq），peer_fingerprint / peer_session_id 就此
// 退出身份、降级为来源标注与授权用的普通列
// （2026-08-31-conversation-centric-addressing.md「会话身份」）。
//
// 必须跟在 202609010002 之后：换键之前每一行都得有身份，否则第二行空串当场撞唯一键。
// 反过来说，这一步跑完之后空串再也不可能出现——约束自己就是那道守卫。
//
// 唯一键名一字未改（uk_agent_sessions_identity 等）：它说的是「这张表的身份键」这件
// 事，而这件事没变，变的是它由哪几列组成。改名会让所有引用它的注释与运维手册一起过期。
//
// agent_session_notification_journal 换的是**主键**而不是唯一索引：这张表没有代理自增列，
// 帧按身份聚簇存放，转录尾部因此是聚簇索引上的一段连续范围而不是二级索引扫一段再逐行
// 随机回表取 longblob（理由原文见 202608280008）。换成 (user_id, conversation_id, seq)
// 之后这个形状原样保留，只是聚簇键从两个 varchar(255) 缩成一个 char(36)。
//
// DROP + ADD 写在**同一条** ALTER 里，是因为分成两条的话中间那一刻表上没有任何唯一
// 约束——一次并发写入就能落下一对重复行，而随后的 ADD UNIQUE 会因为它们失败，人要在
// 一张已经脏了的表上收拾残局。InnoDB 对这条语句只做一次表重建，也更快。
//
// **本次迁移没有自动化覆盖**：docs/testing.md 明令不得用字符串断言复述 schema，
// 而 upsert 的冲突目标是否还落在真实存在的约束上（agent_session_repo 的 sqlmock 按
// SQL 文本匹配，抓不到这类回归）只有真库能答。它属于 docs/verification.md 的手工
// 验证清单：迁移前后各跑一次同样的计数查询，并把 SHOW CREATE TABLE 的结果留证。
func migration202609010003() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609010003",
		Migrate: func(tx *gorm.DB) error {
			return execAll(tx, []string{
				"ALTER TABLE agent_sessions " +
					"DROP INDEX uk_agent_sessions_identity, " +
					"ADD UNIQUE KEY uk_agent_sessions_identity (user_id, conversation_id)",
				"ALTER TABLE agent_session_saves " +
					"DROP INDEX uk_agent_session_saves_identity, " +
					"ADD UNIQUE KEY uk_agent_session_saves_identity (user_id, conversation_id)",
				"ALTER TABLE agent_session_delete_todos " +
					"DROP INDEX uk_agent_session_delete_todos_identity, " +
					"ADD UNIQUE KEY uk_agent_session_delete_todos_identity (user_id, conversation_id)",
				"ALTER TABLE agent_session_notification_journal " +
					"DROP PRIMARY KEY, " +
					"ADD PRIMARY KEY (user_id, conversation_id, seq)",
			})
		},
		// 回滚只在**这次发布还没写进新行**时成立：换键之后新写下的行 peer_session_id
		// 是空串（线格式上已经没有那个值了），把旧键装回去会让它们在
		// (user_id, '', '') 上撞成一堆。真要降级，先决定那些新行怎么办。
		Rollback: func(tx *gorm.DB) error {
			return execAll(tx, []string{
				"ALTER TABLE agent_sessions " +
					"DROP INDEX uk_agent_sessions_identity, " +
					"ADD UNIQUE KEY uk_agent_sessions_identity (user_id, peer_fingerprint, peer_session_id)",
				"ALTER TABLE agent_session_saves " +
					"DROP INDEX uk_agent_session_saves_identity, " +
					"ADD UNIQUE KEY uk_agent_session_saves_identity (user_id, peer_fingerprint, peer_session_id)",
				"ALTER TABLE agent_session_delete_todos " +
					"DROP INDEX uk_agent_session_delete_todos_identity, " +
					"ADD UNIQUE KEY uk_agent_session_delete_todos_identity " +
					"(user_id, peer_fingerprint, peer_session_id)",
				"ALTER TABLE agent_session_notification_journal " +
					"DROP PRIMARY KEY, " +
					"ADD PRIMARY KEY (user_id, peer_fingerprint, peer_session_id, seq)",
			})
		},
	}
}

// execAll 按顺序发出一串语句，第一条失败就停下。DDL 在 MySQL 上各自隐式提交，
// 包在事务里也回滚不了，所以这里如实地一条条发，不假装有原子性。
func execAll(tx *gorm.DB, statements []string) error {
	for _, statement := range statements {
		if err := tx.Exec(statement).Error; err != nil {
			return err
		}
	}
	return nil
}
