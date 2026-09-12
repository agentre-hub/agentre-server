// Package task 注册所有后台任务。
package task

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/pkg/logger"
	cagosync "github.com/cago-frame/cago/pkg/sync"
	"github.com/cago-frame/cago/server/cron"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/task/crontab"
)

// lockKeyPrefix 定时任务抢锁用的 Redis key 前缀，与其他业务锁隔离命名空间。
const lockKeyPrefix = "task:cron"

// Task cago FuncComponent 入口。
//
// 注册的错误一条都不许吞：它们只有两种成因（spec 写错、cron 组件的状态不对），两种
// 都是装配缺陷，而后果是某个任务**再也不跑**——清理不跑、镜像不对账、活跃统计不拉、
// 发布版本不更新，同时进程照样起来、healthz 照样 200、日志里一个字都没有。所以这里
// 把它们攒起来交给 main（它 fatal），而不是各自 `_, _ =` 掉。
func Task(ctx context.Context, _ *configs.Config) error {
	c := cron.Default()
	if c == nil {
		// 装配顺序被改动过：cron.Cron() 没注册，或者排在了本组件后面。在 nil 接口上
		// 取方法是一条 nil pointer dereference，说不出是哪一件事。
		return errors.New("register cron tasks: cron component is not ready")
	}
	var failures []error
	add := func(spec, key string, ttl time.Duration, job func(ctx context.Context) error) {
		if _, err := c.AddFunc(spec, withPeriodLock(key, ttl, job)); err != nil {
			failures = append(failures, fmt.Errorf("register cron task %s: %w", key, err))
		}
	}
	add("*/5 * * * *", "cleanup_device_flow_codes", 4*time.Minute, crontab.CleanupDeviceFlowCodes)
	add("0 * * * *", "cleanup_device_tokens", 50*time.Minute, crontab.CleanupDeviceTokens)
	// 同步组的回收窗口是 30 天，一天扫一次足够，也避开业务高峰；锁的 TTL 照例
	// 略短于周期，让下一天的这一轮能重新被认领。
	add("17 4 * * *", "reclaim_sync_garbage", 23*time.Hour, crontab.ReclaimSyncGarbage)
	// 镜像的对账每分钟一轮：机器的常驻租约是 30 秒级的，跟着某台机器的那位一旦
	// 放手（下线、租约丢了、副本退出），下一轮就得有人把它重新接上，再慢就等于
	// 那台机器上的新内容一直没人镜像。锁的 TTL 照例略短于周期。
	add("* * * * *", "reconcile_session_mirrors", 50*time.Second, crontab.ReconcileSessionMirrors)
	// 攒下的删除待办同样每分钟补做一轮：删除在机器离线时当场只清掉 server 那份，
	// 执行端那份欠着等它回来（决策 6），而「回来」就是这一轮看出来的。与上面那轮
	// 分开一把锁：它扫的是待办表而不是保存名单——删掉一台离线机器上最后一条对话
	// 之后，那台机器再也不在名单里，它欠的那条删除却还在。
	add("* * * * *", "replay_session_deletes", 50*time.Second, crontab.ReplayPendingSessionDeletes)
	// 活跃统计是日粒度的：每十分钟拉一轮足够，晚十分钟在一张按天的图上看不出来，
	// 而每分钟去问每台在线机器一遍，换来的只是同一天的计数被反复覆盖。锁的 TTL
	// 照例略短于周期。
	add("*/10 * * * *", "pull_activity_rollups", 9*time.Minute, crontab.PullActivityRollups)
	// 控制台的 latest 来源（规格 2026-09-03-client-upgrade-guidance 决策 12）：半小时
	// 一轮足够——发布本来就不是分钟级事件，缓存 TTL（release_svc.DefaultCacheTTL）
	// 比这个周期更长，端点不会在两轮之间的空档掉回「不知道」。锁的 TTL 照例略短于
	// 周期，这正是「多副本下不重复拉取」的落点：同一周期内两个副本各跑一次时，只有
	// 抢到锁的那个会真的问上游。
	add("*/30 * * * *", "pull_latest_release", 25*time.Minute, crontab.PullLatestRelease)
	return errors.Join(failures...)
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
