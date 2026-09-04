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
// Identity across all four tables is **(account, conversation_id)** — the
// conversation's own global id, minted once by whoever created it and identical
// in all three databases and on the wire
// (2026-08-31-conversation-centric-addressing.md decisions 1/2). It is never the
// machine currently carrying the connection: the same conversation can have a
// copy on both the desktop and agentred, and which machine carries it can change
// without changing the conversation. PeerFingerprint / PeerSessionID survive as
// ordinary columns — provenance and authorization, not identity.
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
	ID int64 `gorm:"column:id;primaryKey;autoIncrement"`
	// UserID + ConversationID 是这一行的身份键（uk_agent_sessions_identity）。
	UserID int64 `gorm:"column:user_id;type:bigint;not null"`
	// ConversationID 是这条对话的全局标识：新对话由发起端铸 UUIDv7，存量对话按
	// 决策 2 从 (peer_fingerprint, peer_session_id) 派生 UUIDv5，桌面端、agentred
	// 与本库因此指的是同一个值。
	ConversationID string `gorm:"column:conversation_id;type:char(36);not null"`
	// PeerFingerprint 是**发起**这条对话那一端。它已退出身份键（决策 7 / 8），
	// 留下来承担来源标注（索引里按对端分组的那一轴）与授权。
	PeerFingerprint string `gorm:"column:peer_fingerprint;type:varchar(255);not null"`
	// PeerSessionID 是发起端本地那条会话的号。同样退出身份键，留作来源标注：
	// 存量行靠它与 PeerFingerprint 派生出上面的 ConversationID。
	PeerSessionID string `gorm:"column:peer_session_id;type:varchar(255);not null"`
	// MachineFingerprint 是索引读取时从 agent_session_saves 投影出的承载机器指纹。
	// 它不是摘要表的一列，也不是会话身份的一半；只读标签防止摘要 upsert 写它。
	MachineFingerprint string `gorm:"column:machine_fingerprint;->"`
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
// 这三列既是身份也是主键（migrations/202609040108_agent_sessions.go）：
// 帧按 (账号, 对话, seq) 聚簇存放，没有代理自增列。转录尾部因此是聚簇索引上的一段
// 连续范围，而不是二级索引扫一段再逐行随机回表取 longblob。
//
// PeerFingerprint / PeerSessionID 留在表上作来源标注，但**不再是主键的一部分**。
type JournalFrame struct {
	UserID          int64  `gorm:"column:user_id;type:bigint;not null;primaryKey"`
	ConversationID  string `gorm:"column:conversation_id;type:char(36);not null;primaryKey"`
	Seq             int64  `gorm:"column:seq;type:bigint;not null;primaryKey"`
	PeerFingerprint string `gorm:"column:peer_fingerprint;type:varchar(255);not null"`
	PeerSessionID   string `gorm:"column:peer_session_id;type:varchar(255);not null"`
	Payload         []byte `gorm:"column:payload;type:longblob;not null"`
	// Createtime 记的是这一帧**发生**的时刻（Unix 毫秒），不是这台 server 存下它的
	// 时刻。实时那一路两者只差一跳网络，补齐那一路差得很远——补齐成批到达，一条离线
	// 两天的对话几百帧会落在同一毫秒里，拿收帧时刻当发生时刻，浏览器控制台上整段
	// 转录就显示成同一分钟。所以它由产生这一帧的那一端报出（agentred 的
	// daemon_notification_journal.createtime、桌面端消息自己的 createtime），
	// mirror_svc 原样落库。
	//
	// 0 = 那一端没报过（还没升级的对端）。0 一路保持「不知道」下行，渲染成不显示
	// 时间——不在任何一跳上补一个当下。
	Createtime int64 `gorm:"column:createtime;type:bigint;not null;default:0"`
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
	ID     int64 `gorm:"column:id;primaryKey;autoIncrement"`
	UserID int64 `gorm:"column:user_id;type:bigint;not null"`
	// ConversationID 与 UserID 一起是这条待办的身份键：同一条对话只欠一条删除。
	ConversationID string `gorm:"column:conversation_id;type:char(36);not null"`
	// DeviceFingerprint 是**要拨给谁**（补删时拨的那台机器），不是身份的一半——
	// 见 ListPendingMachines 与 saved_session_svc.Delete。它曾经叫
	// peer_fingerprint，而那个名字说的是发起端：两个角色的取值范围重叠（本机开的
	// 对话两者同值），拿错了列不会有任何一处报错，只会把待办拨给一台从来没跑过这
	// 条对话的机器。这个名字的理由见 migrations/202609040108_agent_sessions.go。
	DeviceFingerprint string `gorm:"column:device_fingerprint;type:varchar(255);not null"`
	PeerSessionID     string `gorm:"column:peer_session_id;type:varchar(255);not null"`
	Createtime        int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
}

func (*DeleteTodo) TableName() string { return "agent_session_delete_todos" }
