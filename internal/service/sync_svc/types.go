package sync_svc

// 上行单条的处置结果。
const (
	// PushStatusAccepted 基版本与该行当前版本相符（或该同步标识 server 从未见过）。
	PushStatusAccepted = "accepted"
	// PushStatusConflict 基版本与当前版本不符，或基版本为空但同步标识已存在。
	// 本次上行照常生效（R4 后到者胜），但应答里回报被覆盖的版本与来源设备，
	// 上行端据此落一条「被覆盖」记录（R5）。
	PushStatusConflict = "conflict"
	// PushStatusRejected 这一条没有生效，原因见 Reason。
	PushStatusRejected = "rejected"
)

// PushRejectReasonDeleted 是唯一的单条拒绝原因：该对象在 server 上已是墓碑。
// 删除不会被复活（R6），恢复动作因此明确失败（R5a），界面据此提供「按这份内容
// 新建」——那是一个新的同步标识，走正常上行。
const PushRejectReasonDeleted = "deleted"

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
	UpdatedAt           int64
	Deleted             bool
	AgentredFingerprint string
	ProjectSyncID       string
	Payload             []byte
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
	// OverwrittenVersion / OverwrittenDeviceID 只在 Status 为 conflict 时有值：
	// 被这次上行覆盖掉的是哪一版、来自哪台设备。
	OverwrittenVersion  int64
	OverwrittenDeviceID int64
	// MergedSyncID / MergedVersion / MergedDeviceID 只在 R4b 的自然键合并发生时
	// 有值：落败的那一份的同步标识、版本与来源设备，它已在 server 落墓碑。
	MergedSyncID   string
	MergedVersion  int64
	MergedDeviceID int64
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

// PullItem 是下行的一行，墓碑也在其中（Deleted = true），删除靠它到达各端。
type PullItem struct {
	Kind                string
	SyncID              string
	ProjectSyncID       string
	AgentredFingerprint string
	Payload             []byte
	Version             int64
	UpdatedAt           int64
	SourceDeviceID      int64
	Deleted             bool
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
