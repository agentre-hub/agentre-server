package crontab

import (
	"context"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/service/release_svc"
)

// PullLatestRelease 周期性地拉一次控制台「最新发布是多少」的答案（规格
// 2026-09-03-client-upgrade-guidance「控制台呈现与 latest 来源」）。开不开、拉哪、
// 缓存多久全在 release_svc.Pull 里——包括「配置关闭」这一条判定，这里只负责按周期
// 触发，并在失败时把错误交给调用方（task.withPeriodLock 记日志）。
//
// 没装配这个服务的部署直接跳过，不是故障：与 crontab.PullActivityRollups 对
// mirror_svc.Default() 为 nil 的处理同理。
func PullLatestRelease(ctx context.Context) error {
	svc := release_svc.Release()
	if svc == nil {
		return nil
	}
	if err := svc.Pull(ctx); err != nil {
		logger.Ctx(ctx).Error("pull latest release", zap.Error(err))
		return err
	}
	return nil
}
