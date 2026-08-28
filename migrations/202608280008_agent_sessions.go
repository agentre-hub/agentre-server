package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202608280008 creates the three account-scoped agent-session tables
// (2026-08-18-server-session-mirror.md "存什么" / decision 17): a summary per
// conversation, its raw journal frames, and pending cross-peer deletes.
//
// The tables are named for the rows, not for the mechanism that fills them
// (2026-08-27-schema-overhaul.md 决策 19): "mirror" and "followed" were two
// implementation metaphors for one domain, and "saved" / "came from a peer" are
// properties of one list and one column, not of the domain. Mirroring survives
// as a verb on mirror_svc.
//
// Identity across all three tables is (user_id, peer_fingerprint,
// peer_session_id) — the *originating* peer and its own local session id
// (decision 17), not whichever machine currently carries the connection.
// peer_fingerprint has to compare equal against devices.fingerprint, so it takes
// the same utf8mb4_0900_bin collation; peer_session_id aligns with the existing
// agent_session_saves.peer_session_id column (varchar(255) COLLATE
// utf8mb4_0900_bin) for the same reason — both are opaque, byte-exact
// identifiers, and folding case would merge two distinct sessions or widen a
// fingerprint match. The name says *whose* session id it is: the desktop's own
// peer_session_id means its local chat_sessions.id, and the same word for two things
// is the failure mode 决策 12 removes.
//
// Each table carries exactly one unique key, so an ON DUPLICATE KEY UPDATE
// replay is unambiguous about which row it collided with
// (docs/architecture.md's "one unique key" rule).
//
// agent_session_notification_journal makes that key its **primary** key rather than adding
// a surrogate auto-increment alongside it. This table is the only one here
// that grows without bound — frames are removed only when the conversation
// is deleted — so its clustering is a storage decision, not bookkeeping. An
// auto-increment id would scatter one conversation's frames across the whole
// clustered index, and the detail page reads a conversation's *tail* (seq
// DESC LIMIT n, ListFramesBefore): a secondary-index range scan followed by
// one random primary-key lookup per row to fetch the longblob. Clustering on
// the identity makes that one contiguous range, removes the duplicate copy of
// two varchar(255) columns that the separate unique index would hold, and
// turns DeleteFrames into a range delete. Inserts stop being globally
// monotonic, but within a conversation they still append by seq, and there
// are far fewer conversations than frames — so the shape is "several tails
// being appended to", not random writes.
//
// agent_session_notification_journal.params is a json column, not text: text's 64KB
// ceiling would truncate a large frame (same reasoning as
// sync_objects.payload in migration202608280006).
//
// title is text, not varchar: it is whatever display string the peer reports,
// and nothing on either side bounds its length — the desktop's rename path
// caps at 200 runes but an imported session's title is the first line of its
// first message. Under a varchar ceiling an over-long one does not truncate,
// it fails the whole upsert with ER_DATA_TOO_LONG, so that conversation never
// mirrors at all and the error names neither the column nor the title. cwd is
// text for the same reason.
func migration202608280008() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202608280008",
		Migrate: func(tx *gorm.DB) error {
			statements := []string{`
				CREATE TABLE agent_sessions (
				  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id              bigint NOT NULL,
				  peer_fingerprint     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  peer_session_id      varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
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
				  UNIQUE KEY uk_agent_sessions_identity
				    (user_id, peer_fingerprint, peer_session_id),
				  KEY idx_agent_sessions_recent (user_id, last_message_at, id),
				  KEY idx_agent_sessions_agent_recent
				    (user_id, agent_sync_id, last_message_at, id),
				  KEY idx_agent_sessions_project_recent
				    (user_id, project_sync_id, last_message_at, id)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, `
				CREATE TABLE agent_session_notification_journal (
				  user_id              bigint NOT NULL,
				  peer_fingerprint     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  peer_session_id      varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  seq                  bigint NOT NULL,
				  payload              longblob NOT NULL,
				  createtime           bigint NOT NULL DEFAULT 0,
				  PRIMARY KEY (user_id, peer_fingerprint, peer_session_id, seq)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, `
				CREATE TABLE agent_session_delete_todos (
				  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
				  user_id              bigint NOT NULL,
				  peer_fingerprint     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  peer_session_id      varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
				  createtime           bigint NOT NULL DEFAULT 0,
				  UNIQUE KEY uk_agent_session_delete_todos_identity
				    (user_id, peer_fingerprint, peer_session_id)
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
				"agent_session_delete_todos", "agent_session_notification_journal", "agent_sessions",
			} {
				if err := tx.Exec("DROP TABLE IF EXISTS " + table).Error; err != nil {
					return err
				}
			}
			return nil
		},
	}
}
