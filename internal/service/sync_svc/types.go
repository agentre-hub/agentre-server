package sync_svc

import "github.com/agentre-hub/agentre/pkg/syncwire"

// 处置结果与拒绝原因的词表归共享契约 pkg/syncwire 所有 —— 它们是**线上取值**:
// sync_ctr 把 PushItemResult.Reason 原样送给客户端,桌面端据它决定这一条是复活失败
// 还是记进「没能同步的改动」。本包对它们做别名,调用点不用改。
//
// 判据本身写在契约里:凡是能拒掉一条的理由,都只拒那一条。整批拒是一个永久性的堵。
const (
	PushStatusAccepted = syncwire.PushStatusAccepted
	PushStatusConflict = syncwire.PushStatusConflict
	PushStatusRejected = syncwire.PushStatusRejected
)

const (
	PushRejectReasonDeleted = syncwire.PushRejectReasonDeleted
	PushRejectReasonKind    = syncwire.PushRejectReasonKind
	PushRejectReasonPayload = syncwire.PushRejectReasonPayload
)

// PushItem 是一次上行里的一条改动。
//
// 这里没有、也不该有任何桌面端的本地自增 ID：跨机引用一律走同步标识
// （字符串）、agentred 指纹或 provider_key，载荷本身还要过 ValidatePayload。
type PushItem struct {
	Kind   string
	SyncID string
	// BaseVersion 是本端最后一次见到的同步版本号；本端新建、server 从未见过的
	// 行为 0（空）。冲突判定全靠它。
	BaseVersion int64
	// UpdatedAt 是客户端的最后修改时间。只落库供展示与 30 天窗口计算，
	// 一律不参与胜负比较。
	UpdatedAt int64
	// DeletedAt 非零表示这是一条墓碑，值是**发起端记下的删除时刻**（Unix 毫秒）。
	// 它不是布尔：时刻在桌面端库、线格式与 server 库三处本来就是时刻，压成布尔
	// 之后落地只能另行编造一个删除时间（2026-08-27-schema-overhaul.md 决策 20）。
	DeletedAt           int64
	AgentredFingerprint string
	// ScopeSyncID 见 sync_entity.SyncObject.ScopeSyncID：装什么取决于 kind。
	ScopeSyncID string
	Payload     []byte
}

type PushInput struct {
	UserID   int64
	DeviceID int64
	Items    []PushItem
}

// PushItemResult 是一条上行的处置结果。
type PushItemResult struct {
	SyncID string
	Kind   string
	// Version 是 server 为这次上行分配的新版本号；被拒时是 server 上的当前版本，
	// 本端据此知道自己落后到哪一版。
	Version int64
	Status  string
	// Reason 只在 Status 为 rejected 时有值。
	Reason string
	// OverwrittenVersion / OverwrittenOriginFingerprint / OverwrittenPayload 只在
	// Status 为 conflict 时有值：被这次上行覆盖掉的是哪一版、来自哪台机器、正文是什么。
	//
	// 正文必须由 server 带回去：上行端手上那一份是**覆盖别人的**那一份，它不持有
	// 被覆盖掉的内容。R5 承诺的「追回被覆盖的那一版」只有这一条路。
	OverwrittenVersion           int64
	OverwrittenOriginFingerprint string
	OverwrittenPayload           string
	// MergedSyncID / MergedVersion / MergedOriginFingerprint 只在 R4b 的自然键合并
	// 发生时有值：落败的那一份的同步标识、版本与来源机器，它已在 server 落墓碑。
	MergedSyncID            string
	MergedVersion           int64
	MergedOriginFingerprint string
}

type PushOutput struct {
	Results []PushItemResult
}

type PullInput struct {
	UserID   int64
	DeviceID int64
	Cursor   int64
	Limit    int
}

// PullItem 是下行的一行，墓碑也在其中（DeletedAt > 0），删除靠它到达各端。
type PullItem struct {
	Kind                string
	SyncID              string
	ScopeSyncID         string
	AgentredFingerprint string
	Payload             []byte
	Version             int64
	UpdatedAt           int64
	// OriginFingerprint 是最后一次修改来自哪台机器（决策 14）；空串 = 服务端直写。
	OriginFingerprint string
	// DeletedAt 非零 = 墓碑，值是删除时刻（Unix 毫秒，决策 20）。
	DeletedAt int64
}

type PullOutput struct {
	Items      []PullItem
	NextCursor int64
	HasMore    bool
}

// LocalPathItem 是上报组的一条：某个项目在这台设备上的本机路径。
type LocalPathItem struct {
	ProjectSyncID string
	Path          string
}

type LocalPathsInput struct {
	UserID   int64
	DeviceID int64
	Items    []LocalPathItem
}

type AvatarInput struct {
	UserID      int64
	ContentHash string
	ContentType string
	Content     string
}

type AvatarOutput struct {
	ContentHash string
	ContentType string
	Content     string
}

// ReclaimOutput 是一次周期性回收的战果：真正删掉的超期墓碑行数与无人引用的
// 头像行数。给定时任务用来判断「这一轮值不值得记一条日志」。
type ReclaimOutput struct {
	Tombstones int64
	Avatars    int64
}
