package activity_svc

import (
	"context"
	"time"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"

	"github.com/agentre-hub/agentre-server/internal/pkg/activitystats"
	"github.com/agentre-hub/agentre-server/internal/repository/activity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
)

// Settings 组装设置页那一个面板。
//
// 已保存的对话条数取自保存名单本身（agent_session_saves），不是镜像下来的摘要
// （agent_sessions）：一条保存在离线机器上、还没来得及镜像的对话仍然是「已保存的」，
// 按摘要数它会凭空少掉一条，而那一条正是用户此刻最想确认还在不在的。
func (s *activitySvc) Settings(ctx context.Context, userID int64) (SettingsView, error) {
	settings, err := user_repo.Settings().Get(ctx, userID)
	if err != nil {
		return SettingsView{}, err
	}
	saved, err := agent_session_repo.Save().ListByUser(ctx, userID)
	if err != nil {
		return SettingsView{}, err
	}
	_, loc := activitystats.ServerZone()
	return SettingsView{
		ActivityStatsEnabled: settings.ActivityStatsEnabled,
		LastReportAt:         settings.ActivityLastPullAt,
		SavedConversations:   int64(len(saved)),
		Today:                time.Now().In(loc).Format(dayLayout),
	}, nil
}

// ReportedThrough 逐台问一次「已上报到哪一天」。
//
// 一个账号名下的机器是个位数，所以这里是 N 次单行读而不是一次批量读：一个批量方法
// 要在仓储上多一个接口方法、多一份 mock，换来的是在这个规模上量不出来的差别。真到了
// 需要批量的那天，换的是这一个函数体，接口不动。
//
// 从没上报过的机器（LatestDay 交回空串）**不进 map**：调用方据此决定不画那一段。
func (s *activitySvc) ReportedThrough(
	ctx context.Context, userID int64, fingerprints []string,
) (map[string]string, error) {
	out := make(map[string]string, len(fingerprints))
	for _, fingerprint := range fingerprints {
		day, err := activity_repo.Daily().LatestDay(ctx, userID, fingerprint)
		if err != nil {
			return nil, err
		}
		if day == "" {
			continue
		}
		out[fingerprint] = day
	}
	return out, nil
}

// SetActivityStats 写开关。
//
// 开启只写开关与那个下界：这一步没有旧数据可删，多一次 DELETE 就是一次谁也没要求的
// 全表清空。回填因此不是「当场跑一趟」而是「把下界放开」——下一轮定时拉取自然带上
// 历史，而一台此刻离线的机器几个月后回来照样补得齐（当场跑那条路会把它永久漏掉）。
//
// **关闭是两件事的一件**：开关落下，同时这个账号在 agent_activity_daily 里的全部计数
// 消失 —— 关闭确认弹层向用户明写了这一条。两次写因此放在同一个事务里同生共死：
//
//   - 删除失败而开关已经关了，就是弹层承诺的反面，而且从此没有任何入口会再去删它
//     （开关已经是关的，用户再点一次也只是把一个关着的开关又关一遍）。
//   - 开关写失败而数据已经删了，是在用户没能关掉统计的情况下把他的历史清空了。
//
// 顺序在事务里无关紧要，两条要么都在要么都不在。事务本身是必要的：这两张表没有任何
// 别的地方会把它们重新对上。
func (s *activitySvc) SetActivityStats(ctx context.Context, userID int64, enabled, backfill bool) error {
	now := time.Now().UnixMilli()
	if enabled {
		// 回填 = 没有下界（空串 = 「把你有的全给我」）；不回填 = 下界是今天。
		// 这个日界与拉取、与热力图格子的键同源，都按服务端机器所在时区切。
		floor := ""
		if !backfill {
			_, loc := activitystats.ServerZone()
			floor = time.Now().In(loc).Format(dayLayout)
		}
		return user_repo.Settings().SetActivityStats(ctx, userID, true, floor, now)
	}
	return db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		txCtx := db.WithContextDB(ctx, tx)
		if err := user_repo.Settings().SetActivityStats(txCtx, userID, false, "", now); err != nil {
			return err
		}
		// 行数不看：从没开过的账号删到 0 行也是成功，界面上不该弹一个「关闭失败」。
		_, err := activity_repo.Daily().DeleteByUser(txCtx, userID)
		return err
	})
}
