package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609040108 creates the three account-scoped agent-session tables
// (2026-08-18-server-session-mirror.md "存什么" / decision 17): a summary per
// conversation, its raw durable frames, and pending cross-peer deletes.
//
// The tables are named for the rows, not for the mechanism that fills them
// (2026-08-27-schema-overhaul.md 决策 19): "mirror" and "followed" were two
// implementation metaphors for one domain, and "saved" / "came from a peer" are
// properties of one list and one column, not of the domain. Mirroring survives
// as a verb on mirror_svc.
//
// Identity across all three tables is (user_id, conversation_id) —
// agent_session_durable_frames adds seq
// (2026-08-31-conversation-centric-addressing.md「会话身份」). conversation_id is
// one and the same identity for a conversation across the desktop, agentred and
// server databases and on the wire (决策 1); the originating peer mints it as a
// UUIDv7. peer_fingerprint stays on the tables but has left identity: it is a
// provenance and authorization column now.
//
// conversation_id is char(36) rather than varchar(36): a canonical uuid is
// always 36 characters, so a fixed width drops one length prefix per row — and
// agent_session_durable_frames is the only unbounded table here (frames go
// away only when the conversation does), where this column is part of the
// primary key and therefore copied into every secondary index.
// COLLATE utf8mb4_0900_bin for the same reason as its neighbours: it is an
// opaque identifier, and folding case would merge two distinct conversations.
//
// peer_fingerprint has to compare equal against devices.fingerprint, so it takes
// the same utf8mb4_0900_bin collation — it is an opaque, byte-exact identifier,
// and folding case would widen a fingerprint match.
//
// agent_session_delete_todos calls its machine column **device_fingerprint**,
// not peer_fingerprint: what it stores is the machine that *carries* the
// conversation (the one to dial when replaying the delete), not the originating
// peer. The two ranges overlap — for a conversation opened on this machine they
// are the same value — so getting the column wrong raises no error anywhere, it
// just sends the todo to a machine that never ran the conversation. The other
// four aliases (agentred_ / daemon_ / machine_ / sync_origin_) name their role
// correctly and stay; see agentre/docs/architecture.md「Device fingerprints」.
//
// Each table carries exactly one unique key, so an ON DUPLICATE KEY UPDATE
// replay is unambiguous about which row it collided with
// (docs/architecture.md's "one unique key" rule).
//
// agent_session_durable_frames 原本把身份键当**主键**、而不是另加一根自增列，
// 理由是这个表在这里是唯一一张无界增长的表（帧只在对话被删时才回收），聚簇因此是存储
// 决定而不是记账：一根自增 id 会把一条对话的帧打散在整个聚簇索引上，而详情页读的是
// 一条对话的**尾部**（seq DESC LIMIT n，ListFramesBefore）。
//
// 后来库级约定统一成「每一张表的行身份都是一个与业务取值无关的数字」（见
// internal/model/entity 的 TestEveryEntityHasAutoIncrementIDPrimaryKey），这张表也补了
// id 主键，那笔开销因此是真的付了：尾部读取现在是二级唯一索引扫一段、再逐行回表取
// payload。记在这里，免得下次有人重新推导一遍这个代价。
//
// agent_session_durable_frames.payload 是 json（早期是 longblob，存的是 protobuf
// 字节）：text 的 64KB 上限会把大帧截断（与 migration202609040106 里 sync_objects.payload
// 同一个理由），而 json 没有 64KB 上限。
//
// 这张表没有 `params` 列——早期草稿把帧拆成 method/params，注释比列活得久。
//
// title is text, not varchar: it is whatever display string the peer reports,
// and nothing on either side bounds its length — the desktop's rename path
// caps at 200 runes but an imported session's title is the first line of its
// first message. Under a varchar ceiling an over-long one does not truncate,
// it fails the whole upsert with ER_DATA_TOO_LONG, so that conversation never
// mirrors at all and the error names neither the column nor the title. cwd is
// text for the same reason.
func migration202609040108() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609040108",
		Migrate: func(tx *gorm.DB) error {
			statements := []string{`
				CREATE TABLE agent_sessions (
				  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id              bigint NOT NULL,
				  conversation_id      char(36) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  peer_fingerprint     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  title                text NOT NULL DEFAULT (''),
				  agent_sync_id        varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  provider_session_id  varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  cwd                  text NOT NULL DEFAULT (''),
				  backend_type         varchar(64) NOT NULL DEFAULT '',
				  lifecycle_state      varchar(32) NOT NULL DEFAULT '',
				  waiting_for_input    boolean NOT NULL DEFAULT false,
				  project_sync_id     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  provider_key        varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  model_key           varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  last_read_at        bigint NOT NULL DEFAULT 0,
				  latest_seq           bigint NOT NULL DEFAULT 0,
				  -- 发起端自己记的最后活动时刻。**不叫 updated_at**：那是行更新时刻的
				  -- 名字，GORM 会按它自动改写这一列，而这一列是排序键、分页游标的一半
				  -- 与「未读」判据的一边（2026-08-27-schema-overhaul.md 决策 10）。
				  last_message_at      bigint NOT NULL DEFAULT 0,
				  createtime           bigint NOT NULL DEFAULT 0,
				  updatetime           bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_agent_sessions_identity (user_id, conversation_id),
				  KEY idx_agent_sessions_recent (user_id, last_message_at, id),
				  KEY idx_agent_sessions_agent_recent
				    (user_id, agent_sync_id, last_message_at, id),
				  KEY idx_agent_sessions_project_recent
				    (user_id, project_sync_id, last_message_at, id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, `
				CREATE TABLE agent_session_durable_frames (
				  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id              bigint NOT NULL,
				  conversation_id      char(36) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  peer_fingerprint     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  seq                  bigint NOT NULL,
				  payload              json NOT NULL,
				  createtime           bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_agent_session_durable_frames_identity (user_id, conversation_id, seq)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, `
				CREATE TABLE agent_session_delete_todos (
				  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id              bigint NOT NULL,
				  conversation_id      char(36) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
				  device_fingerprint   varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  createtime           bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_agent_session_delete_todos_identity (user_id, conversation_id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
			}
			for _, statement := range statements {
				if err := tx.Exec(statement).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			for _, table := range []string{
				"agent_session_delete_todos", "agent_session_durable_frames", "agent_sessions",
			} {
				if err := tx.Exec("DROP TABLE IF EXISTS " + table).Error; err != nil {
					return err
				}
			}
			return nil
		},
	}
}
