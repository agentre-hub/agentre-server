// Package agent_session_svc 是账号会话镜像的**读侧**：「对话」页的索引与详情。
//
// 它按域从 workspace_svc 分出来（工作区规约「一个域一套包」）：索引分页、镜像转录、
// 转录投影与已读标记合起来是一个自成一体的域，与组织面 / 派发计划没有共用的判据。
// 写侧不在这里——镜像收帧落库由 mirror_svc 负责，本包只读 agent_session_repo。
//
// R19 在这一侧同样成立：镜像的 cwd 只参与「这条对话归哪个项目」的比较，比完就地出局，
// 一个字段都不进发往浏览器的视图。
package agent_session_svc

import (
	"context"
	"encoding/json"

	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
)

// SavedSessionSummaryView 是 web 统一会话索引一行的数据源：账号里已保存的一条
// 对话，机器在线与否都在（内容来自镜像，不再逐台机器经中继解析）。ProjectSyncID
// 由服务端就地判定（决策 12）——镜像的 cwd 与账号项目树上的路径比对，配不上时留
// 空（未归项目），cwd 本身永不下行（R19）。
type SavedSessionSummaryView struct {
	// ConversationID 是这条对话的全局标识，也是它在镜像库里的身份。
	ConversationID string
	// PeerFingerprint 是发起这条对话那一端的设备指纹。它已退出身份键，留作来源
	// 标注（机器轴那一组的分组键）与授权。
	PeerFingerprint string
	// MachineFingerprint 是承载这条对话、详情页实际要连接的账号设备；它与发起端
	// 可以不同（浏览器派发到 agentred 时就是不同值）。
	MachineFingerprint string
	// Title / AgentSyncID 为空 = 发起端还没报过这两格。标题由首条消息派生、每轮随
	// RunParams 幂等覆盖，所以还没发出第一句的会话就是没有标题。如实留空，不猜、
	// 不填占位。
	Title           string
	AgentSyncID     string
	ProjectSyncID   string
	BackendType     string
	LifecycleState  string
	WaitingForInput bool
	// LastMessageAt 是发起端自己记的最后活动时刻（Unix 毫秒），没记过时为 0。
	LastMessageAt int64
	// LastReadAt 是这个账号最后一次打开这条对话的时刻（Unix 毫秒），从没打开过为 0。
	// 「未读」就是 LastMessageAt > LastReadAt。
	LastReadAt int64
	// ProviderKey / ModelKey 是这条对话自己钉的 LLM ModelTarget（两者皆空 = 跟随
	// Agent 绑定）。镜像自发起端那两列，机器离线时详情页据此仍显示得出模型 ——
	// 这正是「已保存」承诺的一部分。两者都是不透明稳定 key，不是路径（R19 不受影响）。
	ProviderKey string
	ModelKey    string
}

// TranscriptQuery 是一次按游标翻转录的入参。UserID 来自调用方鉴权上下文，不由
// 调用方填，跨账号因此读不到。AfterSeq 是调用方自己的位置（不含），0 表示从头翻；
// Limit<=0 时走服务端默认档，服务端同样会夹一个上限。
type TranscriptQuery struct {
	UserID int64
	// ConversationID 是这条对话的全局标识，也是镜像库里帧的身份键的一半
	// （另一半是 UserID）。
	ConversationID string
	AfterSeq       int64
	Limit          int
	// Backward 为 true 时改成**从最新往回**按预算取一页（详情页打开一条对话时要的
	// 是它最后那一段，规格 2026-08-21-transcript-tail-loading 决策 7）。此时
	// AfterSeq 与 Limit 都不参与：这个方向的一页有多大由预算说了算。
	Backward bool
	// BeforeSeq 是反向读的**排他上界**，0 表示从最新往回。它与 AfterSeq 分开而不是
	// 复用同一个字段：一个字段在两个方向上表示两件事，是本仓注释反复防的形态。
	BeforeSeq int64
}

// TranscriptFrameView 是给 Web HTTP API 的 JSON 投影视图。
//
// 它与镜像日志库里那一行**同形**：2026-09-07-journal-payload-json.md 之后
// agent_session_notification_journal.payload 存的就是 {method, params} 的 JSON，
// 读取边界只是把它取出来（wireview.DecodeStoredFrame），不再解一次 Protobuf。
// 这一侧读不懂的那一行在这里出场为 methodUndecodableFrame 的缺口帧。
type TranscriptFrameView struct {
	Seq    int64
	Method string
	Params json.RawMessage
	// Createtime 是这一帧**发生**的时刻（Unix 毫秒），由产生它的那一端报出、镜像原样
	// 落库。0 = 那一端没报过（还没升级的对端），读作「不知道」，不是 1970。
	//
	// 浏览器的转录是从帧现折出来的，除了这一格没有别的时刻可读（桌面端读的是自己
	// 库里的 chat_messages.createtime），所以它必须一路下行到 HTTP view。
	Createtime int64
}

// TranscriptPage 是一页。Cursor 是这一页读到的位置，**不是**这条对话的「最新」
// seq——它只代表这个 server 镜到哪（与 agent_sessions.latest_seq 同一个
// 陷阱）：机器在线时浏览器还要从中继接实时，两者按 seq 拼在一起。HasMore 为 true
// 时带着 Cursor 再翻一页；空页上 Cursor 保持不变（不回退到 0），否则调用方会把
// 整段日志重放一遍。
type TranscriptPage struct {
	Frames []TranscriptFrameView
	// Cursor 在**两个方向上同义**：这一页里最新那条的 seq。调用方拿它预置中继游标
	// 那条路因此不必分方向。
	Cursor  int64
	HasMore bool
	// OldestSeq 是这一页里**最老**那条的 seq，往上翻的下一次入参；HasBefore 说明
	// 还有没有更早的。两者只有反向读会填。
	//
	// 单开两列而不是按方向改写 Cursor 的含义：一个字段两种意思，读的人分不清。
	//
	// 三个数（Cursor / OldestSeq / HasBefore）一律按**原始日志行**算，与投影后
	// 交出了几条无关——投影丢掉窗口末尾那帧时若跟着把 Cursor 往回挪，调用方预置的
	// 游标就会停在它前面，此后每条实时帧都被判成跳号丢光。
	OldestSeq int64
	HasBefore bool
}

// SessionReadSvc 是「对话」页读侧需要的那一小片（ISP）：索引、转录、已读标记。
//
// 它从 WorkspaceSvc 里摘出来，是因为 agent_session_ctr 只用这三个方法，却因为共用一个
// 15 方法的接口，连测试替身都得把另外 12 个全实现一遍（各写一句 panic）。
type SessionReadSvc interface {
	// Transcript 按游标翻一条对话的镜像转录：seq 严格大于 in.AfterSeq 的帧，按 seq
	// 升序，翻页用。scoped by in.UserID——读到别的账号的转录就是一次跨账号泄漏。
	Transcript(ctx context.Context, in TranscriptQuery) (TranscriptPage, error)
	// SessionIndex 是「对话」页那个索引的读侧
	// （2026-08-19-session-index-pagination.md）：不带 scope 时给出该轴全部组的骨架
	// （组身份 + 每组在当前范围下的真数 + 每组先给的那几条），带 scope 时按游标翻
	// 那一组。搜索只按标题、筛选按状态，两者与分页复合；项目归属仍就地判定，
	// cwd 一路只参与比较（R19）。
	SessionIndex(ctx context.Context, in SessionIndexQuery) (SessionIndexPage, error)
	// MarkSessionRead 记下「这个账号此刻读到这条对话为止」，供索引的「未读」那一档
	// 判定（unread = updated_at > last_read_at，与桌面端 attention-store 同一条）。
	//
	// 时刻由服务端就地取，不收客户端的：客户端的钟不可信，而这个时刻要和服务端自己
	// 记的 updated_at 相比。返回落定的那个时刻，供调用方就地覆盖那一行。
	// 账号里没有这条对话时不是错——标记已读幂等，回落定值即可。
	MarkSessionRead(ctx context.Context, userID int64, conversationID string) (int64, error)
	// AttentionCounts 是侧栏「对话」那颗角标底下的两个数：账号里此刻**等你处理**的
	// 条数，与**未读**的条数。判据与索引上那几个 chip 是同一个（仓储的
	// attentionExpr）——侧栏说有 3 条等你、点进去筛选却是 2 条，是一种没有任何地方
	// 会报错而用户一眼就看得见的错。
	//
	// 两个数而不是一个：角标只有一个数字位，但它底下是两件事，`title` 要把它们分开
	// 说（「N 条等你处理 · M 条未读」）。合成一个交出来的话那句话就拆不回来了。
	//
	// 只回数字：这条路在每一次进入任何页面时都会跑一遍，而一页摘要里的标题、
	// 游标、项目归属一个都用不上。0 是答案不是失败——那时角标整个不画。
	AttentionCounts(ctx context.Context, userID int64) (agent_session_repo.AttentionCounts, error)
}

// sessionReadSvc 是这一族的实现。它无状态，每次调用都直接读 agent_session_repo /
// sync_repo 的当前状态，不持有任何缓存。
type sessionReadSvc struct{}

// New 构造一个无状态的 SessionReadSvc。
func New() *sessionReadSvc { return &sessionReadSvc{} }

var defaultSessionRead SessionReadSvc = New()

func SessionRead() SessionReadSvc     { return defaultSessionRead }
func SetSessionRead(s SessionReadSvc) { defaultSessionRead = s }
