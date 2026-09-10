package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609080101 给库里剩下的八张表补上自增的 id 主键，把库级约定补齐成
// 「每一张表的行身份都是一个与业务取值无关的数字」（回归见 internal/model/entity 的
// TestEveryEntityHasAutoIncrementIDPrimaryKey）。
//
// 八张表原本都以自然键或复合自然键作主键。每一张的改法是同一件事：把原主键**原样**
// 降级成一个 UNIQUE KEY，再补一个 AUTO_INCREMENT 的 id 当主键。唯一性因此一格不少地
// 保留下来 —— 所有 upsert（ON DUPLICATE KEY UPDATE）认的仍是同一组列，按自然键的
// WHERE 查询也照旧走索引，只是它们现在走的是二级唯一索引而不是聚簇主键。
//
// AUTO_INCREMENT 列必须同时是某个 key，所以 DROP PRIMARY KEY / ADD UNIQUE KEY /
// ADD COLUMN … PRIMARY KEY 三件事必须在同一条 ALTER 里做完，不能拆成三条语句。
//
// 三处后果值得写在这里，它们不是这条迁移的副作用而是它的**代价**：
//
//  1. agent_session_notification_journal 原来按 (user_id, conversation_id, seq) 聚簇，
//     「取某条对话转录的尾部」因此是聚簇索引上的一段连续范围。换成 id 主键之后，那条
//     读路径变成二级唯一索引扫一段、再逐行回表取 payload（longblob）。
//
//  2. agent_activity_daily 的 dims_hash 是 STORED 生成列，原来参与主键，现在参与唯一
//     索引 —— 由数据库算摘要、应用与库对「什么算同一行」不会产生分歧这一点没有变。
//
//  3. sync_account_seqs 没有实体，全部走原生 SQL，而它取号的老写法靠 LAST_INSERT_ID(expr)
//     把版本号存在连接级变量上再读回。这张表一旦有了 AUTO_INCREMENT 列，一次真的插入
//     行的 INSERT 就会用自增值把那个变量顶掉，每个账号第一次分配因此拿回 id 而不是版本号
//     （MySQL 9.7 实测：期望 5、实得 1）。所以这条迁移与 sync_repo.NextVersion 的改写
//     是同一件事的两半 —— 取号改成在同一事务里读回 version_seq 列本身，不再经过那个变量。
func migration202609080101() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609080101",
		Migrate: func(tx *gorm.DB) error {
			return execAll(tx, []string{
				`ALTER TABLE sync_device_states
				  DROP PRIMARY KEY,
				  ADD UNIQUE KEY uk_sync_device_states_identity (user_id, device_id),
				  ADD COLUMN id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
				`ALTER TABLE sync_avatars
				  DROP PRIMARY KEY,
				  ADD UNIQUE KEY uk_sync_avatars_identity (user_id, content_hash),
				  ADD COLUMN id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
				`ALTER TABLE device_local_paths
				  DROP PRIMARY KEY,
				  ADD UNIQUE KEY uk_device_local_paths_identity (user_id, device_id, project_sync_id),
				  ADD COLUMN id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
				`ALTER TABLE agent_activity_daily
				  DROP PRIMARY KEY,
				  ADD UNIQUE KEY uk_agent_activity_daily_identity (user_id, day, dims_hash),
				  ADD COLUMN id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
				`ALTER TABLE user_settings
				  DROP PRIMARY KEY,
				  ADD UNIQUE KEY uk_user_settings_identity (user_id),
				  ADD COLUMN id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
				`ALTER TABLE device_flow_codes
				  DROP PRIMARY KEY,
				  ADD UNIQUE KEY uk_device_flow_codes_identity (device_code),
				  ADD COLUMN id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
				`ALTER TABLE agent_session_notification_journal
				  DROP PRIMARY KEY,
				  ADD UNIQUE KEY uk_agent_session_notification_journal_identity
				    (user_id, conversation_id, seq),
				  ADD COLUMN id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
				`ALTER TABLE sync_account_seqs
				  DROP PRIMARY KEY,
				  ADD UNIQUE KEY uk_sync_account_seqs_identity (user_id),
				  ADD COLUMN id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
			})
		},
		Rollback: func(tx *gorm.DB) error {
			return execAll(tx, []string{
				`ALTER TABLE sync_account_seqs
				  DROP COLUMN id,
				  DROP KEY uk_sync_account_seqs_identity,
				  ADD PRIMARY KEY (user_id)`,
				`ALTER TABLE agent_session_notification_journal
				  DROP COLUMN id,
				  DROP KEY uk_agent_session_notification_journal_identity,
				  ADD PRIMARY KEY (user_id, conversation_id, seq)`,
				`ALTER TABLE device_flow_codes
				  DROP COLUMN id,
				  DROP KEY uk_device_flow_codes_identity,
				  ADD PRIMARY KEY (device_code)`,
				`ALTER TABLE user_settings
				  DROP COLUMN id,
				  DROP KEY uk_user_settings_identity,
				  ADD PRIMARY KEY (user_id)`,
				`ALTER TABLE agent_activity_daily
				  DROP COLUMN id,
				  DROP KEY uk_agent_activity_daily_identity,
				  ADD PRIMARY KEY (user_id, day, dims_hash)`,
				`ALTER TABLE device_local_paths
				  DROP COLUMN id,
				  DROP KEY uk_device_local_paths_identity,
				  ADD PRIMARY KEY (user_id, device_id, project_sync_id)`,
				`ALTER TABLE sync_avatars
				  DROP COLUMN id,
				  DROP KEY uk_sync_avatars_identity,
				  ADD PRIMARY KEY (user_id, content_hash)`,
				`ALTER TABLE sync_device_states
				  DROP COLUMN id,
				  DROP KEY uk_sync_device_states_identity,
				  ADD PRIMARY KEY (user_id, device_id)`,
			})
		},
	}
}

// execAll 按序执行语句，任一条失败即整条迁移失败。
func execAll(tx *gorm.DB, statements []string) error {
	for _, statement := range statements {
		if err := tx.Exec(statement).Error; err != nil {
			return err
		}
	}
	return nil
}
