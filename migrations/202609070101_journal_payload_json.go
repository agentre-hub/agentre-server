package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609070101 把 agent_session_notification_journal.payload 从不透明的
// protobuf 字节改成原生 json 列（docs/specs/2026-09-07-journal-payload-json.md）。
//
// 改的只是**这一台 server 怎么存**：wire 上传的仍是 protobuf，对端一行不改
// （2026-09-05-transcript-storage-alignment.md 决策 7：载荷编码是纯存储层的正交
// 问题，各库各自决定）。
//
// # 为什么是清空重拉，而不是逐行改写
//
// 存量那些行装的是 protobuf 字节，直接 MODIFY 成 json 会被 MySQL 以「Invalid JSON
// text」整条拒掉，所以必须先腾空。两条路：在迁移里把每一行解出来重编，或者清空让
// 镜像自己重新拉。选后者，因为重拉本来就是这条链路的常规动作：
//
//   - latest_seq 只有一个读者——storedCursor，也就是「重启后从哪儿接着拉」
//     （mirror_svc/mirror.go）。把它归零就是让镜像从头再拉一遍。
//   - 帧表的写入是 ON DUPLICATE KEY DO NOTHING，重拉天然幂等；实时与补齐两条路的
//     窗口本来就按构造重叠，这条幂等是既有设计依赖的。
//   - 对端的日志「只追加、永久保存——agentred 不再回收任何一行」，所以源头还在。
//
// 而逐行改写要让迁移反向依赖 wire 的生成代码，并且要在**唯一那张无界表**上跑一次
// 全表重写。清空的代价是有限且自愈的：对端下次上线前，那条对话的转录暂时是空的。
//
// # 只清帧，不动摘要的其余字段
//
// agent_sessions 上除 latest_seq 之外的列（标题、cwd、生命周期等）由 Sync 经
// setSummary 维护，与帧无关，清掉只会让会话列表凭空少一截。
func migration202609070101() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609070101",
		Migrate: func(tx *gorm.DB) error {
			statements := []string{
				// 先腾空：存量是 protobuf 字节，留着会让下面那条 MODIFY 失败。
				`TRUNCATE TABLE agent_session_notification_journal`,
				`ALTER TABLE agent_session_notification_journal
				   MODIFY COLUMN payload json NOT NULL`,
				// 游标归零，镜像下次连上就把帧重新拉满。
				`UPDATE agent_sessions SET latest_seq = 0 WHERE latest_seq <> 0`,
			}
			for _, statement := range statements {
				if err := tx.Exec(statement).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			// 回退同样要先腾空：json 列里存的是视图，longblob 那一侧读的是 protobuf
			// 字节，留着等于让旧代码解一堆解不开的行。
			statements := []string{
				`TRUNCATE TABLE agent_session_notification_journal`,
				`ALTER TABLE agent_session_notification_journal
				   MODIFY COLUMN payload longblob NOT NULL`,
				`UPDATE agent_sessions SET latest_seq = 0 WHERE latest_seq <> 0`,
			}
			for _, statement := range statements {
				if err := tx.Exec(statement).Error; err != nil {
					return err
				}
			}
			return nil
		},
	}
}
