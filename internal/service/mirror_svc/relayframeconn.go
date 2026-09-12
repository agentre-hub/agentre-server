package mirror_svc

import (
	"context"
	"io"
	"sync"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre/pkg/wire/protorpc"

	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// relayFrameConn 把中继上的一条虚拟通道适配成协议引擎认的帧传输
// （pkg/wire/protorpc.FrameConn）。
//
// 它是本仓与那个共享引擎之间唯一的接缝：引擎要的是「读一帧 / 写一帧」，而中继这一
// 侧是**推**过来的 —— 帧由 relay_svc 调 WriteMessage 交进来。所以读侧是一个信箱
// 通道，写侧是一次 ForwardClient。
//
// 请求 ID 关联、cancel、超时与通知派发都归共享引擎（pkg/wire/protorpc），本仓不在
// 这一层之上另写一份。
type relayFrameConn struct {
	ctx       context.Context
	relay     RelayDialer
	route     relay_svc.Route
	channelID string
	timeout   time.Duration

	inbox chan []byte
	done  chan struct{}
	once  sync.Once

	// detach 摘掉这条通道上的订阅。连接关闭时调用一次。
	detach func()
}

const relayInboxBuffer = 64

func newRelayFrameConn(ctx context.Context, relay RelayDialer, route relay_svc.Route, timeout time.Duration) *relayFrameConn {
	return &relayFrameConn{
		ctx: ctx, relay: relay, route: route, timeout: timeout,
		inbox: make(chan []byte, relayInboxBuffer),
		done:  make(chan struct{}),
	}
}

// ReadFrame 交出信箱里的下一帧；通道关掉之后是 io.EOF，引擎据此结束读循环。
func (c *relayFrameConn) ReadFrame() ([]byte, error) {
	select {
	case frame := <-c.inbox:
		return frame, nil
	case <-c.done:
		return nil, io.EOF
	}
}

// WriteFrame 把一帧经中继转给那台机器。
//
// 超时预算取连接级的那个值：ForwardClient 是一次跨副本投递，卡住的话调用方那边的
// per-call 预算兜不住它 —— 那条预算等的是应答，而这里卡的是发送本身。
func (c *relayFrameConn) WriteFrame(frame []byte) error {
	select {
	case <-c.done:
		return ErrConnClosed
	default:
	}
	ctx, cancel := context.WithTimeout(c.baseCtx(), c.timeout)
	defer cancel()
	return c.relay.ForwardClient(ctx, c.route, c.channelID, websocket.BinaryMessage, frame)
}

func (c *relayFrameConn) Close() error {
	c.once.Do(func() {
		close(c.done)
		if c.detach != nil {
			c.detach()
		}
	})
	return nil
}

func (c *relayFrameConn) Done() <-chan struct{} { return c.done }

// WriteMessage 实现 relay_svc.FrameWriter：中继把这条通道上收到的帧交进来。
//
// 空载荷原样忽略（中继侧用它表示「这条通道关了」，本站不据它收连接）。
func (c *relayFrameConn) WriteMessage(_ int, data []byte) error {
	if len(data) == 0 {
		return nil
	}
	select {
	case c.inbox <- data:
		return nil
	case <-c.done:
		return ErrConnClosed
	default:
		// 信箱满意味着引擎的读循环被卡住了。丢帧比阻塞中继的投递 goroutine 好：
		// 后者会把这台机器上其余通道一起堵死。丢掉的那一帧对调用方表现为一次超时，
		// 对转录表现为一次跳号，两者都有既定的补齐路径。
		logger.Ctx(c.baseCtx()).Warn("mirror relay inbox is full, dropping a frame",
			zap.String("channelId", c.channelID))
		return nil
	}
}

func (c *relayFrameConn) baseCtx() context.Context {
	if c.ctx == nil {
		return context.Background()
	}
	return c.ctx
}

// ErrConnClosed 是这条中继连接已经关掉的哨兵。
//
// 它就是协议引擎那一个,不是本仓另起的第二个:调用方拿到的「连接关了」既可能来自
// 引擎(在飞的调用被唤醒)、也可能来自本适配器(写在已关的通道上),两者若是两个哨兵,
// errors.Is 就只在一半的情况下成立。
var ErrConnClosed = protorpc.ErrConnClosed

var _ relay_svc.FrameWriter = (*relayFrameConn)(nil)
