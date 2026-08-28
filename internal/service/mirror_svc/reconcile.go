package mirror_svc

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
)

// releaseBudget 是巡检等一台机器收完尾的上限，见 Reconciler.unfollow。
const releaseBudget = 5 * time.Second

// Reconciler 回答 Supervisor 有意不回答的那个问题：**哪些机器该被跟上**。
//
// 它是一个周期任务，由 internal/task 按 cron 触发并用 withPeriodLock 限成整个副本集
// 每个周期只跑一次（多副本安全：2026-08-07-multi-instance-safety.md 决策 6）。那把
// 锁是「本周期已被某个副本认领」，与常驻连接自己那份可续期的租约是两回事：这里跑完
// 就结束，连接却要活得比任何合理的 TTL 都久。
//
// 每一轮都是一次完整的对账，因此它同时补上三种缺口：进程刚起来、跟着某台机器的那位
// 放手了（机器下线过、租约丢了、副本退出了）、以及某条对话保存时镜像没开起来。
type Reconciler struct {
	sup *Supervisor
}

func NewReconciler(sup *Supervisor) *Reconciler { return &Reconciler{sup: sup} }

// Reconcile 跑一轮对账：扫出承载着已保存对话的机器，在线的就认领下来（已经归本副本
// 的顺带把保存名单补齐），离线的跳过；反过来，手里那些已经不承载任何已保存对话的
// 机器一并放开。
//
// 一台机器出问题不打断整轮：错误逐台收集、一并上交，由调用方记一条日志。
func (r *Reconciler) Reconcile(ctx context.Context) error {
	machines, err := agent_session_repo.Save().ListMachines(ctx)
	if err != nil {
		return fmt.Errorf("list machines carrying saved conversations: %w", err)
	}
	var (
		errs    []error
		claimed int
		offline int
	)
	// 同一个账号名下的机器共用一次名单读取。
	byUser := make(map[int64]map[string][]SavedSession, len(machines))
	carrying := make(map[machineKey]bool, len(machines))
	for _, m := range machines {
		carrying[machineKey{userID: m.UserID, fingerprint: m.Fingerprint}] = true
	}
	for _, m := range machines {
		online, err := r.sup.relay.IsDaemonOnline(ctx, m.UserID, m.Fingerprint)
		if err != nil {
			errs = append(errs, fmt.Errorf("machine %s: check presence: %w", m.Fingerprint, err))
			continue
		}
		if !online {
			// 离线的机器不占连接也不占租约：它回来时下一轮就会被认领，而它上面那些
			// 对话的历史早就在库里，照样读得到。
			offline++
			continue
		}
		saved, ok := byUser[m.UserID]
		if !ok {
			saved, err = savedByMachine(ctx, m.UserID)
			if err != nil {
				errs = append(errs, fmt.Errorf("account %d: %w", m.UserID, err))
				continue
			}
			byUser[m.UserID] = saved
		}
		followed, err := r.sup.Follow(ctx, m.UserID, m.Fingerprint, saved[m.Fingerprint])
		if errors.Is(err, ErrStopped) {
			// 进程正在退出：这一轮就到此为止，剩下的机器留给别的副本。
			return nil
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("machine %s: %w", m.Fingerprint, err))
			continue
		}
		if followed {
			claimed++
		}
	}
	released, releaseErrs := r.releaseEmptyMachines(ctx, carrying)
	errs = append(errs, releaseErrs...)
	logger.Ctx(ctx).Info("mirror_svc.Reconcile: pass finished",
		zap.Int("machines", len(machines)), zap.Int("followed", claimed),
		zap.Int("offline", offline), zap.Int("released", released),
		zap.Int("failed", len(errs)),
		zap.String("instanceId", r.sup.cfg.InstanceID))
	return errors.Join(errs...)
}

// releaseEmptyMachines 放开本副本手里那些已经不承载任何已保存对话的机器，交回真正
// 放开的台数。
//
// 它是删除在多副本部署里的收敛点。删除那一侧只摘得到**本副本**这条连接
// （Supervisor.forgetSession），别的副本靠下一轮同步按保存名单收敛
// （Mirror.pruneUnwanted）——而删掉一台机器上**最后**一条对话之后，那台机器连
// 保存名单都不在了，同步因此永远不会再发生：那条连接会带着已经作废的跟踪继续跑，
// 下一条实时帧把刚删掉的对话原样写回账号里（决策 2 的隐私边界正是破在这里），
// 顺带还占着一份没有意义的租约与连接。
//
// 名单在这里**重读一次**而不是复用本轮开头那份快照：扫描开始之后刚保存的那一条会
// 让这台机器重新有货，拿旧快照放手会把它刚开起来的镜像又关掉。读不出来时保守地
// 留着不动——放手是有代价的（那台机器要等下一轮才有人跟），没有依据就别做。
func (r *Reconciler) releaseEmptyMachines(ctx context.Context, carrying map[machineKey]bool) (int, []error) {
	var (
		errs     []error
		released int
	)
	for _, key := range r.sup.followedMachines() {
		if carrying[key] {
			continue
		}
		saved, err := savedOnMachine(ctx, key.userID, key.fingerprint)
		if err != nil {
			errs = append(errs, fmt.Errorf("machine %s: %w", key.fingerprint, err))
			continue
		}
		if len(saved) > 0 {
			continue
		}
		r.unfollow(ctx, key)
		released++
		logger.Ctx(ctx).Info("mirror_svc.Reconcile: machine carries nothing saved, released",
			zap.Int64("userId", key.userID), zap.String("machineFingerprint", key.fingerprint),
			zap.String("instanceId", r.sup.cfg.InstanceID))
	}
	return released, errs
}

// unfollow 放开一台机器，并给「等它的循环收完尾」一个预算。
//
// 那个循环可能正卡在一次慢补齐里（一条 pull 就有 CallTimeout，页数还不封顶），而这里
// 跑在周期任务上，整轮巡检不该被一台机器无限期占住——它自己那把周期锁比这条等待短。
// 等不及就先走：叫停已经发出去了，循环仍会跑完自己的收尾把租约交还，最坏不过那份
// 租约多留一个 TTL（同 internal/task 的 stopBudget）。
func (r *Reconciler) unfollow(ctx context.Context, key machineKey) {
	releaseCtx, cancel := context.WithTimeout(ctx, releaseBudget)
	defer cancel()
	r.sup.Unfollow(releaseCtx, key.userID, key.fingerprint)
}
