package crontab

import (
	"context"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
)

// ReconcileSessionMirrors 周期性地对账：承载着已保存对话的机器，在线却没人跟的，
// 认领下来（规格 2026-08-18-server-session-mirror「镜像的范围与写入路径」）。
// 扫哪些机器、怎么认领都在 mirror_svc 里，这里只负责按周期触发。
//
// 没装配镜像的部署直接跳过：那不是故障，日志里也不该每个周期留一条。
func ReconcileSessionMirrors(ctx context.Context) error {
	sup := mirror_svc.Default()
	if sup == nil {
		return nil
	}
	if err := mirror_svc.NewReconciler(sup).Reconcile(ctx); err != nil {
		logger.Ctx(ctx).Error("reconcile session mirrors", zap.Error(err))
		return err
	}
	return nil
}

// ReplayPendingSessionDeletes 周期性地把攒下的删除待办补做掉：删除在机器离线时照样
// 生效，server 那一份当场就没了，执行端那一份欠在待办里等它回来（规格
// 2026-08-18-server-session-mirror 决策 6：「那台机器记一条待办，它下次上线时执行」）。
//
// 它与上面那一轮认领分开：认领的取材是保存名单，而删掉一台离线机器上**最后**一条
// 对话之后，那台机器再也不在名单里，它欠的那条删除却还在。两者因此各扫各的表、
// 各占一把周期锁，一边出故障不带走另一边。
//
// 没装配镜像的部署直接跳过：那不是故障。
func ReplayPendingSessionDeletes(ctx context.Context) error {
	sup := mirror_svc.Default()
	if sup == nil {
		return nil
	}
	if err := mirror_svc.NewSessions(sup).ReplayPendingDeletes(ctx); err != nil {
		logger.Ctx(ctx).Error("replay pending session deletes", zap.Error(err))
		return err
	}
	return nil
}
