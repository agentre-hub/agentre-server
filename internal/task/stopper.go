package task

import (
	"context"
	"time"

	"github.com/cago-frame/cago"
	"github.com/cago-frame/cago/configs"

	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
)

// StopperOnShutdown 造一个只负责**停**的 cago 组件：Start 只记下框架给的 ctx，
// CloseHandle 在这个预算内调用 stop。
//
// 收工这一步有两条规矩，与「停什么」无关，因此收在这里：真正等待用的是
// WithoutCancel 派生出来、自带预算的那个 ctx（框架给的那个到这会儿已经被取消了，
// 但它的日志上下文还要用），而 nil 检查由 stop 自己处理——这个部署可能根本没装配
// 那份常驻。等过头会拖住整个进程的退出，等不及则手里的租约 / 连接要等对端自己
// 发现才收。
type stopper struct {
	// ctx 是框架启动时给的那个，收工时要用它携带的日志上下文；它到那会儿已经被
	// 取消了，所以真正等待用的是下面那份自带预算的派生 ctx。
	ctx    context.Context
	budget time.Duration
	stop   func(ctx context.Context)
}

// StopperOnShutdown 注册进 cago 即可：Registry(task.StopperOnShutdown(...))。
func StopperOnShutdown(budget time.Duration, stop func(ctx context.Context)) cago.Component {
	return &stopper{ctx: context.Background(), budget: budget, stop: stop}
}

func (s *stopper) Start(ctx context.Context, _ *configs.Config) error {
	s.ctx = ctx
	return nil
}

func (s *stopper) CloseHandle() {
	if s.stop == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(s.ctx), s.budget)
	defer cancel()
	s.stop(ctx)
}

// stopBudget 是常驻镜像收工的预算。收工要等每台机器的循环退出并交还租约，而循环
// 可能正卡在一次慢补齐里；等过头会拖住整个进程的退出，等不及则最多让那份租约多留
// 一个 TTL。
const stopBudget = 5 * time.Second

// MirrorResident 是常驻镜像在 cago 组件生命周期里的挂钩。
//
// 它自己不建也不跟任何东西：那份常驻由装配处（internal/bootstrap）在 Redis 与中继
// 就位之后建起来并 mirror_svc.SetDefault。这里只负责停——常驻镜像因此随进程退出
// 干净地让出手里每一份租约，接手的副本不必等一整个 TTL。
func MirrorResident() cago.Component {
	return StopperOnShutdown(stopBudget, func(ctx context.Context) {
		sup := mirror_svc.Default()
		if sup == nil {
			// 这个部署没有装配镜像（只跑 device flow 的场合）：没有连接、也没有租约。
			return
		}
		sup.Stop(ctx)
	})
}

// portForwardStopBudget 是端口转发池收工的预算。收工要关掉池里每一条连接，而某条
// 连接可能还卡在拨号落定的路上；等过头会拖住整个进程的退出，等不及则那条连接的中继
// 订阅得让对端自己发现连接断了才收。
const portForwardStopBudget = 5 * time.Second

// PortForwardResident 是端口转发连接池在 cago 组件生命周期里的挂钩。
//
// 它自己不建也不跟任何东西：那份池由装配处（internal/bootstrap）建起来并
// portforward_svc.SetDefault。这里只负责停——池因此随进程退出关掉手里每一条连接，
// 此后 Acquire 一律拿 ErrStopped，不会有连接和中继订阅悬到进程被 SIGKILL。
func PortForwardResident() cago.Component {
	return StopperOnShutdown(portForwardStopBudget, func(ctx context.Context) {
		pool := portforward_svc.Default()
		if pool == nil {
			// 这个部署没有装配端口转发池：没有连接，什么都不用停。
			return
		}
		pool.Stop(ctx)
	})
}
