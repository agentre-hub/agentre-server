package user_entity

// Settings 是账号级设置。
//
// 它刻意不并进 User：那是身份表，隐私状态与登录凭据放在一起，每一次读账号都会顺带把
// 它带出来。
//
// 没有行 = 全部取默认值。默认必须是「关」——默认开等于替用户做了决定，而活跃上报这个
// 开关的全部意义就是「用户显式同意之后才上报」。
type Settings struct {
	UserID int64 `gorm:"column:user_id;type:bigint;not null;primaryKey"`
	// ActivityStatsEnabled 决定服务端是否向各台机器拉取日活跃计数。
	// 关闭时不仅停止拉取，已有的 agent_activity_daily 行也一并删除（关闭确认弹层里
	// 明写了这一条）。
	ActivityStatsEnabled bool `gorm:"column:activity_stats_enabled;type:boolean;not null;default:false"`
	// ActivityStatsEnabledAt 是最近一次开启的时刻（Unix 毫秒），0 = 从未开启。
	ActivityStatsEnabledAt int64 `gorm:"column:activity_stats_enabled_at;type:bigint;not null;default:0"`
	// ActivityLastPullAt 是最近一次成功拉取的时刻（Unix 毫秒），0 = 从未拉过。
	//
	// 它由 Pull 每轮写下，**不管那一轮有没有拉到桶**：界面上「最近一次上报 12 分钟前」
	// 问的是「管子还通着吗」，而一台一周没干活的机器每轮都成功上报一个空结果。
	ActivityLastPullAt int64 `gorm:"column:activity_last_pull_at;type:bigint;not null;default:0"`
	// ActivityBackfillFrom 是拉取的下界日（"2006-01-02"），在开启那一刻写死。
	//
	// **空串是有含义的值**：没有下界，也就是「把这台机器有的历史全给我」——开启弹层里
	// 勾上「一并回填」写的就是它。没勾就写当天。
	//
	// 它必须落在库里而不是当场跑一次回填：拉取的 since_day 取自「这台机器已经收到的
	// 最后一天」，一台从没上报过的机器那个值本来就是空串。少了这一列，取消回填与勾上
	// 回填跑出来的结果一模一样；而写在库里，一台当时离线的机器几个月后回来，那个下界
	// 依然在。
	ActivityBackfillFrom string `gorm:"column:activity_backfill_from;type:char(10);not null;default:''"`
	Createtime           int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime           int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*Settings) TableName() string { return "user_settings" }
