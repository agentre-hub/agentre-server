// Package sessionimport 定义「导入本地会话」那三个端点的请求与响应
// （规格 2026-08-26 的远端一半）。
//
// # 为什么这三个响应带得动 cwd
//
// 账号镜像那一族（internal/api/agentsession、internal/api/workspace）有一条硬不变量
// R19：项目路径与工作目录不出现在任何发往浏览器的响应里，而且由那两个包的守卫
// 反射深走地守着。本包**故意**在守卫之外：导入的第一维筛选问的就是工作目录，
// 候选清单靠它才认得出「哪一条是我要的那条」——挑不了一个看不见的值，与项目设置
// 「机器与路径」那一处收窄同理（见 internal/api/workspace 上它自己的注释）。
//
// 例外只开在这一个包上，且只开给**磁盘转录自己的**工作目录：这里没有 CLIPath、
// 没有 EnvJSON，也没有账号镜像里任何一条会话的 cwd。
package sessionimport

import (
	"encoding/json"

	"github.com/cago-frame/cago/server/mux"
)

// ---------- 发现：这台机器上有哪些能导的会话 ----------

// CandidatesRequest 问一台机器它磁盘上的可导会话。DeviceID 指向账号里的一台机器
// ——**不接受指纹**：指纹是机器的身份，而这一族的入口是设备列表里的一行。
type CandidatesRequest struct {
	mux.Meta `path:"/v1/session-import/candidates" method:"GET"`
	DeviceID int64 `form:"device_id" binding:"required"`
	// Backends 是逗号分隔的后端类型；空 = 这台机器上注册的全部。
	Backends string `form:"backends" binding:"omitempty,max=200"`
	// CwdPrefix / TitleQuery 是两维筛选，原样交给那台机器（它比服务端更知道自己
	// 磁盘上有什么）。
	CwdPrefix  string `form:"cwd_prefix" binding:"omitempty,max=1024"`
	TitleQuery string `form:"title_query" binding:"omitempty,max=200"`
	Limit      int    `form:"limit" binding:"omitempty,min=1"`
}

// CandidateItem 是候选清单的一行。
type CandidateItem struct {
	Backend           string `json:"backend"`
	ProviderSessionID string `json:"provider_session_id"`
	Title             string `json:"title,omitempty"`
	// Cwd 是这份转录记的工作目录，见包注释：它是 R19 在本包上的显式例外。
	Cwd       string `json:"cwd,omitempty"`
	StartedAt int64  `json:"started_at,omitempty"`
	EndedAt   int64  `json:"ended_at,omitempty"`
	// Turns 为 0 = 未知（磁盘上没记），不是「空会话」。
	Turns  int    `json:"turns"`
	Origin string `json:"origin,omitempty"`
	// Locator 是那台机器给的不透明定位符：预览与执行原样回传，服务端不解析它。
	Locator string `json:"locator"`
	// Imported 为真 = 这条 provider 会话在这台机器名下已经导过、账号里也镜像着它。
	Imported          bool   `json:"imported,omitempty"`
	ImportedSessionID string `json:"imported_session_id,omitempty"`
}

// ScanIssueItem 是一档答不出的理由。**Backend 为空 = 设备级**（整台机器联系不上）。
// Status 当前为 unavailable，永不为空：空清单
// 必须自带理由——「问出来就是没有」与「这台机器答不出」是两句不同的话。
type ScanIssueItem struct {
	Backend string `json:"backend,omitempty"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
}

type CandidatesResponse struct {
	Candidates []CandidateItem `json:"candidates"`
	Issues     []ScanIssueItem `json:"issues"`
}

// ---------- 预览：这条转录长什么样 ----------

type PreviewRequest struct {
	mux.Meta `path:"/v1/session-import/preview" method:"GET"`
	DeviceID int64  `form:"device_id" binding:"required"`
	Backend  string `form:"backend" binding:"required,max=64"`
	Locator  string `form:"locator" binding:"required,max=4096"`
	// Turns 是要解几轮，不填走服务端默认档。
	Turns int `form:"turns" binding:"omitempty,min=1"`
}

type GapItem struct {
	Kind   string `json:"kind"`
	Count  int    `json:"count"`
	Detail string `json:"detail,omitempty"`
}

type TranscriptMetaItem struct {
	Backend           string `json:"backend"`
	ProviderSessionID string `json:"provider_session_id"`
	Title             string `json:"title,omitempty"`
	// Cwd 同 CandidateItem.Cwd：本包的显式例外。
	Cwd               string    `json:"cwd,omitempty"`
	Model             string    `json:"model,omitempty"`
	Turns             int       `json:"turns"`
	ToolCalls         int       `json:"tool_calls"`
	Compactions       int       `json:"compactions"`
	StartedAt         int64     `json:"started_at,omitempty"`
	EndedAt           int64     `json:"ended_at,omitempty"`
	Origin            string    `json:"origin,omitempty"`
	Gaps              []GapItem `json:"gaps"`
	Imported          bool      `json:"imported,omitempty"`
	ImportedSessionID string    `json:"imported_session_id,omitempty"`
}

// TranscriptFrameItem 与账号镜像那条转录端点的帧**逐字段同形**（seq / method /
// params）：浏览器因此把预览喂进与真实转录同一个归约器，不另开一条渲染链。
type TranscriptFrameItem struct {
	Seq    int64           `json:"seq"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type PreviewResponse struct {
	Meta   TranscriptMetaItem    `json:"meta"`
	Frames []TranscriptFrameItem `json:"frames"`
	// PreviewedTurns 是这次真的解出来的轮数。RemainingTurns 为 -1 表示元信息里
	// 没有轮数，说不出还剩几轮——不是 0，别让界面说「没有更多了」。
	PreviewedTurns int `json:"previewed_turns"`
	RemainingTurns int `json:"remaining_turns"`
}

// ---------- 执行：让那台机器把它导进来 ----------

// RunRequest 让握着这份转录的机器执行一次导入。
//
// SessionID 由**浏览器**铸（与新对话那条路同一条规矩：会话 id 是各客户端本地自增
// 的主键，服务端与 daemon 都不发号）。标题、工作目录与 provider 会话身份不在入参
// 里——它们是那份转录自己的事实，由那台机器读出来写下去。
type RunRequest struct {
	mux.Meta  `path:"/v1/session-import/run" method:"POST"`
	DeviceID  int64  `json:"device_id" binding:"required"`
	Backend   string `json:"backend" binding:"required,max=64"`
	Locator   string `json:"locator" binding:"required,max=4096"`
	SessionID int64  `json:"session_id" binding:"required,min=1"`
	// AgentSyncID 是这条会话挂在哪个 Agent 名下（账号级标识）。空 = 不挂。
	AgentSyncID string `json:"agent_sync_id" binding:"omitempty,max=255"`
}

// RunResponse 是一次导入的结果。
//
// AlreadyImported 为真表示这条 provider 会话在那台机器上早就有一条会话了，
// SessionID 指的是**它那条**（未必等于这次铸的号），ImportedTurns 为 0 ——
// 重复导入是可预期的正常分支，不是错误。
type RunResponse struct {
	// SessionID 是那台机器上这条会话的标识；PeerFingerprint 是它的发起端——两者
	// 合起来才是这条对话的身份，浏览器拿它去打开详情页。
	SessionID       string `json:"session_id"`
	PeerFingerprint string `json:"peer_fingerprint"`
	// Cwd 同上：本包的显式例外，界面用它说明「这条会话会在哪儿接着跑」。
	Cwd               string `json:"cwd,omitempty"`
	Title             string `json:"title,omitempty"`
	ProviderSessionID string `json:"provider_session_id,omitempty"`
	ImportedTurns     int    `json:"imported_turns"`
	AlreadyImported   bool   `json:"already_imported,omitempty"`
}
