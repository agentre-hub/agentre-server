// Package task 注册所有后台任务。
package task

import (
	"context"
	"errors"
	"time"

	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/pkg/logger"
	cagosync "github.com/cago-frame/cago/pkg/sync"
	"github.com/cago-frame/cago/server/cron"
	"go.uber.org/zap"

	"agentre-server/internal/task/crontab"
)

// lockKeyPrefix 定时任务抢锁用的 Redis key 前缀，与其他业务锁隔离命名空间。
const lockKeyPrefix = "task:cron"

// Task cago FuncComponent 入口。
func Task(ctx context.Context, _ *configs.Config) error {
	_, _ = cron.Default().AddFunc("*/5 * * * *", withPeriodLock("cleanup_device_flow_codes", 4*time.Minute, crontab.CleanupDeviceFlowCodes))
	_, _ = cron.Default().AddFunc("0 * * * *", withPeriodLock("cleanup_device_tokens", 50*time.Minute, crontab.CleanupDeviceTokens))
	// 同步组的回收窗口是 30 天，一天扫一次足够，也避开业务高峰；锁的 TTL 照例
	// 略短于周期，让下一天的这一轮能重新被认领。
	_, _ = cron.Default().AddFunc("17 4 * * *", withPeriodLock("reclaim_sync_garbage", 23*time.Hour, crontab.ReclaimSyncGarbage))
	return nil
}

// withPeriodLock 用 Redis 锁把 job 限制成整个副本集每个周期只真正执行一次。
//
// 只 TryLock、不 Unlock：让锁按 TTL 自然过期（TTL 取略小于 cron 周期）。
// 锁的语义正好是「本周期已被某个副本认领」——这也是 cron 场景需要的全部语义。
// 如果这里配对 Unlock，任务一旦跑超 TTL，等它执行完调用 Unlock 时，锁可能
// 早已被下一个副本重新抢到；cago 的 UnlockKey 是无条件 DEL、不校验持有者，
// 那次 Unlock 会把别的副本刚抢到的锁删掉。
//
// 没抢到锁不是故障，是「另一个副本正在跑」的正常路径，因此这里返回 nil 而
// 不是错误：返回错误会让 cago 的 crontab 包装器（server/cron/crontab.go）
// 在每个没抢到锁的副本上打一条 "cron error"，N-1 份噪音会把真正的失败淹掉。
func withPeriodLock(key string, ttl time.Duration, job func(ctx context.Context) error) func(ctx context.Context) error {
	locker := cagosync.NewLocker(lockKeyPrefix)
	return func(ctx context.Context) error {
		if err := locker.TryLockKey(ctx, key, cagosync.WithLockTimeout(ttl)); err != nil {
			if errors.Is(err, cagosync.ErrLockOccurred) {
				return nil
			}
			logger.Ctx(ctx).Error("cron lock claim failed", zap.String("key", key), zap.Error(err))
			return err
		}
		return job(ctx)
	}
}
