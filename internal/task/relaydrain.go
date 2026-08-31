package task

import (
	"context"

	"github.com/cago-frame/cago"
	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"
)

// Drainer 是「把手里的长连接逐条礼貌关掉」这件事。真实现是 api.RouterDeps
// （DrainRelays），消费者在自己这一侧声明结构等价的接口，因此这里不反向 import
// 那个包——依赖只能从上往下走一条道。
type Drainer interface {
	DrainRelays() int
}

// relayDrain 是中继与账号通道在 cago 组件生命周期里的挂钩。它自己不建任何东西，
// 只负责**停**。
type relayDrain struct {
	drainer Drainer
	ctx     context.Context
}

// RelayDrain 造这个组件。
//
// **注册位置有讲究：必须排在 mux.HTTP 之后。** cago 是按注册的**逆序**关组件的
// （cago.Start 的收尾循环），而 mux 的 Shutdown 会等每个 handler 返回 —— 中继的
// 读循环阻塞在 ReadMessage 上永远不会自己返回。排在 mux 之前注册就意味着排在它
// 之后关：那时进程已经卡在 Shutdown 里，这一步根本轮不到跑，最后只能等宽限期结束
// 被 SIGKILL，连接照样是硬断的。
//
//	RegistryCancel(mux.HTTP(deps.Router)).
//	Registry(task.RelayDrain(deps)).   // ← 在 mux 之后注册 = 在 mux 之前关
func RelayDrain(drainer Drainer) cago.Component {
	return &relayDrain{drainer: drainer, ctx: context.Background()}
}

func (d *relayDrain) Start(ctx context.Context, _ *configs.Config) error {
	d.ctx = ctx
	return nil
}

func (d *relayDrain) CloseHandle() {
	if d.drainer == nil {
		return
	}
	// 用 WithoutCancel：走到这里时框架给的那个 ctx 已经被取消了，而这一步要的
	// 只是它携带的日志上下文。排空本身不做网络等待，没有预算可言。
	ctx := context.WithoutCancel(d.ctx)
	drained := d.drainer.DrainRelays()
	logger.Ctx(ctx).Info("relay drain: told peers the server is going away",
		zap.Int("connections", drained))
}
