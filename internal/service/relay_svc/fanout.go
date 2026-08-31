package relay_svc

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// 一条 daemon 链路上的转发**不能**跑在读循环上。
//
// 读循环此前是「读一帧 → 同步转发 → 才读下一帧」（relay_ctr 的 Relay.Daemon）。而
// 转发在跨副本时要等一次 Redis 投递回执，于是一台机器上**所有会话的每一个 token**
// 都排在同一条队里：A 会话慢一下，B 会话跟着停。这就是它按虚拟通道分派的全部理由。
//
// 通道**之内**仍然是单 goroutine，所以保序 —— 分派解的是通道之间的队头阻塞，不是
// 把一条会话的帧打乱。客户端的 seq 闸门依赖这一点。
//
// 同一条纪律在这个产品里已经有两处实现：daemon 侧 connRegistry 的 asyncNotifier
// （每订阅者一条队列），以及桌面端 chat_svc 的 deliverPeerPending。这是第三处。

var errFanoutClosed = errors.New("relay daemon fanout is closed")

const (
	// channelQueueDepth 是每条虚拟通道的投递缓冲深度。
	//
	// 队列只在目的地**慢**的时候才会涨：目的地死了的话，熔断
	// （unreachableInstanceTTL）会让每一帧立刻失败，队列反而排空得飞快。
	channelQueueDepth = 256

	// channelIdleTimeout 之后没有新帧，这条通道的 worker 就收工。
	//
	// 通道是短命的（一条对应一个客户端连接），而这一侧看不到通道关闭事件：
	// channelID 是**别的副本**上的 AttachClient 生成的，它断开时没有任何东西通知
	// 得到这里。所以只能靠闲置回收，否则一条长跑的 daemon 链路会攒下一堆再也用不到
	// 的 worker。下一帧到来时照常重建，代价只是一个 goroutine。
	channelIdleTimeout = time.Minute
)

// daemonFanout 是一条 daemon 连接上「按虚拟通道分派转发」的那一层。
// 生命周期跟着 AttachDaemon 的租约走。
type daemonFanout struct {
	forward func(ctx context.Context, channelID string, frame []byte) error
	target  Route

	mu     sync.Mutex
	queues map[string]*channelQueue
	closed bool
}

type channelQueue struct {
	frames chan []byte
	stop   chan struct{}
	once   sync.Once
}

func newDaemonFanout(
	target Route,
	forward func(ctx context.Context, channelID string, frame []byte) error,
) *daemonFanout {
	return &daemonFanout{forward: forward, target: target, queues: map[string]*channelQueue{}}
}

// enqueue 把一帧排给某条虚拟通道，**永不阻塞**。
//
// 队列满说明这条通道的目的地已经落后这么多帧了。此时把这条队列整个丢掉并让它下线：
// 既给「不阻塞」封了顶（中继是网络入口，无上限缓冲等于让对面猛灌就能撑爆本副本），
// 又把代价留在闯祸的那一条通道自己身上。
//
// 丢掉是可恢复的，而且是自愈的：通知帧上带 seq，客户端的闸门看到跳号会从游标发起
// 一次补齐；在飞的 RPC 会超时，调用方重试。下一帧到来时这条通道重建一条新队列，
// 于是一次瞬时拥塞的代价是一小段帧，而不是这条通道从此报废。
func (f *daemonFanout) enqueue(ctx context.Context, channelID string, frame []byte) error {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return errFanoutClosed
	}
	queue, ok := f.queues[channelID]
	if !ok {
		queue = &channelQueue{
			frames: make(chan []byte, channelQueueDepth),
			stop:   make(chan struct{}),
		}
		f.queues[channelID] = queue
		go f.serve(ctx, channelID, queue)
	}
	f.mu.Unlock()

	select {
	case queue.frames <- frame:
		return nil
	default:
	}

	f.retire(channelID, queue)
	logger.Ctx(ctx).Warn("relay fanout: channel queue overflowed, dropped its backlog",
		zap.Int64("userId", f.target.AccountID),
		zap.String("fingerprint", f.target.Fingerprint),
		zap.String("channel", channelID))
	return nil
}

// serve 是一条通道的投递循环。ctx 刻意不是请求的 ctx（那个在 handler 返回时就取消
// 了，而收尾要靠 stop）：这里只借它携带的日志上下文。
func (f *daemonFanout) serve(ctx context.Context, channelID string, queue *channelQueue) {
	ctx = context.WithoutCancel(ctx)
	idle := time.NewTimer(channelIdleTimeout)
	defer idle.Stop()
	for {
		select {
		case <-queue.stop:
			return
		case frame := <-queue.frames:
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(channelIdleTimeout)
			if err := f.forward(ctx, channelID, frame); err != nil {
				// 转发失败**不**拆掉这条链路：daemon 的 websocket 由所有通道共享，
				// 一个客户端断开或写失败不该连坐其它会话。这一条与从前控制器里那句
				// `if errors.Is(err, ErrForwardFailed) { continue }` 是同一个判断，
				// 只是搬到了它该在的地方。
				logger.Ctx(ctx).Debug("relay fanout: frame dropped",
					zap.String("channel", channelID), zap.Error(err))
			}
		case <-idle.C:
			if f.retireIfIdle(channelID, queue) {
				return
			}
		}
	}
}

// retireIfIdle 在确实没有积压时下线这条通道。加锁重检是必要的：判定与入队可能同时
// 发生，漏了这一步会把一条刚收到帧的队列扔掉。
func (f *daemonFanout) retireIfIdle(channelID string, queue *channelQueue) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(queue.frames) > 0 {
		return false
	}
	if f.queues[channelID] == queue {
		delete(f.queues, channelID)
	}
	queue.once.Do(func() { close(queue.stop) })
	return true
}

// retire 无条件下线一条通道（溢出时用）。按指针删除：期间可能已经重建了新的一条，
// 不能误删它。
func (f *daemonFanout) retire(channelID string, queue *channelQueue) {
	f.mu.Lock()
	if f.queues[channelID] == queue {
		delete(f.queues, channelID)
	}
	f.mu.Unlock()
	queue.once.Do(func() { close(queue.stop) })
}

// close 收掉这条 daemon 链路上的全部通道。之后 enqueue 一律拒收 —— 链路都没了，
// 再排队就是在给一条不存在的连接攒帧。
func (f *daemonFanout) close() {
	f.mu.Lock()
	f.closed = true
	queues := make([]*channelQueue, 0, len(f.queues))
	for _, queue := range f.queues {
		queues = append(queues, queue)
	}
	f.queues = map[string]*channelQueue{}
	f.mu.Unlock()
	for _, queue := range queues {
		queue.once.Do(func() { close(queue.stop) })
	}
}

// fanoutFor 取这条 daemon 链路的分派器。
//
// 按 Route 索引：一个 (账号, 指纹, 实例) 上只可能有一条当前 daemon websocket
// （帧总线的 Attach 明确保证了这一点），所以 Route 就是它的身份。
func (s *relaySvc) fanoutFor(target Route) (*daemonFanout, bool) {
	s.fanoutMu.Lock()
	defer s.fanoutMu.Unlock()
	fanout, ok := s.fanouts[target]
	return fanout, ok
}

// registerFanout 建一条链路的分派器，并交回收尾函数。
//
// 收尾按**指针**判等：重连期间旧 handler 的 detach 可能迟到，而那时新连接的分派器
// 已经登记进来了 —— 按 Route 盲删会把新连接的分派器摘掉，那台机器上所有会话当场
// 停止收帧。同一个坑帧总线的 Attach 也踩过，注释在那边。
func (s *relaySvc) registerFanout(target Route) func() {
	fanout := newDaemonFanout(target, func(ctx context.Context, channelID string, frame []byte) error {
		return s.forward(ctx, target, PeerDaemon, channelID, websocket.BinaryMessage, frame)
	})
	s.fanoutMu.Lock()
	s.fanouts[target] = fanout
	s.fanoutMu.Unlock()
	return func() {
		s.fanoutMu.Lock()
		if s.fanouts[target] == fanout {
			delete(s.fanouts, target)
		}
		s.fanoutMu.Unlock()
		fanout.close()
	}
}
