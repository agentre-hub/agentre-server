package task

import (
	"context"
	"time"

	"github.com/cago-frame/cago"
	"github.com/cago-frame/cago/configs"

	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
)

// portForwardStopBudget 是收工的预算。收工要关掉池里每一条连接，而某条连接可能
// 还卡在拨号落定的路上；等过头会拖住整个进程的退出，等不及则那条连接的中继订阅
// 得让对端自己发现连接断了才收。
const portForwardStopBudget = 5 * time.Second

// portForwardResident 是端口转发连接池在 cago 组件生命周期里的挂钩。
//
// 它自己不建也不跟任何东西：那份池由装配处（internal/bootstrap）建起来并
// portforward_svc.SetDefault。这里只负责**停**——cago 停止时逐个调 CloseHandle
// （cago.Start 的收尾），池因此随进程退出关掉手里每一条连接，此后 Acquire 一律
// 拿 ErrStopped，不会有连接和中继订阅悬到进程被 SIGKILL。
type portForwardResident struct {
	// ctx 是框架启动时给的那个，收工时要用它携带的日志上下文；它到那会儿已经被
	// 取消了，所以真正等待用的是下面那份自带预算的派生 ctx。
	ctx context.Context
}

// PortForwardResident 造这个组件。注册进 cago 即可：
//
//	Registry(task.PortForwardResident())
func PortForwardResident() cago.Component {
	return &portForwardResident{ctx: context.Background()}
}

func (p *portForwardResident) Start(ctx context.Context, _ *configs.Config) error {
	p.ctx = ctx
	return nil
}

func (p *portForwardResident) CloseHandle() {
	pool := portforward_svc.Default()
	if pool == nil {
		// 这个部署没有装配端口转发池：没有连接，什么都不用停。
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(p.ctx), portForwardStopBudget)
	defer cancel()
	pool.Stop(ctx)
}
