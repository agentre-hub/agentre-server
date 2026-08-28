package activity_svc

import (
	"context"
	"time"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/activity_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/activitystats"
	"github.com/agentre-hub/agentre-server/internal/repository/activity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
)

// Pull 从一台机器拉一次日滚存并落库。
//
// 开关关着时**直接返回，一个字节都不发**。这是开关的全部意义 —— 「用户显式同意之后
// 才上报」。少了这一判，关掉开关的账号仍然每个周期被问一次「你今天干了什么」，而那次
// 问答本身就是上报：机器把计数交出来了，只是服务端这一侧碰巧没有落库。
//
// since_day 取这台机器已经收到的最后一天（两端都含：今天的计数在这一天里还会变，
// 排除掉最后一天等于永久丢掉那一天，而那一天通常是今天），再与账号上那个下界
// （user_settings.activity_backfill_from）取较晚的一个。空串就是「把你有的全给我」
// ——那是回填，不是另一种模式，两者的区别只有这一个字段的值。
//
// time_zone 交服务端自己的：一个账号下分散在各地的机器因此落在同一套日界上。
func (s *activitySvc) Pull(
	ctx context.Context, userID int64, peer ActivityPeer, peerFingerprint string,
) error {
	settings, err := user_repo.Settings().Get(ctx, userID)
	if err != nil {
		return err
	}
	if !settings.ActivityStatsEnabled {
		return nil
	}
	sinceDay, err := activity_repo.Daily().LatestDay(ctx, userID, peerFingerprint)
	if err != nil {
		return err
	}
	// 下界压在进度之上：一台从没上报过的机器 LatestDay 是空串，而空串的意思正是
	// 「把你有的全给我」—— 用户取消了回填，这一句就是那个选择在拉取这一侧的兑现。
	// 反过来，下界只是下界不是起点：一台已经上报到前天的机器不该被拉回开启那天重来
	// 一遍。取两者中较晚的那个，日界是 "2006-01-02"，逐字节比较恰好就是日期序。
	if settings.ActivityBackfillFrom > sinceDay {
		sinceDay = settings.ActivityBackfillFrom
	}
	zoneName, _ := activitystats.ServerZone()
	resp, err := peer.ActivityRollup(ctx, &agentrewire.ActivityRollupRequest{
		SinceDay: sinceDay,
		TimeZone: zoneName,
	})
	if err != nil {
		// 拉失败原样往上抛，一行都不落：把它当成「这台机器这一天没有活动」会用 0
		// 覆盖掉已有的计数。
		return err
	}

	now := time.Now().UnixMilli()
	buckets := make([]*activity_entity.DailyBucket, 0, len(resp.GetBuckets()))
	for _, b := range resp.GetBuckets() {
		// 逐字搬运，不做任何清洗：day 的字面形式、五个维度上空串的含义，都是对端与
		// 这张表共同的约定。在这里替对端补一个「合理」的值，只会把对端的 bug 变成
		// 一份看不出问题的错数据。账号与机器不从这里填 —— 仓储按参数钉死它们。
		buckets = append(buckets, &activity_entity.DailyBucket{
			Day:           b.GetDay(),
			AgentSyncID:   b.GetAgentSyncId(),
			BackendType:   b.GetBackendType(),
			ProviderKey:   b.GetProviderKey(),
			ModelKey:      b.GetModelKey(),
			ProjectSyncID: b.GetProjectSyncId(),
			SessionCount:  b.GetSessionCount(),
			Createtime:    now,
			Updatetime:    now,
		})
	}
	// 落库前在同一个事务里**带锁**复核一次开关。
	//
	// 开头那次判定与这里隔着整个 RPC 往返（定时任务给每台机器 30s 预算）。用户在这段
	// 时间里点了关闭：关闭那条路在一个事务里落开关并删光这个账号的计数，弹层显示成功；
	// 而这次在途的拉取随后把桶写了回去 —— 开关关着、数据还在，且从此没有任何入口会再
	// 去删它（开关已经是关的，用户再点一次也只是把一个关着的开关又关一遍）。
	//
	// 行锁让两条路在 user_settings 的同一行上排队：要么这里先落库、关闭随后连新写的
	// 一起删掉，要么关闭先提交、复核读到「关」，一行都不落。**复核为关不是错误**：
	// 用户关掉开关不该让定时任务在日志里留一条失败。
	return db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		txCtx := db.WithContextDB(ctx, tx)
		enabled, err := user_repo.Settings().ActivityStatsEnabledForUpdate(txCtx, userID)
		if err != nil {
			return err
		}
		if !enabled {
			return nil
		}
		// 交给仓储的是**同一个** sinceDay：这次答复覆盖的正是 [sinceDay, ∞) 这一段，
		// 而落库要把这一段整个换掉（维度组合变了、会话被删了，旧行都得跟着走）。
		if err := activity_repo.Daily().ReplaceBucketsFrom(
			txCtx, userID, peerFingerprint, sinceDay, buckets,
		); err != nil {
			return err
		}
		// 记下这一轮成功的时刻。**空结果也算成功**：一台一周没干活的机器每轮都正常上报
		// 一个空结果，只在拉到桶时才记时刻，界面上那句「最近一次上报」就会停在一周前，
		// 把一台完全正常的机器显示成断了——而那个数字存在的全部理由正是让用户看出管子
		// 断没断。
		return user_repo.Settings().TouchActivityPull(txCtx, userID, now)
	})
}
