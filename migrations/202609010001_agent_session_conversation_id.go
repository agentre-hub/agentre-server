package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609010001 给四张镜像表加上 conversation_id 列
// （2026-08-31-conversation-centric-addressing.md「会话身份」「迁移与回填」）。
//
// **只加列，不动键、不回填**。三件事分成三次迁移与三次提交，是 develop.md
// "When Touching Persistent Data" 第 3 步的要求：合在一起时，跑挂了分不清是 DDL
// 的错还是数据的错。次序也只能是这一个——列不存在就回填不了，全表是空串就换不成
// 唯一键（第二行起当场撞键）。回填是 202609010002，换键是 202609010003。
//
// conversation_id 是一条对话在桌面端、agentred 与 server 三套库以及线格式上的**同
// 一个**身份（决策 1）：新对话由发起端铸 UUIDv7，存量对话按决策 2 从
// (peer_fingerprint, peer_session_id) 确定性派生 UUIDv5，三个仓库各自算、算出同一个值。
//
// 列型 char(36) 而不是 varchar(36)：规范形式的 uuid 恒为 36 字符，定长省掉每行一个
// 长度前缀，而 agent_session_notification_journal 是本库唯一无上界增长的表（帧只在对话被
// 删时才消失），这一列还要进它的主键、于是复制进每一个二级索引。
//
// COLLATE utf8mb4_0900_bin：与同表的 peer_fingerprint / peer_session_id 同一理由——
// 这是个不透明标识，大小写不敏感的比较会把两条不同的对话认成同一条。
//
// DEFAULT ”：加列这一步之后、回填那一步之前，存量行必须有个确定的值，而空串是
// 「还没有身份」这件事的如实表达（不是一个看起来像 uuid 的占位值）。换键那一步跑完
// 之后它不可能再出现——唯一键会让第二行空串当场失败。
func migration202609010001() *gormigrate.Migration {
	tables := []string{
		"agent_sessions",
		"agent_session_notification_journal",
		"agent_session_delete_todos",
		"agent_session_saves",
	}
	return &gormigrate.Migration{
		ID: "202609010001",
		// 每张表先问一句「这一列在不在」。MySQL 的 DDL 各自自动提交,而
		// gormigrate.DefaultOptions.UseTransaction 是 false —— 四条 ALTER 里第三条
		// 失败(被杀、锁等待、连接断)时前两条已经生效,台账行却一行都没写。不带这道
		// 判断的话,下一次启动重跑必然死在 Duplicate column name,而且**每次**都死,
		// 只能人工进库改。同一条纪律见 agentred 侧的 202609010001。
		Migrate: func(tx *gorm.DB) error {
			for _, table := range tables {
				if tx.Migrator().HasColumn(table, "conversation_id") {
					continue
				}
				if err := tx.Exec("ALTER TABLE " + table + " ADD COLUMN conversation_id " +
					"char(36) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT ''").Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			for _, table := range tables {
				if !tx.Migrator().HasColumn(table, "conversation_id") {
					continue
				}
				if err := tx.Exec("ALTER TABLE " + table + " DROP COLUMN conversation_id").Error; err != nil {
					return err
				}
			}
			return nil
		},
	}
}
