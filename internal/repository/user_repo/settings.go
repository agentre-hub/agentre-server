package user_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
)

//go:generate mockgen -source settings.go -destination mock_user_repo/mock_settings.go

// SettingsRepo 是 user_settings 的数据访问层。
//
// 它与 UserRepo 分开，理由跟实体分开是同一条：users 是身份表，隐私状态与登录凭据放在
// 一起，每一次读账号都会顺带把它带出来。
type SettingsRepo interface {
	// Get 取这个账号的设置。**没有行时交回零值，不是错误、也不是 nil。**
	//
	// 绝大多数账号从来不会有这一行——开关默认关，不开就不写——所以「查不到」是这条
	// 读路径上最常见的结果。返回值类型而不是指针，是为了让「没有 nil 这回事」成为
	// 类型上的事实：调用方想漏判也无从漏起，也就写不出「没有行就当开着」那种反面。
	//
	// 「没有行」与「读不到」仍然是两回事：连库失败原样往上抛。
	Get(ctx context.Context, userID int64) (user_entity.Settings, error)
	// SetActivityStats 写活跃统计开关。upsert：账号没有设置行是常态，不是边角。
	//
	// nowMs 同时用作开启时刻与行的时间戳。关闭时 activity_stats_enabled_at 保持不动
	// ——那一列记的是「最近一次开启的时刻」，关闭并不改变它是什么时候。
	//
	// backfillFrom 是开启这一次要写下的拉取下界日（"2006-01-02"，空串 = 没有下界 =
	// 回填全部历史）。**关闭时它被忽略**：关闭表达的是「停止上报并删掉已有计数」，
	// 不表达任何关于回填的意见，跟着一起写会把用户上一次亲手取消的回填选择翻过来。
	SetActivityStats(
		ctx context.Context, userID int64, enabled bool, backfillFrom string, nowMs int64,
	) error
	// ActivityStatsEnabledForUpdate 在事务里**带行锁**复核一次开关，供落库前使用。
	//
	// 拉取是「读开关 → 发 RPC（往返以秒计）→ 落库」。用户在往返途中关掉开关时，关闭
	// 那条路会在一个事务里落开关并删光计数，而这次在途的拉取随后把桶写了回去 ——
	// 开关是关的，数据却在，而且从此没有任何入口会再去删它（开关已经是关的，用户再点
	// 一次也只是把一个关着的开关又关一遍）。
	//
	// 行锁不能省成一次普通读：两条路碰的是 user_settings 的同一行，锁让它们排队 ——
	// 要么拉取先落库、关闭随后连新写的一起删掉，要么关闭先提交、复核读到「关」，一行
	// 都不落。普通读只是把窗口从几秒缩到几微秒。
	//
	// 没有行 = 从没开过 = 关，与 Get 同一条约定。
	ActivityStatsEnabledForUpdate(ctx context.Context, userID int64) (bool, error)
	// ListEnabledUserIDs 交出所有开着活跃统计的账号 id，供定时拉取取材。
	//
	// 过滤写在 SQL 里而不是「全表扫回来再在 Go 里判」：这让「没同意过的账号一台机器
	// 都不会被拨」成为这条路径的结构，而不是某个 if 的正确性。
	//
	// 谁都没开过是最常见的部署，那时交回空切片而不是错误——否则定时任务每个周期都会
	// 在日志里把一个完全正常的状态报成故障。
	ListEnabledUserIDs(ctx context.Context) ([]int64, error)
	// TouchActivityPull 记下最近一次**成功拉取**的时刻。
	//
	// 它只碰 activity_last_pull_at：拉取每轮都跑，一旦顺手写了开关本身，某一次并发写
	// 就会把用户刚关掉的开关重新打开——而那是一个隐私开关。
	//
	// 每一次成功都写，不管那一轮有没有拉到桶：界面上「最近一次上报 12 分钟前」问的是
	// 「管子还通着吗」，而一台一周没干活的机器每轮都成功上报一个空结果。
	TouchActivityPull(ctx context.Context, userID int64, nowMs int64) error
}

var defaultSettings SettingsRepo

func Settings() SettingsRepo          { return defaultSettings }
func RegisterSettings(i SettingsRepo) { defaultSettings = i }
func NewSettings() SettingsRepo       { return &settingsRepo{} }

type settingsRepo struct{}

// Get 用 Limit(1).Find 而不是 First：First 在没有行时返回 ErrRecordNotFound，而这里
// 「没有行」是主路径（默认关就不写行），把主路径走成错误分支只会让每个调用方再判一次
// RecordNotFound——本仓已经为这个样板付过一次代价（见 dbutil.FindOne 的注释）。
// 这里连 dbutil.FindOne 都不用：它的约定是「查不到返回 nil」，而这个方法的约定恰好是
// 「查不到返回默认值」，套上去只会多一层把 nil 翻译回零值的代码。
//
// UserID 由这里填而不是靠数据库交回：没有行时它本来就没被扫进来，而调用方拿着这个零值
// 去渲染设置页，得知道这是谁的设置。
func (s *settingsRepo) Get(ctx context.Context, userID int64) (user_entity.Settings, error) {
	out := user_entity.Settings{}
	if err := db.Ctx(ctx).Where("user_id=?", userID).Limit(1).Find(&out).Error; err != nil {
		return user_entity.Settings{}, err
	}
	out.UserID = userID
	return out, nil
}

// SetActivityStats 是一条语句的 upsert。
//
// 不写成「先查再插或改」：账号没有设置行是主路径，两个副本上会双双查空、双双 INSERT，
// 竞败方撞主键拿到一个约束错误——用户点一下开关看到 500。
// user_settings 上只有主键这一个唯一键，所以 ON DUPLICATE KEY UPDATE 命中的必然是它
// （docs/architecture.md「只在表恰好一个唯一键时安全」）。
//
// 赋值列随 enabled 变：关闭时 activity_stats_enabled_at 不在里面。那一列的含义是
// 「最近一次开启的时刻」，跟着一起写就会把它抹成 0，而 0 的含义是「从未开启」——
// 一个开过又关掉的账号从此与一个从没开过的账号在数据上完全一样。这条判断压在这里
// 而不是交给调用方传值，是因为它是这一行自身的不变量而不是某个调用方的业务选择。
//
// createtime 不在赋值列里：命中已有行时保留首次落地的时间。
func (s *settingsRepo) SetActivityStats(
	ctx context.Context, userID int64, enabled bool, backfillFrom string, nowMs int64,
) error {
	enabledAt := int64(0)
	floor := ""
	assign := []string{"activity_stats_enabled", "updatetime"}
	if enabled {
		enabledAt, floor = nowMs, backfillFrom
		assign = []string{
			"activity_stats_enabled", "activity_stats_enabled_at",
			"activity_backfill_from", "updatetime",
		}
	}
	// 新插入的行在关闭时写 0 与空串：它确实从未开启过，也就没有下界可言。
	return db.Ctx(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns(assign),
	}).Create(&user_entity.Settings{
		UserID:                 userID,
		ActivityStatsEnabled:   enabled,
		ActivityStatsEnabledAt: enabledAt,
		ActivityBackfillFrom:   floor,
		Createtime:             nowMs,
		Updatetime:             nowMs,
	}).Error
}

// ListEnabledUserIDs 只取一列：这一轮要的是「拨谁」，整行读回来的其余字段没有一个会
// 被用到，而 Pull 自己会为每个账号再读一次完整设置（它要的是下界与开关的当下值，
// 而不是这一轮开头的快照）。
func (s *settingsRepo) ListEnabledUserIDs(ctx context.Context) ([]int64, error) {
	out := make([]int64, 0)
	if err := db.Ctx(ctx).Model(&user_entity.Settings{}).
		Where("activity_stats_enabled=?", true).
		Pluck("user_id", &out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

// ActivityStatsEnabledForUpdate 只取那一列：这次读的目的是拿锁与判开关，整行读回来的
// 其余字段没有一个会被用到，而 SELECT 列越少，与关闭那条路的写集重叠越小。
func (s *settingsRepo) ActivityStatsEnabledForUpdate(
	ctx context.Context, userID int64,
) (bool, error) {
	out := make([]bool, 0, 1)
	if err := db.Ctx(ctx).Model(&user_entity.Settings{}).
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id=?", userID).Limit(1).
		Pluck("activity_stats_enabled", &out).Error; err != nil {
		return false, err
	}
	if len(out) == 0 {
		return false, nil
	}
	return out[0], nil
}

func (s *settingsRepo) TouchActivityPull(ctx context.Context, userID int64, nowMs int64) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"activity_last_pull_at", "updatetime"}),
	}).Create(&user_entity.Settings{
		UserID:             userID,
		ActivityLastPullAt: nowMs,
		Createtime:         nowMs,
		Updatetime:         nowMs,
	}).Error
}
