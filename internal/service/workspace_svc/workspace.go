// Package workspace_svc 编排 web 控制台两屏（总览页的账号级 Agent 清单、设备页
// 展开）需要的只读视图。
//
// R19 是这里唯一的红线：项目在各设备上的绝对路径、agent_backends 的 CLIPath 与
// EnvJSON 不出现在发往浏览器的任何响应里。落实方式不是「渲染时挑着不显示」，
// 而是这个包里解析 sync_objects.payload 用的几个结构体本来就没有能装下它们的
// 字段——json.Unmarshal 对无 tag 对应的键直接丢弃，这几类敏感字段因此在
// service 边界之前就已经出局，不依赖调用方守规矩。
package workspace_svc

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"github.com/oklog/ulid/v2"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// 执行目标的可用性分类，供两屏共用同一套文案键。
const (
	// AvailabilityAvailable 这一档所在的机器已配对且在线，是可以被派活的一档。
	AvailabilityAvailable = "available"
	// AvailabilityOffline 机器已配对但当前不在线。
	AvailabilityOffline = "offline"
	// AvailabilityUnpaired 这一档指向的指纹在账号下找不到对应的设备
	// （引用了一个尚未配对/已被撤销的 agentred，或它引用的 backend 行已消失）。
	AvailabilityUnpaired = "unpaired"
	// AvailabilityNoDevice 这一档指向的后端行没有写运行设备（agentred_fingerprint
	// 为空）。空指纹**不是**「本机」相对引用（规格 2026-08-21「同步与身份」推翻了
	// 那条读法）：它只可能是决策 14 的存量，如实标成「未指定设备」，派发跳过它并
	// 把这个理由如实写在这一档上——不猜一台机器补上。
	AvailabilityNoDevice = "no_device"
	// AvailabilityProjectPathMissing 这一档的机器已配对且在线，但没配所选项目
	// 的路径——那台机器跑不起这个项目（块 1 R15 的 BlockReasonExecTargetProjectPathMissing
	// 在浏览器语境下的对应物）。
	AvailabilityProjectPathMissing = "project_path_missing"
)

// ExecTargetView 是总览页 Agent 卡片里一条执行目标链上的一档。
type ExecTargetView struct {
	Rank int
	// BackendSyncID 是这一档跨机稳定且逐档唯一的标识，浏览器靠它表达排列：
	// Rank 是位置性的（重排后就变了），DeviceID 也不唯一（一台机器可挂多个 backend）。
	BackendSyncID    string
	IsLocalReference bool
	DeviceID         int64
	DeviceName       string
	BackendType      string
	Availability     string
	// Current 标记「按顺序取第一个可用的」会落到哪一档（没写运行设备的档不参与
	// 这个挑选：它没指到任何一台机器）。至多一档为 true。
	Current bool
}

// AgentView 是总览页「Agent」卡片的一行。
type AgentView struct {
	SyncID         string
	Name           string
	AvatarColor    string
	AvatarIcon     string
	DepartmentName string
	// ProjectSyncIDs 是这个 Agent **直接加入**的项目（同步组 kind=project_agent），
	// 按 sync_id 稳定排序。继承（子项目看得见父项目的成员）不在这一层算：项目树
	// 整份都发给浏览器了（ProjectNodeView 带 ParentSyncID），在服务端再算一遍等于
	// 把同一条规则实现两次，两处一旦分叉就没人说得清哪个对。
	ProjectSyncIDs     []string
	ExecTargets        []ExecTargetView
	HasAvailableTarget bool
}

// RunnableAgentView 是 agentred 展开的「能跑的 Agent」一项：这台机器在该 Agent
// 的执行目标链里排第几档。
type RunnableAgentView struct {
	SyncID string
	Name   string
	Rank   int
}

// ProjectView 是设备展开的「项目」一项：只回答「已配置」这个事实，不带路径。
type ProjectView struct {
	SyncID     string
	Name       string
	Configured bool
}

// ProjectNodeView 是账号项目树上的一个节点，供 web 会话索引的项目轴建组头。
// 只回「指向」：同步标识、名字、图标、颜色、父标识与排序，路径一概不带（R19）。
type ProjectNodeView struct {
	SyncID string
	Name   string
	// Icon 是项目自己选的图标，与同步载荷里的 icon 键一一对应；项目从没选过时
	// 如实留空，不补一个默认图标——前端落到名字首字母那条兜底。
	Icon  string
	Color string
	// Description 是项目简介，项目设置里可改。
	Description string
	// ParentSyncID 为空即根项目。
	ParentSyncID string
	SortOrder    int
	// Members 是这个项目的**直接成员**，各自带着自己那条成员关系的同步标识（删成员
	// 按它定位）。组头的 ＋ 只列这一份（决策 10）；父项目的成员在桌面端是只读继承，
	// 这一侧同样不把继承来的成员混进来——删不掉的东西不该长成能删的样子。
	Members []ProjectMemberView
	// Configured 为假即「账号里一台机器都没配这个项目的路径」，索引组头据此挂那枚
	// 可点的「未配置」角标（决策 9）。**判据必须在服务端**：浏览器手里只有项目树，
	// 它答不出「哪台机器上有这个项目的路径」。判据本体见 projectsWithARunnablePath
	// （agentred 看同步组 project_location，桌面端看上报组 device_local_paths，
	// 两类设备都算数）。
	// **路径正文一步都不往外带**：这里回的只是一个布尔。
	Configured bool
}

// ---------- 组织面的读侧（规格 2026-08-18「server 端的组织管理面」）----------
//
// 这四个视图是浏览器画组织索引与详情的全部材料。**它们一个都没有能装下 cli_path
// 或 env_json 的字段**——沿用 AgentView 那种结构性守法（规格：不是在序列化时过滤，
// 而是类型上就没有那个字段），守卫见 workspace_test.go 的
// TestOrgViews_HaveNoFieldThatCouldHoldAMachineLocalSecret。

// OrgDepartmentView 是组织索引上的一个组头。**空部门照常在场**：一个部门有没有
// Agent 与它在不在索引里无关，按「有 Agent 的部门」反推组头会让空部门整个消失。
type OrgDepartmentView struct {
	SyncID      string
	Name        string
	Description string
	Icon        string
	AccentColor string
	// ParentSyncID 为空即根部门；组头按它递归缩进。
	ParentSyncID string
	// LeadAgentSyncID 是组头上标的负责人，为空即这个部门还没有负责人。
	LeadAgentSyncID string
	SortOrder       int
}

// OrgAgentView 是索引的一行，同时是详情要编辑的那一份字段集合（规格「详情」：
// 与桌面端一致，没有新增也没有删除）。
type OrgAgentView struct {
	SyncID      string
	Name        string
	Description string
	AvatarColor string
	AvatarIcon  string
	// SystemBadge 非空即系统 Agent（唯一合法的「既不属于部门也没有上级」），
	// 索引把它单独置顶一行。web 上只读——写通道里没有这个键。
	SystemBadge string
	// DepartmentSyncID 与 ParentAgentSyncID 是归属的二选一，两个都如实带出：
	// 详情的归属下拉靠它们决定自己停在哪一组上。
	DepartmentSyncID  string
	ParentAgentSyncID string
	SortOrder         int
	// PromptJSON / ToolsJSON 是详情「行为」栏的两份 JSON 字符串，原样搬运。
	PromptJSON  string
	ToolsJSON   string
	ExecTargets []OrgExecTargetView
}

// OrgExecTargetView 是详情「执行」栏的一档（一档一行，技能折在行内）。
type OrgExecTargetView struct {
	// SyncID 是这一档自己的同步标识：改技能授权、删掉这一档都按它定位。
	SyncID string
	Rank   int
	// BackendSyncID 是这一档引用的后端，配一档时挑的就是它。
	BackendSyncID string
	BackendName   string
	BackendType   string
	// DeviceID / DeviceName 是这个后端所在的机器；未配对与未指定设备时为空。
	DeviceID   int64
	DeviceName string
	// DeviceFingerprint 是这一档所在那台机器的 agentred 指纹（sync_objects 的
	// agentred_fingerprint 列，见 sync_entity.SyncObject）。浏览器的中继是点对点
	// 的——`/v1/relay/client?daemon_fingerprint=…` 认的是指纹而不是 device_id——
	// 少了它就拨不到这一档的机器，也就问不出那个后端上装了哪些技能包。
	//
	// 没写运行设备的档与「后端已不在」的档留空：前者本来就没指到任何一台机器，后者
	// 根本不知道是哪台机器；两种都不编一个。离线**不**留空——离线只是此刻拨不通，
	// 指纹仍是那台机器的身份。
	//
	// 这不是一处新开的暴露面：同一个值已经随 `GET /v1/devices`
	// （device.ListDevicesItem.Fingerprint）与派发计划
	// （workspace.DispatchChoiceItem.DeviceFingerprint）下行给同一个浏览器会话了。
	DeviceFingerprint string
	IsLocalReference  bool
	// Availability 与总览页同一套取值：不可用的档留在列表里并给出原因，不隐藏。
	Availability string
	// Current 标记「按顺序取第一个可用的」会落到哪一档，至多一档为 true。
	Current bool
	// SkillsJSON 是这一档的技能授权（R15e），原样搬运。
	SkillsJSON string
}

// OrgBackendView 是「配一档执行目标时能挑哪个后端」清单里的一项。
//
// **这是本轮 R19 最吃紧的一处**：它是专门用来呈现后端的视图，而后端的同步载荷里
// 就摆着 cli_path 与 env_json。浏览器要能挑，却不该知道那台机器上的可执行文件在哪、
// 更不该知道用户往里塞了什么环境变量——因此这个类型只有「指向」与「在哪台机器上、
// 此刻能不能用」，没有任何一个字段能装下那两个键。
type OrgBackendView struct {
	SyncID      string
	Name        string
	BackendType string
	DeviceID    int64
	DeviceName  string
	// IsLocalReference 为真即这个后端行没写运行设备（agentred 指纹为空，决策 14 的
	// 存量）：如实标出而不是从清单里抹掉，也不猜一台机器补上。字段名是旧的——
	// 浏览器契约（`is_local_reference`）不在本轮的改动范围里，含义以这段注释为准。
	IsLocalReference bool
	Availability     string
}

// OrgChartView 是组织面一次读到的全部材料：部门（含空部门）与 Agent（含每档执行
// 目标）。索引与详情画的是同一份数据，因此一次取回，不必为选中哪一行再问一次。
type OrgChartView struct {
	Departments []OrgDepartmentView
	Agents      []OrgAgentView
}

// SavedSessionSummaryView 是 web 统一会话索引一行的数据源：账号里已保存的一条
// 对话，机器在线与否都在（内容来自镜像，不再逐台机器经中继解析）。ProjectSyncID
// 由服务端就地判定（决策 12）——镜像的 cwd 与账号项目树上的路径比对，配不上时留
// 空（未归项目），cwd 本身永不下行（R19）。
type SavedSessionSummaryView struct {
	// PeerFingerprint 是发起这条对话那一端的设备指纹（决策 17 的身份键的一半），
	// 不是此刻承载它的那台机器；详情页发消息要用它定位承载连接的目标。
	PeerFingerprint string
	// MachineFingerprint 是承载这条对话、详情页实际要连接的账号设备；它与发起端
	// 可以不同（浏览器派发到 agentred 时就是不同值）。
	MachineFingerprint string
	// SessionID 是发起端本地自增的会话标识，服务端只当不透明指针；配
	// PeerFingerprint 才是完整身份。
	SessionID string
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
	UserID          int64
	PeerFingerprint string
	SessionID       string
	AfterSeq        int64
	Limit           int
	// Backward 为 true 时改成**从最新往回**按预算取一页（详情页打开一条对话时要的
	// 是它最后那一段，规格 2026-08-21-transcript-tail-loading 决策 7）。此时
	// AfterSeq 与 Limit 都不参与：这个方向的一页有多大由预算说了算。
	Backward bool
	// BeforeSeq 是反向读的**排他上界**，0 表示从最新往回。它与 AfterSeq 分开而不是
	// 复用同一个字段：一个字段在两个方向上表示两件事，是本仓注释反复防的形态。
	BeforeSeq int64
}

// TranscriptFrameView 是给 Web HTTP API 的 JSON 投影视图。持久化层保存 typed
// Protobuf RpcNotification，读取边界才将它转换为 method + params。
type TranscriptFrameView struct {
	Seq    int64
	Method string
	Params json.RawMessage
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

// DeviceDetailView 是设备页展开一行时取到的详情。RunnableAgents 只在
// Kind==agentred 时有值——Agent 不按桌面端归属（决策 13）。
type DeviceDetailView struct {
	DeviceID       int64
	Kind           string
	RunnableAgents []RunnableAgentView
	Projects       []ProjectView
}

// WebDispatchTier 是 R15 派发计划里执行目标链上的一档：从 web 给「某 Agent +
// 某项目」派活时，这一档为什么能用 / 不能用。Availability 取值见常量。
// Kind 是这一档指向的设备种类（device_entity.KindDesktop / KindAgentred）——R17
// 发起前要按它如实说明 org/subagent/hook 在目标上是否可用。
type WebDispatchTier struct {
	Rank int
	// BackendSyncID 是这一档跨机稳定且逐档唯一的标识，浏览器靠它表达排列
	// （见 ExecTargetView.BackendSyncID）。
	BackendSyncID string
	DeviceID      int64
	DeviceName    string
	BackendType   string
	Kind          string
	Availability  string
	// Current 标记按顺序取第一个可用的会落到这一档。至多一档为 true。
	Current bool
}

// WebDispatchChoice 是 R15 派发最终落到的那一档（第一档可用的 agentred）。
// Cwd 是所选项目在那台机器上的绝对路径：屏幕 25 要呈现「将运行在 <机器> · <路径>」，
// 派发 runtime.run 也要拿它当 RunParams.cwd。
//
// R19（块 1 红线）说路径不出现在发往浏览器的任何响应里，那是针对总览 / 设备两屏
// 的**被动读视图**；这里是一次**用户主动发起的派活**，路径是该动作本身的执行参数，
// 没有它浏览器无法在远端把这条项目会话跑起来——按设计稿屏 25 的呈现，这条是 R19
// 的唯一例外，且只在 project_sync_id 非空（确认派发阶段）时才带出。
type WebDispatchChoice struct {
	DeviceFingerprint string
	DeviceID          int64
	DeviceName        string
	BackendType       string
	// Kind 是选中目标设备种类（device_entity.KindDesktop / KindAgentred），R17
	// 发起前据此说明三个内置工具是否可用。
	Kind string
	Cwd  string
}

// WebDispatchPlan 是「从 web 给某 Agent + 某项目派活」的完整计划：有序逐档说明 +
// 落到哪一档。Chosen 为 nil 表示全部档都不可用——调用方据此逐档渲染原因，不静默失败。
type WebDispatchPlan struct {
	AgentSyncID string
	Tiers       []WebDispatchTier
	Chosen      *WebDispatchChoice
	// Projects 是选中的那一档机器上已配置的项目（picker 阶段挑项目用）。
	Projects []ProjectView
}

// WebDispatchPlanInput 是「取派发计划」的入参。写成结构体而不是并排三个 string：
// agent / project / target_backend 三个同步标识挨在一起，位置传参一旦写颠倒，
// 编译器一句话都不会说，跑起来却会派到另一台机器上。
type WebDispatchPlanInput struct {
	UserID      int64
	AgentSyncID string
	// ProjectSyncID 可空：不挑项目就是一条不钉项目的自由会话（桌面端
	// resolvePeerProjectID 对空 cwd 返回 projectID = 0），此时不做项目路径判定。
	ProjectSyncID string
	// TargetBackendSyncID 非空 = 用户在「在哪台机器上跑」里挑了具体一档（桌面端
	// 那枚 chip 的「只影响这一次」）。Chosen 按这一档算，而不是取第一个可用的。
	// 挑中的档跑不了时 Chosen 留空——**不回落**到自动挑的那一档：用户挑的是这台
	// 机器，悄悄换一台去跑，上下文与文件全在另一台上。
	TargetBackendSyncID string
}

// SessionReadSvc 是「对话」页读侧需要的那一小片（ISP）：索引、转录、已读标记。
//
// 它从 WorkspaceSvc 里摘出来，是因为 agent_session_ctr 只用这三个方法，却因为共用一个
// 15 方法的接口，连测试替身都得把另外 12 个全实现一遍（各写一句 panic）。
// 具体实现仍是同一个 workspaceSvc——拆的是调用方看见的面，不是实现。
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
	MarkSessionRead(
		ctx context.Context, userID int64, peerFingerprint, sessionID string,
	) (int64, error)
	// WaitingCount 是侧栏「对话」那颗角标要的那个数：账号里此刻**等你处理**的对话
	// 条数。判据与索引上那个 chip 是同一个（LifecycleWaiting）——侧栏说有 3 条等你、
	// 点进去筛选却是 2 条，是一种没有任何地方会报错而用户一眼就看得见的错。
	//
	// 只回一个数字：这条路在每一次进入任何页面时都会跑一遍，而一页摘要里的标题、
	// 游标、项目归属一个都用不上。0 是答案不是失败——那时角标整个不画。
	WaitingCount(ctx context.Context, userID int64) (int64, error)
}

type WorkspaceSvc interface {
	// ListAccountAgents 是总览页「我有哪些 Agent」的唯一数据源：账号下每个 Agent
	// 一行，逐档给出有序执行目标链与当前生效的那一档。顺序就是同步组里的
	// sort_order —— 浏览器排的也是它，没有「这个浏览器自己那一份」（决策 14）。
	ListAccountAgents(ctx context.Context, userID int64) ([]AgentView, error)
	// WebDispatchPlan 是 R15 的派发计划：给定 Agent 与项目（可空），按序解析执行
	// 目标链，跳过 device_id 为空的档（R15d），返回每档原因与选中的第一档可用
	// agentred。全部不可用时 Chosen 为空，逐档原因由调用方渲染。
	// 入参带 TargetBackendSyncID 时改按那一档算 Chosen（见 WebDispatchPlanInput）。
	WebDispatchPlan(ctx context.Context, in WebDispatchPlanInput) (*WebDispatchPlan, error)
	// SetExecTargetOrder 把某个 Agent 的执行目标排成这个次序，改的是账号默认顺序。
	// 写入范围由 UserID 圈定，它取自鉴权上下文而不是请求体。
	SetExecTargetOrder(ctx context.Context, in SetExecTargetOrderInput) error
	// DeviceDetail 是设备行展开时取的详情，deviceID 必须属于 userID 且未被撤销，
	// 否则返回 NotFound——不区分「不存在」与「不属于你」，避免枚举探测。
	DeviceDetail(ctx context.Context, userID, deviceID int64) (*DeviceDetailView, error)
	// AccountProjects 是 web 会话索引项目轴的组头材料：账号下每个存活项目一个节点，
	// 按 sort_order 排好。它与会话无关，因此可以取一次用很久。
	AccountProjects(ctx context.Context, userID int64) ([]ProjectNodeView, error)
	// OrgChart 是组织面索引与详情的唯一数据源：账号下的部门（**含一个 Agent 都
	// 没有的空部门**）与 Agent（含完整组织字段与每档执行目标）。范围只由 userID
	// 圈定，它取自鉴权上下文——别的账号的组织架构在这里一行都读不到。
	OrgChart(ctx context.Context, userID int64) (*OrgChartView, error)
	// SelectableBackends 是「配一档执行目标时能挑哪个后端」的清单：账号下存活的
	// 后端，各自带所在机器与可用性。浏览器只能**引用**已有后端，建不出新的，
	// 也读不到它的 cli_path / env_json（规格「后端是机器的」）。
	SelectableBackends(ctx context.Context, userID int64) ([]OrgBackendView, error)
	// CreateOrgObject / UpdateOrgObject / DeleteOrgObject 是浏览器发起的组织面
	// 写入（规格 2026-08-18「server 端的组织管理面」）：server 直写 sync_objects，
	// 沿用与设备上行完全一样的账号级语义，不需要桌面端在线。三者的写入范围都只由
	// in.UserID 圈定，它取自鉴权上下文而不是请求体。
	CreateOrgObject(ctx context.Context, in OrgWriteInput) (*OrgWriteResult, error)
	// UpdateOrgObject 只覆盖 in.Fields 里明确涉及的键，载荷里其余的原值保留。
	UpdateOrgObject(ctx context.Context, in OrgWriteInput) (*OrgWriteResult, error)
	// DeleteOrgObject 落墓碑而不是物理删除。
	DeleteOrgObject(ctx context.Context, in OrgWriteInput) (*OrgWriteResult, error)
	// ProjectMachines 是项目设置「机器与路径」那一节的全部材料（规格 2026-08-20）：
	// 账号里每台机器一行。**agentred 逐条带出路径正文**——这是 R19 本轮唯一收窄的
	// 一处，理由是用户要改的就是它，而改不了一个看不见的值；**桌面端只回「已配置」
	// 这个布尔**，它的本机路径住在上报组，从 web 写不进去（决策 4）。
	ProjectMachines(ctx context.Context, userID int64, projectSyncID string) ([]ProjectMachineView, error)
	// SetProjectLocation 给某台 agentred 上的某个项目配路径：按账号内自然键
	// （项目同步标识, 指纹）先找存活的那一行，有就改、没有就建，因此同一台机器上
	// 同一个项目永远只有一行。桌面端的指纹一律拒（决策 4）。
	SetProjectLocation(ctx context.Context, in SetProjectLocationInput) (*OrgWriteResult, error)
}

// SetExecTargetOrderInput 是一次「把某个 Agent 的执行目标排成这个次序」。
// UserID 来自调用方鉴权上下文，不由调用方填，跨账号因此写不进去。
type SetExecTargetOrderInput struct {
	UserID      int64
	AgentSyncID string
	// BackendSyncIDs 是排列本身。不校验它与当前执行目标集合是否一致：排列是收敛的
	// 偏好，写入时以集合为准（指向已删 backend 的项忽略、未覆盖的档补到尾部）。
	BackendSyncIDs []string
}

// DaemonOnlineChecker 是这个包需要的窄接口（ISP）：只问「这个指纹的 daemon 现在
// 在线吗」，不需要 relay_svc.RelaySvc 那一整套连接/转发方法。bootstrap 用
// relay_svc.Default() 结构性满足它。
type DaemonOnlineChecker interface {
	IsDaemonOnline(ctx context.Context, accountID int64, fingerprint string) (bool, error)
}

// noopOnlineChecker 是 SetOnlineChecker 之前的安全占位：未装配时（例如未跑完整
// bootstrap 的调用方）一律按离线处理，而不是对 nil 接口 panic——与
// device_svc.noopLocalPathPurger 同一模式。
type noopOnlineChecker struct{}

func (noopOnlineChecker) IsDaemonOnline(context.Context, int64, string) (bool, error) {
	return false, nil
}

var onlineChecker DaemonOnlineChecker = noopOnlineChecker{}

// SetOnlineChecker 由 bootstrap 注入真实的 relay_svc；传 nil 时恢复成安全占位。
func SetOnlineChecker(c DaemonOnlineChecker) {
	if c == nil {
		onlineChecker = noopOnlineChecker{}
		return
	}
	onlineChecker = c
}

type workspaceSvc struct{}

// New 构造一个无状态的 WorkspaceSvc；每次调用都直接读 sync_repo / device_repo
// 的当前状态，不持有任何缓存。
func New() *workspaceSvc { return &workspaceSvc{} }

// 两个默认值指向同一个实现；分开存是为了让两族调用方能各自换掉自己那一片，
// 而不必给对方那一片也造一个替身。
var (
	defaultSvc         WorkspaceSvc   = New()
	defaultSessionRead SessionReadSvc = New()
)

func Default() WorkspaceSvc     { return defaultSvc }
func SetDefault(s WorkspaceSvc) { defaultSvc = s }

func SessionRead() SessionReadSvc     { return defaultSessionRead }
func SetSessionRead(s SessionReadSvc) { defaultSessionRead = s }

// ---------- 载荷解析：只列 web 端要展示的安全字段 ----------

// agentPayload 是 Agent 载荷里 web 端要展示的键：组织面详情编辑的那一份字段集合
// （规格「详情」：与桌面端一致，没有新增也没有删除）。同步载荷里另有两个键刻意不在
// 其中：avatar_hash（头像正文只有设备 JWT 那条路径取得到，解出一个浏览器无从兑现的
// 哈希没有意义）与 pinned（写通道里也没有这个键，web 组织面不管它）。
type agentPayload struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	AvatarColor string `json:"avatar_color"`
	AvatarIcon  string `json:"avatar_icon"`
	// SystemBadge 标出系统 Agent（唯一合法的「既不属于部门也没有上级」），索引据此
	// 把它单独置顶一行。它由桌面端定义，web 上只读。
	SystemBadge string `json:"system_badge"`
	// DepartmentSyncID 与 ParentAgentSyncID 是归属的二选一：详情的归属下拉靠这两个
	// 键决定自己停在哪一组上，因此两个都要如实带出，不能只带推导后的结果。
	DepartmentSyncID  string `json:"department_sync_id"`
	ParentAgentSyncID string `json:"parent_agent_sync_id"`
	SortOrder         int    `json:"sort_order"`
	// PromptJSON / ToolsJSON 是桌面端定义的两份 JSON 字符串（详情的「行为」栏），
	// 这一侧只搬运不解析——解析它就等于在两个仓库里各维护一份同一个结构。
	PromptJSON string `json:"prompt_json"`
	ToolsJSON  string `json:"tools_json"`
}

type departmentPayload struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	AccentColor string `json:"accent_color"`
	// ParentSyncID 为空即根部门；索引的组头按它递归缩进。
	ParentSyncID string `json:"parent_sync_id"`
	// LeadAgentSyncID 是组头上的负责人。
	LeadAgentSyncID string `json:"lead_agent_sync_id"`
	SortOrder       int    `json:"sort_order"`
}

// agentBackendPayload 是这个包认识的**全部**后端键：类型与名字。
//
// **这里没有、也不会有 CLIPath 与 EnvJSON。** 同步载荷里它们就摆在旁边（agentre 侧
// adapter_org.go），而 json.Unmarshal 对没有 tag 对应的键直接丢弃——它们因此在
// service 边界之前就已经出局，不靠下游记得别填。浏览器要能**挑**一个后端，这两个
// 键却是那台机器的私事：给它加一个字段，就是给这条红线开一个口子。
type agentBackendPayload struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

type agentExecTargetPayload struct {
	AgentSyncID   string `json:"agent_sync_id"`
	BackendSyncID string `json:"backend_sync_id"`
	SortOrder     int    `json:"sort_order"`
}

// execTargetSkillsPayload 单独解技能授权（R15e，详情里折在这一档行内），**不并进
// 上面那个结构体**：排序那条路径（orderExecTargets）不关心技能，而 json.Unmarshal
// 一旦在某个键上撞到类型不符就整个失败——把技能并进去，一档技能授权写成了别的形状
// 就会让这一档从排序里整个消失。解不动时如实留空，其余字段照常。
type execTargetSkillsPayload struct {
	SkillsJSON string `json:"skills_json"`
}

// projectPayload 只声明 web 端要用的键。同步载荷实际还带 description（agentre 侧
// adapter_project.go），这里不声明就解不进来——包注释那条「装不下就泄不出去」的
// 做法在这里同样成立，路径更是从来就不在这个载荷里。icon 是例外：web 的项目轴要
// 画和桌面端同一个图标，因此下面显式声明了它。
type projectPayload struct {
	Name string `json:"name"`
	// Description 是项目简介。项目设置要能改它，就得先读得到它——此前这个键在服务端
	// 整条链上都不存在（声明不出来就解不进来），落到浏览器手里永远是空的。
	Description string `json:"description"`
	// Icon 照抄同步载荷自己的拼法（agentre 侧 adapter_project.go 的
	// projectPayload.Icon `json:"icon"`），不改名、不归一化。
	Icon  string `json:"icon"`
	Color string `json:"color"`
	// ParentSyncID 为空即根项目；项目轴靠它把项目递归成树。
	ParentSyncID string `json:"parent_sync_id"`
	SortOrder    int    `json:"sort_order"`
}

// projectLocationPayload 只带路径正文（agentre 侧 adapter_project.go 的镜像）：
// 路径在同步组里以 kind=project_location、agentred_fingerprint 等于目标机器指纹
// 的行存放。
type projectLocationPayload struct {
	Path string `json:"path"`
}

// resolvedTarget 是「Agent → 执行目标 → backend」这条链解析到指纹这一层的中间
// 结果，ListAccountAgents 与 DeviceDetail 共用同一份解析，避免各写一遍
// JSON 解析与分组逻辑（DRY）。
type resolvedTarget struct {
	// SyncID 是这一档自己的同步标识：组织面按它改技能授权、按它删掉这一档
	// （BackendSyncID 指的是它引用的后端，不是它自己）。
	SyncID string
	Rank   int
	// BackendSyncID 是这一档指向的 backend 同步标识：跨机稳定、逐档唯一，是排列
	// 唯一能用的锚点，一路带到对外的档结构上。
	BackendSyncID string
	BackendName   string
	BackendType   string
	// SkillsJSON 是这一档的技能授权，详情里折在这一行内。
	SkillsJSON string
	// Fingerprint 为空有两种来路，靠 IsLocalReference 区分：backend 行还在但没写
	// 运行设备（IsLocalReference 为真），或者 backend 行根本不在了（为假）。
	Fingerprint      string
	IsLocalReference bool
}

type agentChain struct {
	SyncID            string
	Name              string
	Description       string
	AvatarColor       string
	AvatarIcon        string
	SystemBadge       string
	DepartmentSyncID  string
	ParentAgentSyncID string
	SortOrder         int
	PromptJSON        string
	ToolsJSON         string
	Targets           []resolvedTarget
}

// buildAgentChains 从一批 sync_objects 行里挑出 kind=agent/agent_backend/
// agent_exec_target 的行，解析并按 sort_order 分组、排序。调用方按需再解析
// department，或再解析设备信息——这个函数只负责「Agent 有序执行目标链」这一层，
// 不关心 department 是谁、指纹对应哪台设备（SRP）。
func buildAgentChains(rows []*sync_entity.SyncObject) []agentChain {
	var agents []*sync_entity.SyncObject
	backendType := map[string]string{}
	backendName := map[string]string{}
	backendFingerprint := map[string]string{}
	type targetEntry struct {
		syncID      string
		agentSyncID string
		sortOrder   int
		backendID   string
		skillsJSON  string
	}
	var targetEntries []targetEntry

	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindAgent:
			agents = append(agents, row)
		case sync_entity.KindAgentBackend:
			var bp agentBackendPayload
			if err := json.Unmarshal([]byte(row.Payload), &bp); err != nil {
				continue
			}
			backendType[row.SyncID] = bp.Type
			backendName[row.SyncID] = bp.Name
			backendFingerprint[row.SyncID] = row.AgentredFingerprint
		case sync_entity.KindAgentExecTarget:
			var tp agentExecTargetPayload
			if err := json.Unmarshal([]byte(row.Payload), &tp); err != nil {
				continue
			}
			var sp execTargetSkillsPayload
			// 解不动就是空技能，不影响这一档本身（见 execTargetSkillsPayload）。
			_ = json.Unmarshal([]byte(row.Payload), &sp)
			targetEntries = append(targetEntries, targetEntry{
				syncID: row.SyncID, agentSyncID: tp.AgentSyncID, sortOrder: tp.SortOrder,
				backendID: tp.BackendSyncID, skillsJSON: sp.SkillsJSON,
			})
		}
	}

	targetsByAgent := map[string][]targetEntry{}
	for _, te := range targetEntries {
		targetsByAgent[te.agentSyncID] = append(targetsByAgent[te.agentSyncID], te)
	}
	for agentSyncID := range targetsByAgent {
		list := targetsByAgent[agentSyncID]
		sort.SliceStable(list, func(i, j int) bool { return list[i].sortOrder < list[j].sortOrder })
		targetsByAgent[agentSyncID] = list
	}

	out := make([]agentChain, 0, len(agents))
	for _, a := range agents {
		var ap agentPayload
		if err := json.Unmarshal([]byte(a.Payload), &ap); err != nil {
			continue
		}
		chain := agentChain{
			SyncID: a.SyncID, Name: ap.Name, Description: ap.Description,
			AvatarColor: ap.AvatarColor, AvatarIcon: ap.AvatarIcon, SystemBadge: ap.SystemBadge,
			DepartmentSyncID: ap.DepartmentSyncID, ParentAgentSyncID: ap.ParentAgentSyncID,
			SortOrder: ap.SortOrder, PromptJSON: ap.PromptJSON, ToolsJSON: ap.ToolsJSON,
		}
		for i, te := range targetsByAgent[a.SyncID] {
			fp, known := backendFingerprint[te.backendID]
			rt := resolvedTarget{
				SyncID: te.syncID, Rank: i + 1, BackendSyncID: te.backendID,
				BackendName: backendName[te.backendID], BackendType: backendType[te.backendID],
				SkillsJSON: te.skillsJSON,
			}
			// backend 行不存在（已删除/尚未同步到）时 known 为假：既不是「没写设备的后端」，
			// 也不指向任何已知指纹，rt 上那几个字段保持零值，调用方把它当「未配对」处理。
			if known {
				if fp == "" {
					rt.IsLocalReference = true
				} else {
					rt.Fingerprint = fp
				}
			}
			chain.Targets = append(chain.Targets, rt)
		}
		out = append(out, chain)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func deviceFingerprintMap(devices []*device_entity.Device) map[string]*device_entity.Device {
	out := make(map[string]*device_entity.Device, len(devices))
	for _, d := range devices {
		out[d.Fingerprint] = d
	}
	return out
}

// machinePlacement 是「这一档（或这个后端）落在哪台机器上、此刻能不能用」的答案。
type machinePlacement struct {
	DeviceID     int64
	DeviceName   string
	Availability string
}

// targetPlacer 按指纹判定机器与可用性，并把在线查询缓存起来。总览页的执行目标链、
// 组织面的执行目标行与「能挑哪些后端」是同一条判定阶梯——各写一遍就是各自漂开一次
// 的机会，而三处给同一台机器不同的状态，用户只会认为控制台在胡说。
type targetPlacer struct {
	ctx        context.Context
	userID     int64
	deviceByFP map[string]*device_entity.Device
	online     map[string]bool
}

func newTargetPlacer(ctx context.Context, userID int64, devices []*device_entity.Device) *targetPlacer {
	return &targetPlacer{
		ctx: ctx, userID: userID,
		deviceByFP: deviceFingerprintMap(devices), online: map[string]bool{},
	}
}

func (p *targetPlacer) isOnline(fingerprint string) bool {
	if v, ok := p.online[fingerprint]; ok {
		return v
	}
	v, err := onlineChecker.IsDaemonOnline(p.ctx, p.userID, fingerprint)
	if err != nil {
		v = false
	}
	p.online[fingerprint] = v
	return v
}

// place 判一档，判据只有指纹（规格 2026-08-21「同步与身份」）：后端行没写运行设备
// 就是「未指定设备」；指纹在账号下找不到对应设备就是未配对（机器已撤销 / 尚未配对）；
// 其余按设备状态与在线态分可用与离线。
//
// deviceUnspecified 与「指纹为空」不是同一件事：backend 行不在了的档指纹同样为空，
// 但那是「不知道是哪台机器」，按未配对处理。
func (p *targetPlacer) place(fingerprint string, deviceUnspecified bool) machinePlacement {
	if deviceUnspecified {
		return machinePlacement{Availability: AvailabilityNoDevice}
	}
	if fingerprint == "" {
		return machinePlacement{Availability: AvailabilityUnpaired}
	}
	dev, ok := p.deviceByFP[fingerprint]
	if !ok {
		return machinePlacement{Availability: AvailabilityUnpaired}
	}
	out := machinePlacement{
		DeviceID: dev.ID, DeviceName: dev.Name, Availability: AvailabilityOffline,
	}
	if dev.IsActive() && p.isOnline(fingerprint) {
		out.Availability = AvailabilityAvailable
	}
	return out
}

func (s *workspaceSvc) ListAccountAgents(ctx context.Context, userID int64) ([]AgentView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{
		sync_entity.KindAgent, sync_entity.KindAgentBackend,
		sync_entity.KindAgentExecTarget, sync_entity.KindDepartment,
		sync_entity.KindProjectAgent,
	})
	if err != nil {
		return nil, err
	}
	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	deptName := map[string]string{}
	// 「Agent → 它直接加入的项目」。已删除的成员关系不算数：退出项目之后它不该
	// 还留在清单里。
	projectsByAgent := map[string][]string{}
	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindDepartment:
			var dp departmentPayload
			if err := json.Unmarshal([]byte(row.Payload), &dp); err == nil {
				deptName[row.SyncID] = dp.Name
			}
		case sync_entity.KindProjectAgent:
			if row.IsDeleted() {
				continue
			}
			var pa projectAgentPayload
			if err := json.Unmarshal([]byte(row.Payload), &pa); err != nil {
				continue
			}
			if pa.AgentSyncID == "" || pa.ProjectSyncID == "" {
				continue
			}
			projectsByAgent[pa.AgentSyncID] = append(projectsByAgent[pa.AgentSyncID], pa.ProjectSyncID)
		}
	}
	// 排序在这里做一次，出参因此与同步组的返回顺序无关（那个顺序没有承诺）。
	for id := range projectsByAgent {
		sort.Strings(projectsByAgent[id])
	}

	placer := newTargetPlacer(ctx, userID, devices)
	chains := buildAgentChains(rows)
	out := make([]AgentView, 0, len(chains))
	for _, chain := range chains {
		view := AgentView{
			SyncID: chain.SyncID, Name: chain.Name,
			AvatarColor: chain.AvatarColor, AvatarIcon: chain.AvatarIcon,
			DepartmentName: deptName[chain.DepartmentSyncID],
			ProjectSyncIDs: projectsByAgent[chain.SyncID],
		}
		currentAssigned := false
		for _, t := range chain.Targets {
			placed := placer.place(t.Fingerprint, t.IsLocalReference)
			et := ExecTargetView{
				Rank: t.Rank, BackendSyncID: t.BackendSyncID,
				BackendType: t.BackendType, IsLocalReference: t.IsLocalReference,
				DeviceID: placed.DeviceID, DeviceName: placed.DeviceName,
				Availability: placed.Availability,
			}
			if !currentAssigned && et.Availability == AvailabilityAvailable {
				et.Current = true
				currentAssigned = true
			}
			view.ExecTargets = append(view.ExecTargets, et)
		}
		view.HasAvailableTarget = currentAssigned
		out = append(out, view)
	}
	return out, nil
}

// SetExecTargetOrder 把某个 Agent 的执行目标排成这个次序。
//
// **浏览器排的就是账号默认顺序**（决策 14）：没有「这个浏览器自己那一份」，改的是
// 同步组里各 agent_exec_target 行的 sort_order。因此一次重排会改变所有**从未调整过**
// 的桌面端看到的顺序 —— 那是账号默认的定义，不是副作用；已经拖过一次的桌面端有本端
// 覆盖，不受影响。
//
// 写入范围只由 UserID 圈定，它取自鉴权上下文而不是请求体，跨账号因此写不进去。
func (s *workspaceSvc) SetExecTargetOrder(ctx context.Context, in SetExecTargetOrderInput) error {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, in.UserID,
		[]string{sync_entity.KindAgentExecTarget})
	if err != nil {
		return err
	}
	ordered := orderExecTargets(rows, in.AgentSyncID, in.BackendSyncIDs)
	now := time.Now().UnixMilli()
	written := 0
	var lastVersion int64
	for i, row := range ordered {
		payload, changed, err := withSortOrder(row.Payload, i)
		if err != nil {
			return err
		}
		// 位置没变的行不写。每一次 Save 都要烧掉一个版本号并向每台桌面端下推一次，
		// 为没变的行付这个代价是纯浪费，还会让下行增量里全是空转。
		if !changed {
			continue
		}
		version, err := sync_repo.SyncState().NextVersion(ctx, in.UserID, 1)
		if err != nil {
			return err
		}
		row.Payload = payload
		row.Version = version
		// 重排也是一次服务端直写：来源记空串（决策 21，表示不是任何一台机器推上来的）。
		// 留着上一台推它的机器指纹，冲突应答里的 OverwrittenOriginFingerprint 会指着
		// 那台无辜的机器。
		row.OriginFingerprint = ServerOriginFingerprint
		row.SyncUpdatedAt = now
		row.Updatetime = now
		if err := sync_repo.SyncObject().Save(ctx, row); err != nil {
			return err
		}
		written++
		lastVersion = version
	}
	logger.Ctx(ctx).Info("workspace_svc.SetExecTargetOrder: account exec target order updated",
		zap.Int64("userId", in.UserID), zap.String("agentSyncId", in.AgentSyncID),
		zap.Int("orderedCount", len(ordered)), zap.Int("writtenCount", written))
	// 拖拽重排也是「服务端直写（web 组织面）」的一次写入：没有它，浏览器排完序，
	// 另一台桌面端仍要等 30 秒轮询（规格「谁发信号」）。
	accountchan_svc.BroadcastBestEffort(ctx, in.UserID, lastVersion)
	return nil
}

// orderExecTargets 把某个 Agent 的执行目标行排成调用方要的次序。
//
// 排列是**收敛的**而不是权威的：指向已经不存在的 backend 的项忽略（提交的那一刻
// 别处可能刚删掉一档），集合里有、排列里没有的档按原 sort_order 补到队尾。
//
// **载荷里读不出 backend_sync_id 的行钉在原位。** 排列以 sync_id 表达，这样一档
// 无从指代自己，也就没有参与排序的资格。浏览器侧同样把它钉住（execOrder.ts 的
// reorderTargets 只在可移动的档之间换位、并把空 sync_id 滤出提交载荷），把它冲到
// 队尾会让提交后的重新拉取里它凭空跳位置 —— 两端对同一次操作给出不同结果。
// 注意这和「未覆盖补到队尾」不冲突：那条针对的是**能被指代却没被排到**的档。
func orderExecTargets(
	rows []*sync_entity.SyncObject, agentSyncID string, permutation []string,
) []*sync_entity.SyncObject {
	type row struct {
		obj           *sync_entity.SyncObject
		backendSyncID string
		sortOrder     int
	}
	var mine []*row
	for _, obj := range rows {
		var tp agentExecTargetPayload
		if json.Unmarshal([]byte(obj.Payload), &tp) != nil || tp.AgentSyncID != agentSyncID {
			continue
		}
		mine = append(mine, &row{obj: obj, backendSyncID: tp.BackendSyncID, sortOrder: tp.SortOrder})
	}
	sort.SliceStable(mine, func(i, j int) bool { return mine[i].sortOrder < mine[j].sortOrder })

	byBackend := make(map[string]*row, len(mine))
	slots := make([]int, 0, len(mine)) // 可排的档占据的下标
	for i, r := range mine {
		if r.backendSyncID == "" {
			continue
		}
		if _, dup := byBackend[r.backendSyncID]; !dup {
			byBackend[r.backendSyncID] = r
		}
		slots = append(slots, i)
	}

	taken := map[*row]bool{}
	ordered := make([]*row, 0, len(slots))
	for _, backendSyncID := range permutation {
		r := byBackend[backendSyncID]
		if r == nil || taken[r] {
			continue
		}
		taken[r] = true
		ordered = append(ordered, r)
	}
	for _, r := range mine {
		if r.backendSyncID != "" && !taken[r] {
			ordered = append(ordered, r)
		}
	}

	// 把重排后的档按原有的可排位置回填，钉住的档留在自己的下标上。
	out := make([]*sync_entity.SyncObject, len(mine))
	for i, r := range mine {
		if r.backendSyncID == "" {
			out[i] = r.obj
		}
	}
	for n, i := range slots {
		out[i] = ordered[n].obj
	}
	return out
}

// withSortOrder 就地改载荷里的 sort_order，返回新载荷与「到底变了没有」。
//
// **必须走 map 而不是 agentExecTargetPayload。** sync_objects 是整行
// last-write-wins（前置规格决策 4 把字段级合并列为非目标），而那个结构体只声明了
// 读路径用得上的三个键 —— 解进去再 marshal 回来会把 skills_json（R15e 的按档技能
// 授权）静默抹掉。map 把没声明的键原样带过去。
func withSortOrder(payload string, sortOrder int) (string, bool, error) {
	var m map[string]any
	if err := json.Unmarshal([]byte(payload), &m); err != nil {
		return "", false, err
	}
	if cur, ok := m["sort_order"].(float64); ok && int(cur) == sortOrder {
		return payload, false, nil
	}
	m["sort_order"] = sortOrder
	next, err := json.Marshal(m)
	if err != nil {
		return "", false, err
	}
	return string(next), true, nil
}

// configuredProjects 回答「这台机器上哪些项目配了路径」。两类设备的路径存在不同的
// 地方，因为它们的流动性不同：
//
//   - agentred 的路径在**同步组**里（决策 7：它跟着账号在桌面端之间流动），是
//     kind=project_location、agentred_fingerprint 等于这台机器指纹的那些行。
//   - 桌面端的本机路径**不流动**（决策 6），只存在于上报组 device_local_paths，
//     按上报设备分命名空间。
//
// 两者不能混用：上报组只有桌面端会写（sync_svc.ReportLocalPaths 以上报设备为键），
// agentred 从不上报，照它取到的清单不是「少几行」而是恒为空——决策 13 要求的
// agentred 展开会永远空着。
//
// 返回值只有「这个项目同步标识配过路径」这个布尔，路径正文一步都不往外带（R19）。
func configuredProjects(
	ctx context.Context, userID int64, dev *device_entity.Device, rows []*sync_entity.SyncObject,
) (map[string]bool, error) {
	configured := map[string]bool{}
	if dev.Kind == device_entity.KindAgentred {
		for _, row := range rows {
			if row.Kind == sync_entity.KindProjectLocation && row.AgentredFingerprint == dev.Fingerprint {
				configured[row.ProjectSyncID] = true
			}
		}
		return configured, nil
	}
	localPaths, err := sync_repo.SyncLocalPath().ListByDevice(ctx, userID, dev.ID)
	if err != nil {
		return nil, err
	}
	for _, lp := range localPaths {
		configured[lp.ProjectSyncID] = true
	}
	return configured, nil
}

func (s *workspaceSvc) DeviceDetail(ctx context.Context, userID, deviceID int64) (*DeviceDetailView, error) {
	dev, err := device_repo.Device().Find(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	if !dev.UsableBy(userID) {
		return nil, i18n.NewNotFoundError(ctx, code.DeviceNotFound)
	}

	isAgentred := dev.Kind == device_entity.KindAgentred
	kinds := []string{sync_entity.KindProject}
	if isAgentred {
		kinds = append(kinds, sync_entity.KindProjectLocation,
			sync_entity.KindAgent, sync_entity.KindAgentBackend, sync_entity.KindAgentExecTarget)
	}
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, kinds)
	if err != nil {
		return nil, err
	}

	configured, err := configuredProjects(ctx, userID, dev, rows)
	if err != nil {
		return nil, err
	}

	view := &DeviceDetailView{DeviceID: dev.ID, Kind: dev.Kind}
	for _, row := range rows {
		if row.Kind != sync_entity.KindProject {
			continue
		}
		var pp projectPayload
		if err := json.Unmarshal([]byte(row.Payload), &pp); err != nil {
			continue
		}
		isConfigured := configured[row.SyncID]
		// agentred 展开只列「配了路径的项目」（决策 13 的呈现约定）；桌面端展开
		// 两种状态都要出现，用户才看得出「未配置」是一个需要处理的显式状态（R10）。
		if isAgentred && !isConfigured {
			continue
		}
		view.Projects = append(view.Projects, ProjectView{SyncID: row.SyncID, Name: pp.Name, Configured: isConfigured})
	}

	if isAgentred {
		for _, chain := range buildAgentChains(rows) {
			for _, t := range chain.Targets {
				if t.IsLocalReference || t.Fingerprint != dev.Fingerprint {
					continue
				}
				view.RunnableAgents = append(view.RunnableAgents,
					RunnableAgentView{SyncID: chain.SyncID, Name: chain.Name, Rank: t.Rank})
				break
			}
		}
	}
	return view, nil
}

func (s *workspaceSvc) AccountProjects(ctx context.Context, userID int64) ([]ProjectNodeView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{
		sync_entity.KindProject, sync_entity.KindProjectAgent, sync_entity.KindProjectLocation})
	if err != nil {
		return nil, err
	}
	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	members := projectMembersBySyncID(rows)
	configured, err := projectsWithARunnablePath(ctx, userID, rows, devices)
	if err != nil {
		return nil, err
	}
	out := make([]ProjectNodeView, 0, len(rows))
	for _, row := range rows {
		if row.Kind != sync_entity.KindProject {
			continue
		}
		var pp projectPayload
		if json.Unmarshal([]byte(row.Payload), &pp) != nil {
			// 载荷解不开的行如实跳过：宁可少一个组头，也不摆一个没名字的项目。
			continue
		}
		out = append(out, ProjectNodeView{
			SyncID: row.SyncID, Name: pp.Name, Icon: pp.Icon, Color: pp.Color,
			Description: pp.Description, ParentSyncID: pp.ParentSyncID, SortOrder: pp.SortOrder,
			Members: members[row.SyncID], Configured: configured[row.SyncID],
		})
	}
	// 组头顺序要稳定：先 sort_order，再名字，最后同步标识兜底——否则同一批数据
	// 两次请求可能排出两个样子（ListByKinds 没有 ORDER BY）。
	sort.Slice(out, func(i, j int) bool {
		if out[i].SortOrder != out[j].SortOrder {
			return out[i].SortOrder < out[j].SortOrder
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].SyncID < out[j].SyncID
	})
	return out, nil
}

// projectSyncIDByLocation 把 KindProjectLocation 那批行整理成
// (指纹, 路径) → 项目同步标识 的索引，供 SavedSessionSummaries 就地判定项目归属
// （决策 12）。（指纹, 路径）→ 项目同步标识：同一台机器上两个项目配同一条路径属于
// 上游的配置错误（自然键是「项目同步标识 + 指纹」，挡不住这种撞车）：撞车时取
// 字典序最小的那个标识。判据只看数据本身，不看行序——ListByKinds 没有
// ORDER BY，「以先到的一行为准」等于把答案交给这一次的返回顺序，同一批数据能判出
// 两个项目，那条会话就在两个项目组之间来回跳。指不出项目的行（半写入，
// project_sync_id 为空）直接跳过：它占住这条路径只会把真正指得出项目的那一行
// 挡掉，让会话平白掉进「未归项目」。
func projectSyncIDByLocation(rows []*sync_entity.SyncObject) map[string]string {
	byLocation := make(map[string]string, len(rows))
	for _, row := range rows {
		var lp projectLocationPayload
		if json.Unmarshal([]byte(row.Payload), &lp) != nil || lp.Path == "" ||
			row.ProjectSyncID == "" {
			continue
		}
		key := row.AgentredFingerprint + "\x00" + lp.Path
		if taken, ok := byLocation[key]; !ok || row.ProjectSyncID < taken {
			byLocation[key] = row.ProjectSyncID
		}
	}
	return byLocation
}

// orgReadKinds 是画一次组织面要读的四类对象。department 单独取而不是从 Agent 反推：
// 空部门也要摆组头。
var orgReadKinds = []string{
	sync_entity.KindDepartment, sync_entity.KindAgent,
	sync_entity.KindAgentBackend, sync_entity.KindAgentExecTarget,
}

// OrgChart 见接口注释。
func (s *workspaceSvc) OrgChart(ctx context.Context, userID int64) (*OrgChartView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, orgReadKinds)
	if err != nil {
		return nil, err
	}
	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	placer := newTargetPlacer(ctx, userID, devices)

	out := &OrgChartView{
		Departments: make([]OrgDepartmentView, 0, len(rows)),
		Agents:      make([]OrgAgentView, 0, len(rows)),
	}
	for _, row := range rows {
		if row.Kind != sync_entity.KindDepartment {
			continue
		}
		var dp departmentPayload
		if err := json.Unmarshal([]byte(row.Payload), &dp); err != nil {
			continue
		}
		out.Departments = append(out.Departments, OrgDepartmentView{
			SyncID: row.SyncID, Name: dp.Name, Description: dp.Description,
			Icon: dp.Icon, AccentColor: dp.AccentColor, ParentSyncID: dp.ParentSyncID,
			LeadAgentSyncID: dp.LeadAgentSyncID, SortOrder: dp.SortOrder,
		})
	}
	sortByOrderThenName(out.Departments,
		func(d OrgDepartmentView) (int, string) { return d.SortOrder, d.Name })

	for _, chain := range buildAgentChains(rows) {
		agent := OrgAgentView{
			SyncID: chain.SyncID, Name: chain.Name, Description: chain.Description,
			AvatarColor: chain.AvatarColor, AvatarIcon: chain.AvatarIcon,
			SystemBadge: chain.SystemBadge, DepartmentSyncID: chain.DepartmentSyncID,
			ParentAgentSyncID: chain.ParentAgentSyncID, SortOrder: chain.SortOrder,
			PromptJSON: chain.PromptJSON, ToolsJSON: chain.ToolsJSON,
			ExecTargets: make([]OrgExecTargetView, 0, len(chain.Targets)),
		}
		currentAssigned := false
		for _, t := range chain.Targets {
			placed := placer.place(t.Fingerprint, t.IsLocalReference)
			target := OrgExecTargetView{
				SyncID: t.SyncID, Rank: t.Rank, BackendSyncID: t.BackendSyncID,
				BackendName: t.BackendName, BackendType: t.BackendType,
				DeviceID: placed.DeviceID, DeviceName: placed.DeviceName,
				DeviceFingerprint: t.Fingerprint,
				IsLocalReference:  t.IsLocalReference, Availability: placed.Availability,
				SkillsJSON: t.SkillsJSON,
			}
			if !currentAssigned && target.Availability == AvailabilityAvailable {
				target.Current = true
				currentAssigned = true
			}
			agent.ExecTargets = append(agent.ExecTargets, target)
		}
		out.Agents = append(out.Agents, agent)
	}
	// sort_order 是**桶内**的次序（同部门 / 同上级），这里排的是整份清单：全序排完
	// 再按部门分组，桶内的相对次序原样保留，而浏览器不必自己再排一次。
	sortByOrderThenName(out.Agents, func(a OrgAgentView) (int, string) { return a.SortOrder, a.Name })
	return out, nil
}

// SelectableBackends 见接口注释。
func (s *workspaceSvc) SelectableBackends(ctx context.Context, userID int64) ([]OrgBackendView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(
		ctx, userID, []string{sync_entity.KindAgentBackend})
	if err != nil {
		return nil, err
	}
	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	placer := newTargetPlacer(ctx, userID, devices)

	out := make([]OrgBackendView, 0, len(rows))
	for _, row := range rows {
		var bp agentBackendPayload
		if err := json.Unmarshal([]byte(row.Payload), &bp); err != nil {
			continue
		}
		// 指纹为空 = 这个后端没写运行设备（决策 14 的存量），与执行目标那一侧同一
		// 条判据；不猜一台机器补上。
		deviceUnspecified := row.AgentredFingerprint == ""
		placed := placer.place(row.AgentredFingerprint, deviceUnspecified)
		out = append(out, OrgBackendView{
			SyncID: row.SyncID, Name: bp.Name, BackendType: bp.Type,
			DeviceID: placed.DeviceID, DeviceName: placed.DeviceName,
			IsLocalReference: deviceUnspecified, Availability: placed.Availability,
		})
	}
	// 按机器、再按后端名排：挑后端时同一台机器上的档挨在一起，顺序也不随
	// 仓储的返回顺序抖动。
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].DeviceName != out[j].DeviceName {
			return out[i].DeviceName < out[j].DeviceName
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// sortByOrderThenName 按 sort_order 排，同序时按名字定序——组织面的次序由拖拽写进
// sort_order（决策 14 同源），而同序的两行不定序就会在每次读取里换位置。
func sortByOrderThenName[T any](items []T, key func(T) (int, string)) {
	sort.SliceStable(items, func(i, j int) bool {
		orderI, nameI := key(items[i])
		orderJ, nameJ := key(items[j])
		if orderI != orderJ {
			return orderI < orderJ
		}
		return nameI < nameJ
	})
}

// ── 浏览器直写组织面（规格 2026-08-18「server 端的组织管理面」）─────────────────
//
// 这是 sync_objects 上的第四条写路径，也是第一条**不由设备推上来**的：浏览器 →
// REST 端点 → server 直写。语义与设备上行完全一样（账号级单调序列分配版本号、
// 删除落墓碑、下行游标照常把它带给每一台机器），只有来源不同，因此不需要桌面端在线。

// ServerOriginFingerprint 是服务端直写这些行时记的来源标识（决策 21）：**空串**，
// 因为这些行不来自任何一台机器。
//
// 空串空得出来，是因为它此前没有含义：这一列建表时是 DEFAULT 0 / DEFAULT ” 且没有
// 回填（migrations/202608280006_workspace_sync.go），而唯一读它的分支——
// SyncObject.Wins 的平局判定——只在两行版本号相等时才看它，账号级单调序列保证了那
// 永远不会发生。
//
// 它会经冲突应答回到桌面端（PushItemResult.OverwrittenOriginFingerprint /
// MergedOriginFingerprint），桌面端据此向用户交代「你的改动被谁覆盖了」，那一侧必须
// 把空串说成「服务端（浏览器）」而不是一台没名字的机器（agentre 的
// sync_svc.originDeviceOf）。
const ServerOriginFingerprint = ""

// orgWritableKinds 是 web 组织面能建 / 改 / 删的三类对象。
//
// **agent_backend 刻意不在其中。** 它是设备级对象，同步载荷里带着 cli_path 与
// env_json（本机可执行文件路径与用户自填的透传环境变量）：浏览器无从知道那台机器上
// 的可执行文件在哪，新建出来的档必然不可用。web 上能做的是从**已有**后端里挑一个
// 去配执行目标（见 checkExecTargetBackend）。
//
// **project 与 project_agent 在这条通道里**（规格 2026-08-20 决策 2）：它们的载荷
// 全是「指向」——名字、图标、颜色、简介、父项目、两端的同步标识，没有任何一件是
// 机器上的东西。把「载荷里带本机路径」这条理由套到它们身上只对 project_location
// 成立，那一类另有自己的入口（见 project.go）。项目自己的那几条判据在
// checkProjectWrite。
var orgWritableKinds = map[string]bool{
	sync_entity.KindDepartment:      true,
	sync_entity.KindAgent:           true,
	sync_entity.KindAgentExecTarget: true,
	sync_entity.KindProject:         true,
	sync_entity.KindProjectAgent:    true,
	// project_location 也在这条通道里，但**只从 SetProjectLocation 那个入口进来**
	// （它要先解自然键、先挡住桌面端）。放行的是删除与那个入口内部的建 / 改；
	// 建路上那两个自然键列缺一个就当场拒（见 CreateOrgObject）。
	sync_entity.KindProjectLocation: true,
}

// orgCreateRequired 是新建时必须给出且非空的键。缺了它们的行在桌面端落不了地
// （实体自己的 Check 拦下），落成一行同步对象只会让它在每一端都卡着。
var orgCreateRequired = map[string][]string{
	sync_entity.KindDepartment:      {"name"},
	sync_entity.KindAgent:           {"name"},
	sync_entity.KindAgentExecTarget: {"agent_sync_id", "backend_sync_id"},
	sync_entity.KindProject:         {"name"},
	sync_entity.KindProjectAgent:    {"project_sync_id", "agent_sync_id"},
	sync_entity.KindProjectLocation: {"path"},
}

// OrgWriteInput 是一次浏览器发起的组织面写入。
//
// UserID 来自鉴权上下文而不是请求体（请求体里没有任何身份字段），写入范围因此只由
// 它圈定，跨账号写不进去。Fields 只包含**这次请求明确涉及的键**：没提到的键不出现
// 在这个 map 里，也就不会覆盖载荷里的原值。
type OrgWriteInput struct {
	UserID int64
	Kind   string
	// SyncID 建时为空（由 server 分配），改与删时是要写的那一行。
	SyncID string
	Fields map[string]any
	// ProjectSyncID 与 AgentredFingerprint 是路径记录的账号内自然键，**在列上而不是
	// 载荷里**：R4b 的合并与那个部分唯一索引认的都是列。只有 kind=project_location
	// 用得上它们，别的类型留空（桌面端推上来的成员关系同样不占这两列）。
	ProjectSyncID       string
	AgentredFingerprint string
}

// OrgWriteResult 回给浏览器的写入回执：新行的同步标识，以及这次写入吃掉的版本号。
type OrgWriteResult struct {
	SyncID  string
	Version int64
}

// CreateOrgObject 新建一行：server 分配同步标识与版本号，来源指纹记空串。
func (s *workspaceSvc) CreateOrgObject(ctx context.Context, in OrgWriteInput) (*OrgWriteResult, error) {
	if err := checkOrgWritableKind(ctx, in.Kind); err != nil {
		return nil, err
	}
	for _, key := range orgCreateRequired[in.Kind] {
		if str, _ := in.Fields[key].(string); strings.TrimSpace(str) == "" {
			return nil, i18n.NewError(ctx, code.InvalidParameter)
		}
	}
	if err := s.checkExecTargetBackend(ctx, in); err != nil {
		return nil, err
	}
	// 新建时还没有自己的同步标识，因此不可能指向自己——环只可能出现在改父项目那一侧。
	if err := checkProjectWrite(ctx, in, ""); err != nil {
		return nil, err
	}
	if err := checkLocationNaturalKey(ctx, in); err != nil {
		return nil, err
	}
	fields, err := s.withExecTargetTailSlot(ctx, in)
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	fields = withProjectMemberJoinedAt(in.Kind, fields, now)

	payload, err := json.Marshal(orgFieldsOrEmpty(fields))
	if err != nil {
		return nil, err
	}
	version, err := sync_repo.SyncState().NextVersion(ctx, in.UserID, 1)
	if err != nil {
		return nil, err
	}
	obj := &sync_entity.SyncObject{
		UserID: in.UserID, Kind: in.Kind, SyncID: newOrgSyncID(now),
		ProjectSyncID: in.ProjectSyncID, AgentredFingerprint: in.AgentredFingerprint,
		Payload: string(payload), Version: version, SyncUpdatedAt: now,
		OriginFingerprint: ServerOriginFingerprint, Createtime: now, Updatetime: now,
	}
	if err := sync_repo.SyncObject().Save(ctx, obj); err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("workspace_svc.CreateOrgObject: org object created from web",
		zap.Int64("userId", in.UserID), zap.String("kind", in.Kind),
		zap.String("syncId", obj.SyncID), zap.Int64("version", obj.Version))
	accountchan_svc.BroadcastBestEffort(ctx, in.UserID, obj.Version)
	return &OrgWriteResult{SyncID: obj.SyncID, Version: obj.Version}, nil
}

// UpdateOrgObject 改一行：**只覆盖请求明确涉及的键**，载荷里其余的原值保留。
func (s *workspaceSvc) UpdateOrgObject(ctx context.Context, in OrgWriteInput) (*OrgWriteResult, error) {
	row, err := s.findOrgRowForWrite(ctx, in)
	if err != nil {
		return nil, err
	}
	if err := s.checkExecTargetBackend(ctx, in); err != nil {
		return nil, err
	}
	if err := checkSystemAgentPlacement(ctx, row, in); err != nil {
		return nil, err
	}
	if err := checkProjectWrite(ctx, in, row.SyncID); err != nil {
		return nil, err
	}
	payload, err := withOrgFields(row.Payload, in.Fields)
	if err != nil {
		return nil, err
	}
	row.Payload = payload
	if err := s.saveOrgRow(ctx, in, row); err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("workspace_svc.UpdateOrgObject: org object updated from web",
		zap.Int64("userId", in.UserID), zap.String("kind", in.Kind),
		zap.String("syncId", row.SyncID), zap.Int64("version", row.Version),
		zap.Strings("fields", keysOfOrgFields(in.Fields)))
	return &OrgWriteResult{SyncID: row.SyncID, Version: row.Version}, nil
}

// DeleteOrgObject 删一行：落墓碑而不是物理删除——删除本身要能被下行游标带到每一台
// 机器上，物理删除只会让还没拉取的设备把它当成「从未存在」而重新推上来（R6）。
// 正文原样留着，与设备离开账号那条路径（sync_repo.Tombstone）一致。
func (s *workspaceSvc) DeleteOrgObject(ctx context.Context, in OrgWriteInput) (*OrgWriteResult, error) {
	row, err := s.findOrgRowForWrite(ctx, in)
	if err != nil {
		return nil, err
	}
	if isSystemAgentRow(row) {
		return nil, i18n.NewError(ctx, code.OrgSystemAgentImmutable)
	}
	// 子树先落，主行最后落：主行因此拿到这次操作推进到的最高版本，saveOrgRow 那一次
	// 广播就把整批改动的信号一起带出去了。
	if err := cascadeProjectDelete(ctx, in, row); err != nil {
		return nil, err
	}
	row.DeletedAt = time.Now().UnixMilli()
	if err := s.saveOrgRow(ctx, in, row); err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("workspace_svc.DeleteOrgObject: org object tombstoned from web",
		zap.Int64("userId", in.UserID), zap.String("kind", in.Kind),
		zap.String("syncId", row.SyncID), zap.Int64("version", row.Version))
	return &OrgWriteResult{SyncID: row.SyncID, Version: row.Version}, nil
}

// findOrgRowForWrite 取出要写的那一行，并把三条拒绝判在写入之前：
//
//   - 类型不在写通道里（后端在 web 上只读）；
//   - 行在**当前账号**下不存在，或类型与端点不符——跨账号的那一行正落在这里，
//     Find 按（账号, 同步标识）取，别的账号的行根本取不到，因此不需要额外的归属校验；
//   - 行已是墓碑：删除不复活（R6），界面据此提供「按这份内容新建」。
func (s *workspaceSvc) findOrgRowForWrite(
	ctx context.Context, in OrgWriteInput,
) (*sync_entity.SyncObject, error) {
	if err := checkOrgWritableKind(ctx, in.Kind); err != nil {
		return nil, err
	}
	if in.SyncID == "" {
		return nil, i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
	}
	row, err := sync_repo.SyncObject().Find(ctx, in.UserID, in.SyncID)
	if err != nil {
		return nil, err
	}
	// 类型不符与「不存在」共用一个码：分开就等于给出一个跨账号的存在性探测器。
	if row == nil || row.Kind != in.Kind {
		return nil, i18n.NewNotFoundError(ctx, code.OrgObjectNotFound)
	}
	if row.IsDeleted() {
		return nil, i18n.NewError(ctx, code.OrgObjectDeleted)
	}
	return row, nil
}

// saveOrgRow 落这一行：新版本号 + 服务端来源。改与删只差 DeletedAt，其余完全一样，
// 因此共用这一段——两处各写一遍就是两处各漏一个字段的机会。
func (s *workspaceSvc) saveOrgRow(
	ctx context.Context, in OrgWriteInput, row *sync_entity.SyncObject,
) error {
	version, err := sync_repo.SyncState().NextVersion(ctx, in.UserID, 1)
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	row.Version = version
	row.SyncUpdatedAt = now
	row.Updatetime = now
	row.OriginFingerprint = ServerOriginFingerprint
	if err := sync_repo.SyncObject().Save(ctx, row); err != nil {
		return err
	}
	// UpdateOrgObject 与 DeleteOrgObject 共用这一段（同上面 Save 一样，两处各写一遍
	// 就是两处各漏一次广播的机会）——两者都是「服务端直写（web 组织面）」这一类。
	accountchan_svc.BroadcastBestEffort(ctx, in.UserID, version)
	return nil
}

// checkExecTargetBackend 落实「执行目标只能引用**已有**后端」：浏览器建不出后端，
// 也就只能从账号里已有的那些里挑一个。引用一个不存在 / 已落墓碑 / 根本不是后端的
// 标识时当场拒绝——落下去只会是一档永远不可用的执行目标，而它在界面上与可用的档
// 长得一模一样。请求没提到 backend_sync_id 时（例如只改技能授权）不做这次核对。
func (s *workspaceSvc) checkExecTargetBackend(ctx context.Context, in OrgWriteInput) error {
	if in.Kind != sync_entity.KindAgentExecTarget {
		return nil
	}
	backendSyncID, _ := in.Fields["backend_sync_id"].(string)
	if backendSyncID == "" {
		return nil
	}
	backend, err := sync_repo.SyncObject().Find(ctx, in.UserID, backendSyncID)
	if err != nil {
		return err
	}
	if backend == nil || backend.IsDeleted() || backend.Kind != sync_entity.KindAgentBackend {
		return i18n.NewNotFoundError(ctx, code.OrgBackendNotFound)
	}
	return nil
}

// isSystemAgentRow 认出账号里那一个系统 Agent：载荷里 system_badge 非空
// （桌面端 agent_entity.Agent.IsSystem 的同一条判据，只是这一侧读的是同步载荷）。
// 载荷解不动时按「不是」处理：这道闸拦的是一次明确的破坏动作，解析失败不该顺带
// 把普通 Agent 的删除也一起挡住。
func isSystemAgentRow(row *sync_entity.SyncObject) bool {
	if row == nil || row.Kind != sync_entity.KindAgent {
		return false
	}
	var ap agentPayload
	if err := json.Unmarshal([]byte(row.Payload), &ap); err != nil {
		return false
	}
	return strings.TrimSpace(ap.SystemBadge) != ""
}

// checkSystemAgentPlacement 落实「系统 Agent 挪不动」这一半（删不掉那一半在
// DeleteOrgObject）。判的是**写进去的值**而不是键在不在：显式清空归属
// （两个键都传空串）恰恰是它唯一合法的形状，拦下来反而让浏览器修不好一行脏数据。
// 改名 / 改简介 / 改提示词照常放行——桌面端也只拦删与挪（agent_svc.Delete / Move）。
func checkSystemAgentPlacement(
	ctx context.Context, row *sync_entity.SyncObject, in OrgWriteInput,
) error {
	if !isSystemAgentRow(row) {
		return nil
	}
	for _, key := range []string{"department_sync_id", "parent_agent_sync_id"} {
		if v, _ := in.Fields[key].(string); strings.TrimSpace(v) != "" {
			return i18n.NewError(ctx, code.OrgSystemAgentImmutable)
		}
	}
	return nil
}

// withExecTargetTailSlot 给没写明 sort_order 的新执行目标补一个「接在这条链末尾」
// 的位次。
//
// 不补的话载荷里根本没有这个键，读侧解出来就是 0 —— 与链头打平
// （SetExecTargetOrder 写的是 0 基下标）。打平之后谁在前由 ListByKinds 的返回顺序
// 决定，而那条查询没有 ORDER BY：同一份数据两次读取可以给出不同的「当前生效」档，
// 用户排在第一位的那台机器会被新加的一档挤掉。桌面端新建时同样取「下一个位次」
// （agent_svc.nextSortOrder），两端因此是同一种语义。
//
// **显式给了就照给的写**：0 是「插到队首」这个有意的值，不能与「没提到」混为一谈。
//
// 两个副本同时新建时可能算出同一个尾位次，那是两条**新**档之间的平局——比与链头
// 打平轻得多（当前生效档不变），用户拖一下就分开了。要根除得给这条链上锁，代价
// 与收益不成比例。
func (s *workspaceSvc) withExecTargetTailSlot(
	ctx context.Context, in OrgWriteInput,
) (map[string]any, error) {
	if in.Kind != sync_entity.KindAgentExecTarget {
		return in.Fields, nil
	}
	if _, ok := in.Fields["sort_order"]; ok {
		return in.Fields, nil
	}
	agentSyncID, _ := in.Fields["agent_sync_id"].(string)
	rows, err := sync_repo.SyncObject().ListByKinds(
		ctx, in.UserID, []string{sync_entity.KindAgentExecTarget})
	if err != nil {
		return nil, err
	}
	tail := -1
	for _, row := range rows {
		var tp agentExecTargetPayload
		if json.Unmarshal([]byte(row.Payload), &tp) != nil || tp.AgentSyncID != agentSyncID {
			continue
		}
		if tp.SortOrder > tail {
			tail = tp.SortOrder
		}
	}
	// 原 map 不就地改：调用方（controller）拼出来的那一份不该因为走了一趟 service
	// 就多出一个它没写的键。
	next := make(map[string]any, len(in.Fields)+1)
	for k, v := range in.Fields {
		next[k] = v
	}
	next["sort_order"] = tail + 1
	return next, nil
}

func checkOrgWritableKind(ctx context.Context, kind string) error {
	if !orgWritableKinds[kind] {
		return i18n.NewError(ctx, code.OrgKindNotWritable)
	}
	return nil
}

// withOrgFields 把这次请求涉及的键合进原载荷，**其余的键原样留下**。
//
// 必须走 map[string]any 往返，不能解进一个 Go 结构体：sync_objects 是整行
// last-write-wins（前置规格决策 4 把字段级合并列为非目标），任何结构体都只声明得出
// 这一侧当下认识的键，解进去再 marshal 回来就把别的键——桌面端新版本刚加的、
// 本轮没人读的——静默抹掉了。这不是假想的失误：SetExecTargetOrder 就是照着读路径
// 的结构体写写路径，差点把 skills_json 抹掉（见 withSortOrder）。
func withOrgFields(payload string, fields map[string]any) (string, error) {
	m := map[string]any{}
	if strings.TrimSpace(payload) != "" {
		if err := json.Unmarshal([]byte(payload), &m); err != nil {
			return "", err
		}
	}
	for k, v := range fields {
		m[k] = v
	}
	next, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	return string(next), nil
}

// orgFieldsOrEmpty 保证新建的载荷是一个 JSON 对象：nil map marshal 出来是 null，
// 而 sync_objects.payload 存的是对象（sync_entity.ValidatePayload 也只认对象）。
func orgFieldsOrEmpty(fields map[string]any) map[string]any {
	if fields == nil {
		return map[string]any{}
	}
	return fields
}

// keysOfOrgFields 只把**键名**排序后交给日志。载荷正文一律不进日志（里面有系统
// 提示词与简介），日志要回答的只是「这次改了哪几个键」。
func keysOfOrgFields(fields map[string]any) []string {
	out := make([]string, 0, len(fields))
	for k := range fields {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// newOrgSyncID 给服务端直写的新行分配同步标识：与桌面端同一种形状（ULID，
// 前置规格决策 3），单调时钟源 + 加密随机熵，两个副本同时新建也不会撞。
func newOrgSyncID(nowMs int64) string {
	return ulid.MustNew(ulid.Timestamp(time.UnixMilli(nowMs)), rand.Reader).String()
}
