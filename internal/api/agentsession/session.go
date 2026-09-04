// Package agentsession 定义 web 统一会话索引与详情页要读的两个端点：账号里已保存的
// 每条对话的摘要，以及一条对话按游标翻页的转录
// （2026-08-18-server-session-mirror.md 「索引与详情读到什么」）。
//
// 路径与包名照实说这些是**账号里的 agent 会话**，而不是填充它们的那套机制
// （2026-08-27-schema-overhaul.md 决策 19）：镜像是动作，留在 mirror_svc 上。
//
// R19：两个响应都不带 cwd——项目归属在服务端就地判定（决策 12），只有判定结果
// （项目同步标识）过线，路径本身连字段都没有。internal/api/workspace/guard_test.go
// 的反射白名单把这两个响应根也走了一遍。
package agentsession

import (
	"encoding/json"

	"github.com/cago-frame/cago/server/mux"
)

// ---------- 摘要：账号里已保存的对话 ----------

// SavedSessionsRequest 读一次会话索引（2026-08-19-session-index-pagination.md
// 「索引读到什么」）。账号取自鉴权上下文。
//
// 四组正交的入参：**要哪一套组**（Axis）、**要不要只看其中一组**（Scope）、
// **位置与大小**（Cursor / Limit / PerGroup）、**范围**（Q / Filter）。范围一变位置
// 必须回到起点——换了搜索词还接着上一页的游标翻，翻的是另一个集合里的位置。
type SavedSessionsRequest struct {
	mux.Meta `path:"/v1/agent-sessions" method:"GET"`
	// Axis 决定摆哪一套组；不填按时间轴（一个平铺组）。
	Axis string `form:"axis" binding:"omitempty,oneof=time project agent machine"`
	// Scope 是一个组的身份（组头上那个值原样回传）：time / project:<sync_id> /
	// unassigned-project / agent:<sync_id> / unnamed-agent / machine:<fingerprint>。
	// 不填表示要这个轴的全部组。认不出来的值是错，不当成没传。
	Scope string `form:"scope" binding:"omitempty,max=300"`
	// Cursor 是上一页给的位置，对调用方不透明；空表示从头。
	Cursor string `form:"cursor" binding:"omitempty,max=64"`
	// Limit 是带 Scope 时的一页大小；PerGroup 是不带 Scope 时每组先给几条。
	// 都不填走服务端默认档，超上限服务端就地夹住。
	Limit    int `form:"limit" binding:"omitempty,min=1"`
	PerGroup int `form:"per_group" binding:"omitempty,min=1"`
	// Q 只按标题匹配（决策 8）：机器名 / Agent 名 / 项目名不参与，按它们找对话走
	// 轴和组头那条正路。
	Q      string `form:"q" binding:"omitempty,max=200"`
	Filter string `form:"filter" binding:"omitempty,oneof=all running waiting unread"`
	// ConversationID 非空时走精确认领：不分组、不分页。conversation_id 全局唯一，
	// 这条路至多命中一行（详情页按对话直取，决策 13）。
	ConversationID string `form:"conversation_id" binding:"omitempty,uuid"`
}

// SavedSessionItem 是索引一行的材料。
type SavedSessionItem struct {
	// ConversationID 是这条对话的身份，三套库与线格式上同一个值（决策 1）：
	// 详情页、转录、标记已读、删除都拿它寻址。
	ConversationID string `json:"conversation_id"`
	// PeerFingerprint 是发起这条对话那一端的设备指纹。它**不再是身份的一半**，
	// 留作来源标注（机器轴那一组的分组键）与授权。
	PeerFingerprint string `json:"peer_fingerprint"`
	// MachineFingerprint 是当前承载这条对话的账号设备指纹，供 web 选择实际连接目标；
	// 与上面的发起端指纹分开，二者不能互相代替。
	MachineFingerprint string `json:"machine_fingerprint"`
	// Title / AgentSyncID 为空 = 发起端还没报过这两格。标题由首条消息派生、每轮随
	// RunParams 幂等覆盖，所以还没发出第一句的会话就是没有标题。如实留空，不猜、
	// 不填占位。
	Title       string `json:"title,omitempty"`
	AgentSyncID string `json:"agent_sync_id,omitempty"`
	// ProjectSyncID 是服务端就地判定出的项目归属（决策 12）：镜像的 cwd 与账号项目
	// 树上的路径比对，配不上时留空（未归项目）。cwd 本身永不下行（R19）。
	ProjectSyncID   string `json:"project_sync_id,omitempty"`
	BackendType     string `json:"backend_type,omitempty"`
	LifecycleState  string `json:"lifecycle_state,omitempty"`
	WaitingForInput bool   `json:"waiting_for_input,omitempty"`
	// LastMessageAt 是发起端自己记的最后活动时刻（Unix 毫秒），没记过时为 0。
	// 与桌面端 chat_sessions.last_message_at、线格式 SessionSummary.last_message_at
	// 同一个词（决策 10）。
	LastMessageAt int64 `json:"last_message_at,omitempty"`
	// LastReadAt 是这个账号最后一次打开这条对话的时刻（Unix 毫秒），从没打开过时为 0。
	// 「未读」就是 LastMessageAt > LastReadAt —— 与桌面端 attention-store 同一条判据。
	// 下行的是**时刻**而不是一个算好的布尔：客户端手里有乐观覆盖层（刚打开的那条
	// 当场就该不再是未读），给它两个时刻它才判得动。
	LastReadAt int64 `json:"last_read_at,omitempty"`
	// ProviderKey / ModelKey 是这条对话自己钉的 LLM ModelTarget：两者皆空 = 跟随
	// Agent 绑定、provider 非空 + model 空 = 该供应商当前默认、两者非空 = 固定模型。
	// 机器离线时详情页据此仍显示得出模型。两者都是不透明稳定 key，不是路径。
	ProviderKey string `json:"provider_key,omitempty"`
	ModelKey    string `json:"model_key,omitempty"`
}

// SavedSessionGroup 是一个组：身份、它在**当前搜索与筛选下**的真数，以及先给的那
// 几条。Total 大于 Items 的长度时调用方拿 Scope + Cursor 继续翻这一组（「查看全部
// N 个会话」那条路）。
type SavedSessionGroup struct {
	Scope   string             `json:"scope"`
	Total   int64              `json:"total"`
	Items   []SavedSessionItem `json:"items"`
	Cursor  string             `json:"cursor,omitempty"`
	HasMore bool               `json:"has_more,omitempty"`
}

// SavedSessionsResponse 是一次索引读取的结果。Groups 与 Items 互斥：不带 Scope 时
// 给组骨架，带 Scope（或按会话号精确查）时给行。
//
// Total 是当前搜索与筛选下**账号里**的条数，与已加载多少无关（决策 10）——顶栏那个
// 计数用它，因此它不随滚动往上跳。
type SavedSessionsResponse struct {
	Groups  []SavedSessionGroup `json:"groups,omitempty"`
	Items   []SavedSessionItem  `json:"items,omitempty"`
	Cursor  string              `json:"cursor,omitempty"`
	HasMore bool                `json:"has_more,omitempty"`
	Total   int64               `json:"total"`
}

// MarkSessionReadRequest 记下「这个账号此刻读到这条对话为止」。身份就是
// conversation_id 一个值（决策 1），账号取自鉴权上下文。
//
// 请求里**不带时刻**：客户端的钟不可信，而这个时刻要和服务端自己记的
// last_message_at 相比。服务端就地取当下。
type MarkSessionReadRequest struct {
	mux.Meta `path:"/v1/agent-sessions/read" method:"POST"`
	// uuid 这条校验挡的是「拿旧的整数会话号来寻址」：那种值在这里认不出任何一条
	// 对话，与其静默地标不到行，不如在边界上拒掉。
	ConversationID string `json:"conversation_id" binding:"required,uuid"`
}

// MarkSessionReadResponse 回这条对话现在的已读时刻，供客户端就地覆盖那一行。
type MarkSessionReadResponse struct {
	LastReadAt int64 `json:"last_read_at"`
}

// ---------- 转录：按游标翻页 ----------

// TranscriptRequest 翻一条对话镜像里的帧，两个方向。
//
// Direction 缺省（或 forward）是**正向**：Cursor 是调用方自己的位置（不含），
// 0 表示从头翻，Limit 不填走服务端默认档、超上限服务端夹住。这个方向是与实时流
// 按 seq 拼接的那一半，语义一字未动。
//
// Direction=backward 是**反向**：从最新往回取一页，Cursor 改作**排他上界**
// （0 = 从最新往回），Limit 不参与——这个方向一页有多大由服务端的预算说了算
// （规格 2026-08-21-transcript-tail-loading 决策 7）。详情页打开一条对话走的是
// 这个方向：要的是它最后那一段，不是从头翻。
type TranscriptRequest struct {
	mux.Meta `path:"/v1/agent-sessions/transcript" method:"GET"`
	// ConversationID 是这条对话的身份，与镜像库里帧的身份键同一个值。
	ConversationID string `form:"conversation_id" binding:"required,uuid"`
	Cursor         int64  `form:"cursor"`
	Limit          int    `form:"limit"`
	Direction      string `form:"direction" binding:"omitempty,oneof=forward backward"`
}

// TranscriptFrameItem 是 Web HTTP view 的一行。镜像库保存 typed Protobuf
// RpcNotification；workspace_svc 在读取边界把它投影成现有 method + params JSON，
// 让 Web 渲染层不承担内部 RPC carrier 的解码职责。
type TranscriptFrameItem struct {
	Seq    int64           `json:"seq"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	// Createtime 是这一帧**发生**的时刻（Unix 毫秒），由产生它的那一端报出。
	// 浏览器的转录是从帧现折的，每条消息头上那个 HH:mm 只有这一个来源——桌面端读的
	// 是自己库里的 chat_messages.createtime，这一侧没有那张表。
	//
	// 0 = 那一端没报过（还没升级的对端）。**没有 omitempty**：省掉之后「报了 0」与
	// 「这一版服务端还没有这个字段」在线上长得一模一样，而前端对这两件事该做的不是
	// 同一件。0 读作「不知道」，时间戳如实不显示，绝不就地补一个当下——补齐是成批
	// 到达的，那会把一条离线两天的对话整段盖上今天的时间。
	Createtime int64 `json:"createtime"`
}

// TranscriptResponse 是一页。Cursor 是这一页读到的位置，**不是**这条对话的
// 「最新」seq——它只代表这个 server 镜到哪（与 agent_sessions.latest_seq
// 同一个陷阱）：机器在线时浏览器还要从中继接实时，两者按 seq 拼在一起，不能拿这个
// 值当「到此为止都读完了」的信号。HasMore 为 true 时带着 Cursor 再翻一页；空页上
// Cursor 保持不变（不回退到 0），否则调用方会把整段日志重放一遍。
type TranscriptResponse struct {
	Frames []TranscriptFrameItem `json:"frames"`
	Cursor int64                 `json:"cursor"`
	// HasMore 只对正向有意义：还有更**新**的没翻完。
	HasMore bool `json:"has_more"`
	// OldestSeq 是这一页里**最老**那条的 seq，往上翻的下一次 cursor；HasBefore 说明
	// 还有没有更早的。两者只有反向读会填。
	//
	// 单开两列而不是按方向改写 cursor 的含义 —— cursor 在两个方向上同义（这一页
	// 最新那条的 seq），调用方拿它预置中继游标那条路因此不必分方向。
	//
	// 三个数一律按**原始日志行**算，与服务端的帧投影削掉了多少无关。
	OldestSeq int64 `json:"oldest_seq,omitempty"`
	HasBefore bool  `json:"has_before,omitempty"`
}

// AttentionCountRequest 是侧栏「对话」那颗角标的取数：账号里此刻需要你的对话条数。
//
// 没有任何参数。账号由本组的鉴权圈定 —— 收一个 user_id 就是把「数谁的对话」交给了
// 调用方，而这条端点每一次进入任何页面都会被调到。
type AttentionCountRequest struct {
	mux.Meta `path:"/v1/agent-sessions/attention-count" method:"GET"`
}

// AttentionCountResponse 回两个数。
//
// 两个而不是一个：角标只有一个数字位，但它底下是两件事——「有东西挡在那里等你按」
// 与「有东西你还没看过」。`title` 要把它们分开说（「N 条等你处理 · M 条未读」，
// 与桌面端状态栏那颗胶囊同构），在服务端合成一个数交出来的话那句话就拆不回来了。
//
// 判据与索引上那几个 chip 共用仓储的 attentionExpr：`unread` 与 `?filter=unread`
// 数的是同一批行，因此侧栏与 chip 上那两个数**不可能**对不上。
type AttentionCountResponse struct {
	// NeedsAttention / Unread 都**没有 omitempty**：侧栏那颗角标只在 > 0 时才画，
	// 所以 0 会让它整个不出现，那是对的；但字段必须在。省掉之后「没人等你」与
	// 「这次没问出来」在线上长得一模一样，而前端对这两件事该做的不是同一件。
	NeedsAttention int64 `json:"needs_attention"`
	Unread         int64 `json:"unread"`
}
