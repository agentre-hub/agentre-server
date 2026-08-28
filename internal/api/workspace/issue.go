package workspace

import "github.com/cago-frame/cago/server/mux"

// ---------- 看板（规格 2026-08-27-issues-board-project-scope「`agentre-server` 端」）----------
//
// **不新增任何表。** 任务、标签与两者的关联全部住在既有的 sync_objects 里，靠 kind
// 区分；这一族端点走的是与组织面、项目面完全同一条鉴权与写入模式：账号取自鉴权
// 上下文，**请求体里没有任何身份字段**，跨账号因此读不到也写不进去。
//
// 读一条、写七条。写那七条与组织面同形：建（`/…`）、改（`/…/update`）、删
// （`/…/delete`），加上拖动自己那一条（`/v1/workspace/issues/move`）。
//
// **这里没有、也不会有 agent_backend 的建与改**（与 org.go 顶部同一条理由）：它是
// 设备级对象，浏览器建出来的档必然不可用。机器那颗 pill 只能从已有后端里挑一个，
// 引用它的是 IssueFields.AgentBackendSyncID 这个**同步标识**。
//
// **指针 = 「这次请求没提到这个键」**，与组织面同一口径：服务端只覆盖明确涉及的键，
// 载荷里其余的原值原样留下。省略与显式传 null 是同一件事，都不改。

// IssueBoardRequest 一次取回看板要画的全部材料：卡、标签目录、列头的两套计数、
// 项目选择器的子树计数。六个筛选条件全部在这里表达，服务端在 Go 里算（决策 15）。
type IssueBoardRequest struct {
	mux.Meta `path:"/v1/workspace/issues" method:"GET"`
	// Scope / ProjectSyncID 是「项目」那一条：all（默认）/ unassigned / project。
	Scope         string `form:"scope" binding:"omitempty,oneof=all unassigned project"`
	ProjectSyncID string `form:"project_sync_id" binding:"omitempty,max=255"`
	// Keyword 匹配标题与描述。桌面端还能按 `#编号` 命中，而编号是那台机器上的本地
	// 主键、不过机——这一侧把 `#179` 当成文本 `179` 匹配，不编造一个账号级编号。
	Keyword string `form:"keyword" binding:"omitempty,max=200"`
	// LabelSyncIDs 多选；LabelMatchAll 决定「任意一个」还是「全部满足」。
	LabelSyncIDs  []string `form:"label_sync_ids" binding:"omitempty,max=50,dive,max=255"`
	LabelMatchAll bool     `form:"label_match_all"`
	NoLabel       bool     `form:"no_label"`
	// 两段闭区间（毫秒 epoch，0 = 该端不限）。创建时间在这一侧是**账号第一次见到
	// 这张卡**的时刻：载荷里没有桌面端那一行的建立时间。
	UpdatedFrom int64 `form:"updated_from"`
	UpdatedTo   int64 `form:"updated_to"`
	CreatedFrom int64 `form:"created_from"`
	CreatedTo   int64 `form:"created_to"`
	// DoneWithinDays 「已完成保留多久」（0 = 全部）：只裁剪已完成的卡片。
	DoneWithinDays int `form:"done_within_days" binding:"omitempty,min=1,max=3650"`
}

// LabelItem 是标签目录的一项。UsageCount 是「被 N 个任务使用」，删之前要说得出的
// 爆炸半径；卡片上的标签只用得到字形与色调，那一处它是 0。
type LabelItem struct {
	SyncID     string `json:"sync_id"`
	Name       string `json:"name"`
	Tone       string `json:"tone"`
	UsageCount int64  `json:"usage_count"`
}

// IssueItem 是板上的一张卡。
//
// **没有 state**：状态轴本轮消失，它完全由 stage 推导（stage=done 即已完成），
// 两端各自算，不进载荷也不进这个响应。执行归属三个字段本轮没有任何路径读，但必须
// 带出去——表单打开时那三颗 pill 要停在原来的位置上。
type IssueItem struct {
	SyncID      string  `json:"sync_id"`
	Title       string  `json:"title"`
	Description string  `json:"description,omitempty"`
	Stage       string  `json:"stage"`
	Position    float64 `json:"position"`
	// ProjectSyncID 为空即未归属。
	ProjectSyncID      string `json:"project_sync_id,omitempty"`
	AgentSyncID        string `json:"agent_sync_id,omitempty"`
	AgentBackendSyncID string `json:"agent_backend_sync_id,omitempty"`
	LLMProviderKey     string `json:"llm_provider_key,omitempty"`
	LLMModelKey        string `json:"llm_model_key,omitempty"`
	ClosedAt           int64  `json:"closed_at"`
	// CreatedAt 是账号第一次见到这张卡的时刻（见 IssueBoardRequest 上的注释）。
	CreatedAt int64       `json:"created_at"`
	UpdatedAt int64       `json:"updated_at"`
	Labels    []LabelItem `json:"labels"`
}

// ProjectIssueCountItem 是项目选择器每一项右侧的计数：该项目**及其子树**里未完成的
// 任务数（ProjectSyncID 为空是「未归属」那一档，没有未归属任务时这一项不出现）。
// 它**不随筛选变化**——打开选择器就是为了判断该切到哪。
type ProjectIssueCountItem struct {
	ProjectSyncID string `json:"project_sync_id"`
	Count         int64  `json:"count"`
}

type IssueBoardResponse struct {
	Issues []IssueItem `json:"issues"`
	// Labels 是账号的标签目录：筛选面板与标签管理画的是同一份，不再多问一次。
	Labels []LabelItem `json:"labels"`
	// StageCounts / StageTotals 是列头的「命中 / 全部」：前者吃全部筛选条件，
	// 后者只吃项目范围。零命中的列照常有数，界面据此把空列留在原位。
	StageCounts   map[string]int64        `json:"stage_counts"`
	StageTotals   map[string]int64        `json:"stage_totals"`
	ProjectCounts []ProjectIssueCountItem `json:"project_counts"`
}

// ---------- 任务 ----------

// IssueFields 是浏览器能写的任务键，建与改共用。
//
// **没有 position**：新卡由服务端放到目标列末尾，改位置是拖动那条端点的事——把它
// 交给浏览器算，两个标签页同时拖就会算出两个互相覆盖的值。
// **没有 closed_at**：关闭时刻完全由 stage 推导。
type IssueFields struct {
	Title       *string `json:"title" binding:"omitempty,max=500"`
	Description *string `json:"description" binding:"omitempty,max=65535"`
	// Stage 不传即不改阶段；四列之外的值当场拒。
	Stage *string `json:"stage" binding:"omitempty,oneof=todo doing review done"`
	// ProjectSyncID 为空串即未归属；不传则不动原来的归属。
	ProjectSyncID *string `json:"project_sync_id" binding:"omitempty,max=255"`
	// 执行归属的三个「指向」。AgentBackendSyncID 引用的是账号里**已有**的后端
	// （浏览器建不出后端，见包顶部）。
	AgentSyncID        *string `json:"agent_sync_id" binding:"omitempty,max=255"`
	AgentBackendSyncID *string `json:"agent_backend_sync_id" binding:"omitempty,max=255"`
	LLMProviderKey     *string `json:"llm_provider_key" binding:"omitempty,max=255"`
	LLMModelKey        *string `json:"llm_model_key" binding:"omitempty,max=255"`
	// LabelSyncIDs 不传即这次请求没提到标签，一行关联都不动；传空数组是「摘掉全部
	// 标签」。两者是不同的意思，因此是指针。
	LabelSyncIDs *[]string `json:"label_sync_ids" binding:"omitempty,max=50,dive,max=255"`
}

type CreateIssueRequest struct {
	mux.Meta `path:"/v1/workspace/issues" method:"POST"`
	IssueFields
}

type UpdateIssueRequest struct {
	mux.Meta `path:"/v1/workspace/issues/update" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
	IssueFields
}

// MoveIssueRequest 拖一张卡：落到哪一列、排在谁后面（AfterSyncID 为空即列首）。
// 位置由服务端在相邻两卡之间算，浏览器只说「排在谁后面」。
type MoveIssueRequest struct {
	mux.Meta    `path:"/v1/workspace/issues/move" method:"POST"`
	SyncID      string `json:"sync_id" binding:"required,max=255"`
	Stage       string `json:"stage" binding:"required,oneof=todo doing review done"`
	AfterSyncID string `json:"after_sync_id" binding:"omitempty,max=255"`
}

type DeleteIssueRequest struct {
	mux.Meta `path:"/v1/workspace/issues/delete" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
}

// ---------- 标签 ----------

// IssueLabelFields 是浏览器能写的标签键。**没有 status**：标签还在不在由建 / 删
// 两条路径决定，服务端自己记，浏览器写不了「让它消失但留在目录里」这种中间态。
type IssueLabelFields struct {
	Name *string `json:"name" binding:"omitempty,max=100"`
	// Tone 是设计系统的 8 档颜色名；取值域由服务端核对，越界即拒。
	Tone *string `json:"tone" binding:"omitempty,max=32"`
}

type CreateIssueLabelRequest struct {
	mux.Meta `path:"/v1/workspace/issues/labels" method:"POST"`
	IssueLabelFields
}

type UpdateIssueLabelRequest struct {
	mux.Meta `path:"/v1/workspace/issues/labels/update" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
	IssueLabelFields
}

type DeleteIssueLabelRequest struct {
	mux.Meta `path:"/v1/workspace/issues/labels/delete" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
}
