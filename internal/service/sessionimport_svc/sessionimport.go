// Package sessionimport_svc 是「把一台机器磁盘上的旧 CLI 会话导进账号」这件事在
// server 这一侧的编排（规格 2026-08-26 的远端一半）。
//
// # 谁在导
//
// **不是 server**。server 从不拥有会话，它只镜像会话：「新对话」的既定形状是浏览器
// 铸号、机器执行、内容经 SESSION_LIST / SESSION_PULL 流上去。导入照同一条形状走 ——
// 浏览器挑机器与转录，**握着那份转录的机器**读盘、建会话、把回放出的轮次落进它自己
// 的通知日志，于是导出来的会话和别的会话一模一样地镜像上来，不需要第二条通路。
// 本包因此只做三件事：够到那台机器、把它的答话翻成浏览器的视图、导完把这条会话
// 收进账号（否则它不在镜像范围里，导了也看不见）。
//
// # 两态必须活着到浏览器
//
//   - **ok / unavailable 是按后端答的**：某台机器上没装 codex，只有 codex 那一档
//     unavailable，claude 那一档照常出结果。
//   - 机器不在线是**设备级**的一档（Backend 为空），而不是一次失败。
//
// 两者都以**结构化的一档**交给浏览器，不折成一句「导入失败」：它们的去处完全不同
// （装个 CLI / 把机器开起来），而空清单配一句通用报错，用户只会以为那台机器上没有
// 会话。
//
// 那台机器不认识这个方法族（-32601）**不出档**：它是协议违约，原样以错误上交
// （见 bootstrap 的 machineImports.WithPeer），不装成「这台机器答不出」。
//
// # 路径为什么在这里出现（R19）
//
// 账号镜像那条线上 cwd 永不下行。导入这条不同：候选靠**工作目录**才认得出「哪一条
// 是我要的那条」，对话框第一个筛选框问的就是它。这与项目设置「机器与路径」那一处
// 收窄同理 —— 用户要挑的就是它，而挑不了一个看不见的值。它是**显式**的第二处例外，
// 只开在 internal/api/sessionimport 这一个包上。
package sessionimport_svc

import (
	"context"
	"encoding/json"
	"errors"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// 一档答不出的判别值（与共享包 ImportScanStatus 同值）。
const (
	// StatusUnavailable 这一档此刻答不出：那台机器不在线，或它上面没装这个后端。
	StatusUnavailable = "unavailable"
)

var (
	// ErrMachineOffline 那台机器现在联系不上。发现路径把它折成设备级的一档（清单
	// 照给、理由写在上面），预览与执行则如实报错 —— 那两件事没有「部分成功」。
	ErrMachineOffline = errors.New("sessionimport: machine is offline")
)

// CandidateView 是候选清单里的一行。Locator 是那台机器给的不透明定位符，原样回传。
type CandidateView struct {
	Backend           string
	ProviderSessionID string
	Title             string
	Cwd               string
	StartedAt         int64
	EndedAt           int64
	// Turns 为 0 = **未知**（元信息里没有轮数），不是「空会话」。
	Turns   int
	Origin  string
	Locator string
	// Imported 为真表示这条 provider 会话在这台机器名下已经导过一次，账号里也镜像
	// 着它：照常列出、不可选，并给「打开」的去处。
	Imported          bool
	ImportedSessionID string
}

// ScanIssueView 是一档答不出的理由。**Backend 为空 = 设备级**（整台机器联系不上，
// 或者设备级连接失败）。
type ScanIssueView struct {
	Backend string
	Status  string
	Reason  string
}

type CandidatesView struct {
	Candidates []CandidateView
	Issues     []ScanIssueView
}

// GapView 是一条缺口声明（思维链加密、坏行跳过…）。文案由浏览器按 Kind 出，
// 服务端只如实转述那台机器给的计数与细节。
type GapView struct {
	Kind   string
	Count  int
	Detail string
}

// MetaView 是一份已打开转录的元信息。
type MetaView struct {
	Backend           string
	ProviderSessionID string
	Title             string
	Cwd               string
	Model             string
	Turns             int
	ToolCalls         int
	Compactions       int
	StartedAt         int64
	EndedAt           int64
	Origin            string
	Gaps              []GapView
	Imported          bool
	ImportedSessionID string
}

// FrameView 是预览转录的一帧，形状与账号镜像那条转录端点**逐字段相同**
// （seq / method / params）：浏览器那一侧因此不必为预览另开一条渲染链，
// 它喂的是与真实转录同一个归约器。
type FrameView struct {
	Seq    int64
	Method string
	Params json.RawMessage
}

type PreviewView struct {
	Meta   MetaView
	Frames []FrameView
	// PreviewedTurns 是这次真的解出来的轮数；RemainingTurns 为 -1 表示元信息里
	// 没有轮数，说不出还剩几轮 —— 不报 0，别让界面说「没有更多了」。
	PreviewedTurns int
	RemainingTurns int
}

// ImportResultView 是一次导入的结果。
type ImportResultView struct {
	// SessionID 是那台机器上这条会话的标识。AlreadyImported 为真时它是**库里那条**，
	// 未必等于浏览器这次铸的号。
	SessionID string
	// PeerFingerprint 是这条会话的发起端 —— 就是执行它的那台机器（见 Import）。
	// 浏览器拿它 + SessionID 才定位得到这条对话。
	PeerFingerprint   string
	ProviderSessionID string
	Title             string
	Cwd               string
	ImportedTurns     int
	AlreadyImported   bool
}

// ListCandidatesInput 是一次发现。DeviceID 指向账号里的一台机器；Backends 为空
// 表示「这台机器上注册的全部」。
type ListCandidatesInput struct {
	UserID     int64
	DeviceID   int64
	Backends   []string
	CwdPrefix  string
	TitleQuery string
	Limit      int
}

type PreviewInput struct {
	UserID   int64
	DeviceID int64
	Backend  string
	Locator  string
	// Turns 是这次要解几轮，<=0 走服务端默认档。
	Turns int
}

// ImportInput 是一次执行。
//
// SessionID 由**浏览器**铸（与 runtime.run 同一条规矩：会话 id 是各客户端本地自增
// 的主键，服务端与 daemon 都不发号）。标题、工作目录与 provider 会话身份不在入参里
// ——它们是那份转录自己的事实，由握着它的机器读出来写下去。
type ImportInput struct {
	UserID      int64
	DeviceID    int64
	Backend     string
	Locator     string
	SessionID   int64
	AgentSyncID string
}

// TranscriptImportPeer 是一条已经建好的连接上、导入这一族的四个方法（消费侧声明）。
//
// 入参与应答直接用 canonical 的 wire 类型：它是这个仓库里 typed 通知与摘要共用的
// 那份数据词汇（agent_session_entity / workspace_svc 都在用），再手抄一层 DTO 只会多一处
// 会漂开的字段表。**错误码不在这里**：实现方只把「机器离线」翻成上面那个哨兵，
// 其余 wire 错误（含 -32601）原样上交，本包只认哨兵。
type TranscriptImportPeer interface {
	TranscriptImportScan(context.Context, *agentrewire.TranscriptImportScanRequest) (*agentrewire.TranscriptImportScanResponse, error)
	TranscriptImportOpen(context.Context, *agentrewire.TranscriptImportOpenRequest) (*agentrewire.TranscriptImportOpenResponse, error)
	TranscriptImportTurns(context.Context, *agentrewire.TranscriptImportTurnsRequest) (*agentrewire.TranscriptImportTurnsResponse, error)
	TranscriptImportExecute(context.Context, *agentrewire.TranscriptImportExecuteRequest) (*agentrewire.TranscriptImportExecuteResponse, error)
}

// MachineImports 是本包对「够到那台机器」的全部需要（ISP）：拨一条短连接，在上面
// 发几个请求，回来时收掉。谁拨的号、怎么翻译 wire 错误码，实现方（mirror_svc）的事。
//
// 一次调用一条连接、多个方法共用：预览是 open + turns 两次调用，各拨一条等于每看
// 一条候选就多握一次手。
type MachineImports interface {
	WithPeer(ctx context.Context, userID int64, fingerprint string,
		fn func(context.Context, TranscriptImportPeer) error) error
}

// SavedSessions 是本包对「把这条会话收进账号」的全部需要（ISP）。
//
// 少了它这件功能只完成一半：镜像的范围**就是**账号保存过的那些对话，没保存的会话
// 在机器上真的建起来了，账号里却一行都没有。
type SavedSessions interface {
	// Save 收下一条对话并让镜像对它开始，幂等。
	Save(ctx context.Context, ref SessionRef) error
}

// SessionRef 指向一条对话：承载它的机器 + 发起它的那一端 + 那一端的会话标识。
// 导入这条路上两个指纹是同一个值 —— 导入由那台机器自己执行，会话也归它。
type SessionRef struct {
	UserID             int64
	MachineFingerprint string
	PeerFingerprint    string
	SessionID          string
}

type SessionImportSvc interface {
	// ListCandidates 问一台机器「你磁盘上有哪些能导的会话」。机器离线或某个后端
	// 没装时以结构化的一档随清单交回；协议错误直接返回。
	ListCandidates(ctx context.Context, in ListCandidatesInput) (*CandidatesView, error)
	// Preview 打开一条候选：元信息 + 缺口 + 前几轮真实转录（投影成与账号镜像
	// 完全同形的帧）。这一步不写任何库。
	Preview(ctx context.Context, in PreviewInput) (*PreviewView, error)
	// Import 让那台机器执行一次导入，成功后把这条会话收进账号（于是它开始镜像）。
	Import(ctx context.Context, in ImportInput) (*ImportResultView, error)
}

var defaultSvc SessionImportSvc

func Default() SessionImportSvc     { return defaultSvc }
func SetDefault(s SessionImportSvc) { defaultSvc = s }

// New 造一份实现。两个依赖都是接口，由装配处注入（DIP）。
func New(machines MachineImports, saved SavedSessions) SessionImportSvc {
	return &sessionImportSvc{machines: machines, saved: saved}
}

type sessionImportSvc struct {
	machines MachineImports
	saved    SavedSessions
}
