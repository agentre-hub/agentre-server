package crontab

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/service/activity_svc"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// machineBudget 是一台机器分到的时间。一次拉取要拨号、握手、问一次滚存，全在中继上
// 走一个来回；卡住的那台不该占住整轮——后面那些机器的统计会一起停在昨天，而这一轮的
// 周期锁比它先到期。
const machineBudget = 30 * time.Second

// PullActivityRollups 周期性地从每台在线机器拉一份日滚存（规格 2026-08-28，RPC 56）。
//
// 「拉谁」在这里：开着活跃统计开关的账号，名下每一台还没被撤销的机器。「拉什么、
// 落哪儿、从哪一天开始」全在 activity_svc.Pull 里——包括再判一次开关，因为这一轮的
// 名单是在轮子开头读的，用户可能在中途关掉它。
//
// 没装配镜像的部署直接跳过：那不是故障，日志里也不该每个周期留一条（同
// ReconcileSessionMirrors）。
func PullActivityRollups(ctx context.Context) error {
	sup := mirror_svc.Default()
	if sup == nil {
		return nil
	}
	round := activityRound{
		machines: sup,
		presence: relay_svc.Default(),
		puller:   activity_svc.Activity(),
	}
	if err := round.run(ctx); err != nil {
		logger.Ctx(ctx).Error("pull activity rollups", zap.Error(err))
		return err
	}
	return nil
}

// activityMachines 是「拨一台机器、用完就关」这一件事。声明在这里而不是直接用
// *mirror_svc.Supervisor，是为了让这一轮的编排能在不建中继、不起连接的情况下测。
type activityMachines interface {
	WithMachine(
		ctx context.Context, userID int64, fingerprint string,
		fn func(mirror_svc.ActivityRollupClient) error,
	) error
}

// machinePresence 是「这台机器现在在不在线」。
type machinePresence interface {
	IsDaemonOnline(ctx context.Context, accountID int64, fingerprint string) (bool, error)
}

// activityPuller 是一次拉取本体。开关、天窗口、落库与上报时刻都在它后面。
type activityPuller interface {
	Pull(ctx context.Context, userID int64, peer activity_svc.ActivityPeer, peerFingerprint string) error
}

// activityRound 是一轮拉取。
type activityRound struct {
	machines activityMachines
	presence machinePresence
	puller   activityPuller
}

// run 跑一轮：开着开关的账号，名下每一台在线的机器各拉一次。
//
// 一台机器出错不打断整轮：错误逐台收集、一并上交，由调用方记一条日志（照
// mirror_svc.Reconciler.Reconcile）。离线**不算错误**——它回来时下一轮自然被拉到，
// 而这段时间的历史一直躺在它自己机器上，不会因为这一轮没问到就丢。
func (r activityRound) run(ctx context.Context) error {
	userIDs, err := user_repo.Settings().ListEnabledUserIDs(ctx)
	if err != nil {
		return fmt.Errorf("list accounts with activity stats enabled: %w", err)
	}
	if len(userIDs) == 0 {
		// 一个账号都没开：这是默认状态，日志里不该每个周期留一条。
		return nil
	}
	var (
		errs     []error
		machines int
		pulled   int
		offline  int
	)
	for _, userID := range userIDs {
		devices, err := device_repo.Device().ListByUser(ctx, userID)
		if err != nil {
			errs = append(errs, fmt.Errorf("account %d: list machines: %w", userID, err))
			continue
		}
		for _, d := range devices {
			if !d.IsActive() {
				// 撤销的意思正是「这台机器不再代表这个账号」。
				continue
			}
			machines++
			skipped, err := r.pullMachine(ctx, userID, d.Fingerprint)
			switch {
			case err != nil:
				errs = append(errs, fmt.Errorf("account %d machine %s: %w", userID, d.Fingerprint, err))
			case skipped:
				offline++
			default:
				pulled++
			}
		}
	}
	logger.Ctx(ctx).Info("crontab.PullActivityRollups: pass finished",
		zap.Int("accounts", len(userIDs)), zap.Int("machines", machines),
		zap.Int("pulled", pulled), zap.Int("offline", offline),
		zap.Int("failed", len(errs)))
	return errors.Join(errs...)
}

// pullMachine 拉一台机器，交回「这台机器是不是被跳过了」。
//
// 在线判定与拉取共用同一份预算：卡在哪一步都一样占着整轮的时间。
//
// 拨号那一刻发现机器不在了同样算跳过：在线判定与真正拨过去之间永远有一个窗口，把它
// 记成故障只会让日志里每一轮都挂着几条其实什么都没坏的错误。
func (r activityRound) pullMachine(ctx context.Context, userID int64, fingerprint string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, machineBudget)
	defer cancel()
	online, err := r.presence.IsDaemonOnline(ctx, userID, fingerprint)
	if err != nil {
		return false, fmt.Errorf("check presence: %w", err)
	}
	if !online {
		return true, nil
	}
	err = r.machines.WithMachine(ctx, userID, fingerprint,
		func(peer mirror_svc.ActivityRollupClient) error {
			// mirror_svc 与 activity_svc 各自声明了一个只含 ActivityRollup 的窄接口，
			// 结构等价因此直接过得去：滚存这条通道两端都只够得着计数，够不着转录。
			return r.puller.Pull(ctx, userID, peer, fingerprint)
		})
	if errors.Is(err, mirror_svc.ErrMachineOffline) {
		return true, nil
	}
	return false, err
}
