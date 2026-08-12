// Package sync_entity 维护工作区多端同步的账号级对象与两处账号维度状态。
//
// 分两组，语义不同：
//   - 同步组 SyncObject：项目 / 部门 / Agent / backend / 执行目标 / 成员关系 /
//     agentred 路径，以（账号, 同步标识）为身份，携带同步版本号、最后修改时间、
//     最后修改来源与删除时间，双向同步。
//   - 上报组 DeviceLocalPath：只有本机路径一类，按上报设备分命名空间，整份快照
//     替换，因此不需要删除时间与冲突元数据。
package sync_entity

// 同步组承载的对象类型。桌面端的本地自增主键不过机，跨机引用一律用同步标识
// （字符串）或 agentred 指纹表达。
const (
	KindProject         = "project"
	KindDepartment      = "department"
	KindAgent           = "agent"
	KindAgentBackend    = "agent_backend"
	KindAgentExecTarget = "agent_exec_target"
	KindProjectAgent    = "project_agent"
	KindProjectLocation = "project_location"
)

// KindValid 判断上行声明的对象类型是否属于同步组。
func KindValid(kind string) bool {
	switch kind {
	case KindProject, KindDepartment, KindAgent, KindAgentBackend,
		KindAgentExecTarget, KindProjectAgent, KindProjectLocation:
		return true
	}
	return false
}

// SyncObject 是同步组的一行。
//
// AgentredFingerprint 单独成列（而不是埋在 payload 里）有两个用处：backend 与路径
// 记录据此 join 到 devices，web 控制台不需要额外映射表；路径记录的账号内自然键
// （项目同步标识, 指纹）也建在它上面，R4b 的重复由数据库唯一约束一次性挡住。
type SyncObject struct {
	ID                  int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID              int64  `gorm:"column:user_id;type:bigint;not null"`
	Kind                string `gorm:"column:kind;type:text;not null"`
	SyncID              string `gorm:"column:sync_id;type:text;not null"`
	ProjectSyncID       string `gorm:"column:project_sync_id;type:text;not null;default:''"`
	AgentredFingerprint string `gorm:"column:agentred_fingerprint;type:text;not null;default:''"`
	Payload             string `gorm:"column:payload;type:json;not null"`
	// Version 由账号级单调序列分配，是 R4 唯一的胜负依据。
	Version int64 `gorm:"column:version;type:bigint;not null"`
	// SyncUpdatedAt 是客户端提交的最后修改时间，只用于展示与 30 天窗口计算，
	// 不参与任何胜负比较。
	SyncUpdatedAt  int64 `gorm:"column:sync_updated_at;type:bigint;not null;default:0"`
	SourceDeviceID int64 `gorm:"column:source_device_id;type:bigint;not null;default:0"`
	DeletedAt      int64 `gorm:"column:deleted_at;type:bigint;not null;default:0"`
	Createtime     int64 `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime     int64 `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*SyncObject) TableName() string { return "sync_objects" }

// IsDeleted 判断这一行是不是墓碑。
func (o *SyncObject) IsDeleted() bool { return o != nil && o.DeletedAt > 0 }

// 账号级单调递增的版本序列住在 sync_account_seqs 表里，这里**刻意没有**对应的
// entity：分配版本必须用 `INSERT … ON DUPLICATE KEY UPDATE`
// （见 sync_repo.NextVersion），一个 gorm 结构体只会引来先读后写那种用法，而先读
// 后写在多副本并发上行时会把同一个版本号发给两次上行，R4 的「较大者胜」立刻失去
// 可比性。表结构以迁移里的 DDL 为准。

// DeviceSyncState 记录每台设备最近一次**把增量消费干净**的时刻，供 R6a 判超窗口
// （见 sync_svc.Pull：只有拉回空页才刷新它）。没有这一行 = 首次登录，不算超窗口。
type DeviceSyncState struct {
	UserID     int64 `gorm:"column:user_id;primaryKey"`
	DeviceID   int64 `gorm:"column:device_id;primaryKey"`
	LastSyncAt int64 `gorm:"column:last_sync_at;type:bigint;not null;default:0"`
	Updatetime int64 `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*DeviceSyncState) TableName() string { return "sync_device_states" }

// SyncAvatar 按内容哈希存放头像正文，与设备无关。
type SyncAvatar struct {
	UserID      int64  `gorm:"column:user_id;primaryKey"`
	ContentHash string `gorm:"column:content_hash;primaryKey"`
	ContentType string `gorm:"column:content_type;type:text;not null;default:''"`
	Content     string `gorm:"column:content;type:text;not null"`
	ByteSize    int64  `gorm:"column:byte_size;type:bigint;not null;default:0"`
	Createtime  int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
}

func (*SyncAvatar) TableName() string { return "sync_avatars" }

// DeviceLocalPath 是上报组的一行：某台设备上某个项目的本机路径。
type DeviceLocalPath struct {
	UserID        int64  `gorm:"column:user_id;primaryKey"`
	DeviceID      int64  `gorm:"column:device_id;primaryKey"`
	ProjectSyncID string `gorm:"column:project_sync_id;primaryKey"`
	Path          string `gorm:"column:path;type:text;not null"`
	Updatetime    int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*DeviceLocalPath) TableName() string { return "device_local_paths" }
