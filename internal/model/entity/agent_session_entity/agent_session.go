// Package agent_session_entity holds the account-scoped copy of the
// conversations the user has explicitly saved (2026-08-18-server-session-mirror.md
// decision 1): their summaries, the raw journal frames replayed off the peer
// that originated them, the delete todos left behind when the peer that must
// also purge its own copy was offline at delete time (decision 6), and the
// saves list that decides which conversations are copied here at all.
//
// The domain is named for what these rows *are* — an agent's sessions as this
// account sees them — not for the implementation that fills them
// (2026-08-27-schema-overhaul.md decision 19). "Mirror" survives only as a verb
// on mirror_svc, the service that claims a machine, attaches and pulls frames;
// "saved" is a property of one list, not of the domain, and "came from a peer"
// is a property of one column. Neither belongs in a table name: the server will
// grow locally originated sessions, and a name that encodes today's invariant
// breaks on that day.
//
// Identity across all four tables is **(account, originating peer
// fingerprint, that peer's local session id)** — never the machine currently
// carrying the connection (decision 17): the same conversation can have a
// copy on both the desktop and agentred, and which machine currently carries
// it can change without changing who originated it.
//
// SessionSummary mirrors agentre's wire.SessionSummary field-for-field
// (internal/pkg/agentruntime/runtimes/remote/wire/wire.go in the agentre
// repo). This repo must not import agentre/ (AGENTS.md), so the shape is
// re-declared here — precedent: sync_entity/payload.go's dual maintenance
// with the desktop's syncwire.GuardPayload.
package agent_session_entity

// SessionSummary is one mirrored conversation's summary — everything the
// unified session index needs (标题 / 所属 Agent 同步标识 / provider 会话身份 /
// cwd / 后端类型 / 生命周期状态 / 是否在等用户 / 最后活动时刻 / 最新 seq, per the
// spec's "存什么"). Cwd is stored so the server can resolve project affinity
// itself (decision 12), but it is a hard invariant that it never leaves the
// server in any response (R19) — callers must not add it to a DTO.
type SessionSummary struct {
	ID              int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID          int64  `gorm:"column:user_id;type:bigint;not null"`
	PeerFingerprint string `gorm:"column:peer_fingerprint;type:varchar(255);not null"`
	PeerSessionID   string `gorm:"column:peer_session_id;type:varchar(255);not null"`
	// Title / AgentSyncID / ProviderSessionID mirror wire.SessionSummary's R7 +
	// decision-8 fields. The peer carries them on every turn and overwrites them
	// idempotently, so they stay blank until it has reported one — a session that
	// has not run its first turn has no title yet, because the title is derived
	// from the first message. Kept as-is: never guessed, never a placeholder.
	Title             string `gorm:"column:title;type:text;not null;default:''"`
	AgentSyncID       string `gorm:"column:agent_sync_id;type:varchar(255);not null;default:''"`
	ProviderSessionID string `gorm:"column:provider_session_id;type:varchar(255);not null;default:''"`
	Cwd               string `gorm:"column:cwd;type:text;not null;default:''"`
	// ProjectSyncID is the project the peer named for itself. Only the desktop
	// reports it — it has no per-session cwd to report, so the (fingerprint,
	// cwd) comparison decision 12 uses for agentred can never resolve one of
	// its conversations. Blank on agentred and on peers that predate the
	// field, and blank means "derive it from cwd", not "no project": the two
	// derivations coexist (see workspace_svc's projectOfRow).
	//
	// Unlike Cwd this one is not a path and does leave the server — it is the
	// same opaque sync id the index already returns as
	// SavedSessionSummaryView.ProjectSyncID, so R19 is untouched.
	ProjectSyncID   string `gorm:"column:project_sync_id;type:varchar(255);not null;default:''"`
	BackendType     string `gorm:"column:backend_type;type:varchar(64);not null;default:''"`
	LifecycleState  string `gorm:"column:lifecycle_state;type:varchar(32);not null;default:''"`
	WaitingForInput bool   `gorm:"column:waiting_for_input;type:boolean;not null;default:false"`
	LatestSeq       int64  `gorm:"column:latest_seq;type:bigint;not null;default:0"`
	// LastMessageAt mirrors wire.SessionSummary.LastMessageAt: the peer's own
	// record of this session's last activity (Unix ms), 0 when the peer never
	// reported one. It is the sort key of the paging index, half of the paging
	// cursor, and one side of the "unread" predicate.
	//
	// 这一列此前叫 updated_at，于是 GORM 把它认作自己的自动时间戳列，任何一条普通
	// Updates 都会被追加 `updated_at`=<当前 Unix 秒>，把发起端上报的毫秒活动时刻
	// 悄悄改写掉；实体上因此不得不挂 autoUpdateTime:false 当防线。改名之后那条陷阱
	// 是由列名招来的这件事随之消失（2026-08-27-schema-overhaul.md 决策 10），标签
	// 也就撤掉了。守卫见 agent_session_repo 的
	// TestSessionSummaryEntity_PlainUpdatesNeverRewritesLastMessageAt。
	LastMessageAt int64 `gorm:"column:last_message_at;type:bigint;not null;default:0"`
	// LastReadAt is when this account last opened the conversation (Unix ms), 0
	// when it never has. "Unread" is exactly LastMessageAt > LastReadAt — the same
	// predicate the desktop's attention-store uses (lastMessageAt > lastReadAt).
	// It is deliberately absent from UpsertSummary's assignment list: the peer
	// reports activity, it does not know what this account has read.
	// ProviderKey / ModelKey 是这条对话自己钉的 LLM ModelTarget，逐字镜像发起端
	// 那两列（桌面端 chat_sessions / agentred daemon_sessions）：两者皆空 = 跟随
	// Agent 绑定、provider 非空 + model 空 = 该供应商当前默认、两者非空 = 固定模型。
	//
	// 空**有含义**（跟随绑定），所以它不能兼职「对端没报」；「这台机器认不认识这两
	// 格」由对端在会话清单里单独声明，不从这里推断。
	//
	// 存的是**发起端**那一份：同一条对话可以在桌面端与 agentred 上各有一份，两台
	// 值不一致时以发起端为准，而这张表的身份键本来就是 (账号, 发起端指纹, 会话 id)。
	ProviderKey string `gorm:"column:provider_key;type:varchar(255);not null;default:''"`
	ModelKey    string `gorm:"column:model_key;type:varchar(255);not null;default:''"`
	LastReadAt  int64  `gorm:"column:last_read_at;type:bigint;not null;default:0"`
	Createtime  int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime  int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*SessionSummary) TableName() string { return "agent_sessions" }

// JournalFrame is one typed Protobuf RpcNotification replayed off the peer's
// own notification log. Payload is an opaque Protobuf binary frame; readers
// decode it with the local generated contract.
//
// 这四列既是身份也是主键（migrations/202608280008_agent_sessions.go）：帧按 (账号, 发起端, 会话, seq)
// 聚簇存放，没有代理自增列。转录尾部因此是聚簇索引上的一段连续范围，而不是二级索引
// 扫一段再逐行随机回表取 longblob。
type JournalFrame struct {
	UserID          int64  `gorm:"column:user_id;type:bigint;not null;primaryKey"`
	PeerFingerprint string `gorm:"column:peer_fingerprint;type:varchar(255);not null;primaryKey"`
	PeerSessionID   string `gorm:"column:peer_session_id;type:varchar(255);not null;primaryKey"`
	Seq             int64  `gorm:"column:seq;type:bigint;not null;primaryKey"`
	Payload         []byte `gorm:"column:payload;type:longblob;not null"`
	Createtime      int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
}

func (*JournalFrame) TableName() string { return "agent_session_notification_journal" }

// DeleteTodo is a pending delete: the server's own copy of a conversation is
// already gone, but the peer that must also delete its local copy (desktop
// chat_sessions row, or agentred's session + journal) was offline at delete
// time (decision 6). It is consumed — and this row removed — the next time
// that peer comes online and receives the delete; a device revocation clears
// it outright instead (decision 7), since a revoked peer never executes
// anything on this account's behalf again.
type DeleteTodo struct {
	ID              int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID          int64  `gorm:"column:user_id;type:bigint;not null"`
	PeerFingerprint string `gorm:"column:peer_fingerprint;type:varchar(255);not null"`
	PeerSessionID   string `gorm:"column:peer_session_id;type:varchar(255);not null"`
	Createtime      int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
}

func (*DeleteTodo) TableName() string { return "agent_session_delete_todos" }
