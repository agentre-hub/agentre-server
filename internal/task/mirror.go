package task

import (
	"context"
	"time"

	"github.com/cago-frame/cago"
	"github.com/cago-frame/cago/configs"

	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
)

// stopBudget 是收工的预算。收工要等每台机器的循环退出并交还租约，而循环可能正卡在
// 一次慢补齐里；等过头会拖住整个进程的退出，等不及则最多让那份租约多留一个 TTL。
const stopBudget = 5 * time.Second

// mirrorResident 是常驻镜像在 cago 组件生命周期里的挂钩。
//
// 它自己不建也不跟任何东西：那份常驻由装配处（internal/bootstrap）在 Redis 与中继
// 就位之后建起来并 mirror_svc.SetDefault。这里只负责**停**——cago 停止时逐个调
// CloseHandle（cago.Start 的收尾），常驻镜像因此随进程退出干净地让出手里每一份租约，
// 接手的副本不必等一整个 TTL。
type mirrorResident struct {
	// ctx 是框架启动时给的那个，收工时要用它携带的日志上下文；它到那会儿已经被
	// 取消了，所以真正等待用的是下面那份自带预算的派生 ctx。
	ctx context.Context
}

// MirrorResident 造这个组件。注册进 cago 即可：
//
//	Registry(task.MirrorResident())
func MirrorResident() cago.Component { return &mirrorResident{ctx: context.Background()} }

func (m *mirrorResident) Start(ctx context.Context, _ *configs.Config) error {
	m.ctx = ctx
	return nil
}

func (m *mirrorResident) CloseHandle() {
	sup := mirror_svc.Default()
	if sup == nil {
		// 这个部署没有装配镜像（只跑 device flow 的场合）：没有连接、也没有租约。
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(m.ctx), stopBudget)
	defer cancel()
	sup.Stop(ctx)
}
