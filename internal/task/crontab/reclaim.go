package crontab

import (
	"context"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/service/sync_svc"
)

// ReclaimSyncGarbage 周期性回收同步组的超期墓碑与无人引用的头像正文
// （决策 9、R16a）。窗口判定与「谁还引用着这份头像」都在 sync_svc 里，
// 这里只负责按周期触发。
func ReclaimSyncGarbage(ctx context.Context) error {
	if _, err := sync_svc.Default().ReclaimExpired(ctx); err != nil {
		logger.Ctx(ctx).Error("reclaim sync garbage", zap.Error(err))
		return err
	}
	return nil
}
