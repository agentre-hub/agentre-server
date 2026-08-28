// Package activity_entity 存账号的活跃统计：一行是「某账号、某天、某台机器、某个维度
// 组合下有几条对话」。
//
// 这个域刻意只有计数。标题、路径、对话内容在这里连列都没有——那不是省略，那是活跃
// 上报开关向用户承诺的边界本身。要加一列之前先问：它是不是又把内容带回来了。
package activity_entity

// DailyBucket 是日滚存的一行。
//
// 一条对话只落进一个维度组合，所以按任意维度子集求和都是对的：热力图只按 Day 求和，
// 三张分布卡各按自己那一维求和，同一张表两用。
//
// 五个维度上的空串都是**有含义的值**，不是缺失：ProviderKey 与 ModelKey 皆空 = 这条
// 对话跟随 Agent 绑定；ProjectSyncID 空 = 未归属项目；BackendType 空 = 发起端没报。
// 聚合时它们必须各自成组，不能被并进「未知」。
type DailyBucket struct {
	UserID int64 `gorm:"column:user_id;type:bigint;not null;primaryKey"`
	// Day 是这条会话**建立**那天的日界（"2006-01-02"），按**服务端机器时区**切。
	//
	// 一个账号下的机器可能分散在不同时区，日界只能有一套，否则同一天的活动会被劈到
	// 两格上。按建立日而不是最后活动日，是因为建立日不会走：过去那些天的计数因此是
	// 终值，回填与增量必然一致（activityrollup.Aggregate 的注释）。
	//
	// 类型是 char(10) 而不是 date，与建表迁移一致，且这一条是**载荷的一部分**：本仓
	// 所有 DSN 都带 parseTime=True，date 列会被驱动解成 time.Time，GORM 再塞进这个
	// string 字段时用 RFC3339Nano —— 一次整行读拿到的是 "2026-08-28T00:00:00+08:00"，
	// 而这个值会原样变成下一次增量拉取的 since_day 发给机器。char(10) 没有时区语义
	// 可供重新解释，那条路便不存在。
	Day             string `gorm:"column:day;type:char(10);not null;primaryKey"`
	PeerFingerprint string `gorm:"column:peer_fingerprint;type:varchar(255);not null"`
	AgentSyncID     string `gorm:"column:agent_sync_id;type:varchar(255);not null;default:''"`
	BackendType     string `gorm:"column:backend_type;type:varchar(64);not null;default:''"`
	ProviderKey     string `gorm:"column:provider_key;type:varchar(255);not null;default:''"`
	ModelKey        string `gorm:"column:model_key;type:varchar(255);not null;default:''"`
	ProjectSyncID   string `gorm:"column:project_sync_id;type:varchar(255);not null;default:''"`
	SessionCount    int32  `gorm:"column:session_count;type:int;not null;default:0"`
	Createtime      int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime      int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
	// DimsHash 是六个维度的摘要，由数据库自己算（STORED 生成列），参与主键。
	//
	// 只读：写入时必须让 GORM 跳过它。让数据库算而不是应用算，去掉的是一整类 bug——
	// 应用与数据库对「什么算同一行」产生分歧时，upsert 会静默地变成插入，计数从此翻倍。
	DimsHash []byte `gorm:"column:dims_hash;->"`
}

func (*DailyBucket) TableName() string { return "agent_activity_daily" }
