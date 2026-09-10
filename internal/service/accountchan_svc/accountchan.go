// Package accountchan_svc 是账号级实时通道的扇出：任一副本写入后，向该账号挂在
// **任意副本**上的每一条连接广播一条「同步版本推进到 V」的信号。
//
// 与中继（relay_svc）的区别是扇出拓扑，不是传输：中继是点对点——客户端指定一台
// daemon，Redis 按 (account, fingerprint) 路由到持有它的那个实例，per-target 的
// Stream 只能有一个收件人；这里是一对多广播，收件人是该账号此刻所有在线连接，
// 因此用 per-account 的 Redis Pub/Sub（决策 19）。
//
// 这条通道的设计前提是**它可以不可靠**：广播失败只记录、不回滚已经落库的写入，
// 漏帧 / 乱序 / 重复也都无害——权威永远在数据库，信号只是「该拉了」的提示。
package accountchan_svc

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/cago-frame/cago/pkg/logger"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// ErrChannelUnconfigured 由 Default() 的安全占位实现返回：从未 SetDefault() 过真实
// 实现（例如只装配了一部分 bootstrap 的测试或 handler）。与 nil 接口的区别是调用方
// 拿到一个明确的错误而不是 panic——与 relay_svc.ErrRelayUnconfigured 同一模式。
var ErrChannelUnconfigured = errors.New("account channel service is not configured")

// AccountChanSvc 是账号级实时通道的服务边界。
type AccountChanSvc interface {
	// Broadcast 把「这个账号的同步版本推进到 version」这一条信号发给该账号所有在线
	// 连接，跨副本可达。失败时调用方**记录并继续**：写入的权威性在数据库，不在通道，
	// 广播不成功最多让各端退化到 30 秒轮询。
	Broadcast(ctx context.Context, accountID int64, frame Frame) error
	// Subscribe 为一条连接开一份订阅。返回之后发出的广播必然送到这份订阅上
	// （订阅确认在这里等，不留「刚连上就漏掉一条」的窗口）。
	Subscribe(ctx context.Context, accountID int64) (Subscription, error)
}

// Subscription 是一条连接在通道上的收件口。
type Subscription interface {
	// Signals 是合并后的信号流。订阅失效（Redis 断开且重订阅失败，或 Close）时关闭，
	// 持有连接的一方据此断开 websocket——客户端重连时会主动 Pull 一次，不会丢变更。
	Signals() <-chan Frame
	// Close 收掉订阅。可重复调用。
	Close()
}

var defaultSvc AccountChanSvc

// Default 返回当前注册的实现，从未注册过时返回明确报错的占位实现而不是 nil。
func Default() AccountChanSvc {
	if defaultSvc == nil {
		return unavailableSvc{}
	}
	return defaultSvc
}

func SetDefault(s AccountChanSvc) { defaultSvc = s }

// Broadcast 把一帧交给当前注册的实现。测试照常用 SetDefault 换掉。
func Broadcast(ctx context.Context, accountID int64, frame Frame) error {
	return Default().Broadcast(ctx, accountID, frame)
}

// BroadcastBestEffort 是**同步对象**写入方该调的那一个：`sync_objects` 每一条写入
// 路径落库之后调它一次（规格「账号级实时通道」的「谁发信号」），另一端因此不必等
// 30 秒轮询。
//
// version<=0 什么都不发：没有新版本号就没有变化可广播，发一条空信号只会让在线的
// 连接白拉一页。这条规矩落实在这里而不是各写入方各记一遍（此前 sync_svc 与
// workspace_svc 各抄了一份逐字相同的实现，那是两处各漏一条规矩的机会）。
func BroadcastBestEffort(ctx context.Context, accountID, version int64) {
	if version <= 0 {
		return
	}
	broadcastBestEffort(ctx, accountID, Frame{Type: FrameTypeSyncVersion, Version: version})
}

// BroadcastSignalBestEffort 是**不带版本号**的那一类信号的入口（镜像会话变更、设备
// 上下线）。这些变更不在 `sync_objects` 的版本序列上，没有版本号可带，也不需要：
// 帧上的种类就是全部信息，收到的一端照常自己去拉。
//
// 不复用 BroadcastBestEffort：那一条会把 version<=0 直接丢掉，而且发出去的是
// `sync_version`——桌面端收到会白跑一次同步对象的 Pull。
func BroadcastSignalBestEffort(ctx context.Context, accountID int64, frameType string) {
	if frameType == "" {
		return
	}
	broadcastBestEffort(ctx, accountID, Frame{Type: frameType})
}

// broadcastBestEffort 落实两类信号共同的那一条规矩：**广播失败只记录、不回滚**
// ——写入的权威性在数据库，不在通道（规格「失败处理」）。
func broadcastBestEffort(ctx context.Context, accountID int64, frame Frame) {
	if err := Broadcast(ctx, accountID, frame); err != nil {
		logger.Ctx(ctx).Warn("account channel: broadcast signal failed",
			zap.Int64("userId", accountID), zap.String("type", frame.Type),
			zap.Int64("version", frame.Version), zap.Error(err))
	}
}

type unavailableSvc struct{}

func (unavailableSvc) Broadcast(context.Context, int64, Frame) error { return ErrChannelUnconfigured }

func (unavailableSvc) Subscribe(context.Context, int64) (Subscription, error) {
	return nil, ErrChannelUnconfigured
}

type accountChanSvc struct {
	redis *goredis.Client
}

// New 创建以 Redis Pub/Sub 为后端的实时通道。不需要实例 ID：广播不寻址到实例，
// 发布方也不关心有几个收件人。
func New(redisClient *goredis.Client) AccountChanSvc {
	return &accountChanSvc{redis: redisClient}
}

func (s *accountChanSvc) Broadcast(ctx context.Context, accountID int64, frame Frame) error {
	payload, err := frame.Encode()
	if err != nil {
		return err
	}
	if err := s.redis.Publish(ctx, signalChannel(accountID), payload).Err(); err != nil {
		return fmt.Errorf("broadcast account channel signal: %w", err)
	}
	return nil
}

func (s *accountChanSvc) Subscribe(ctx context.Context, accountID int64) (Subscription, error) {
	// 一条连接一份订阅（也就是一个 Redis 订阅连接）：账号级通道的连接数就是在线端数，
	// 换按账号共享一份订阅要引一套引用计数，收益抵不上那份并发状态。
	pubsub := s.redis.Subscribe(ctx, signalChannel(accountID))
	// 等订阅确认再返回：SUBSCRIBE 还没到 Redis 就宣告订阅成功的话，紧接着发生的
	// 那次广播会从这条连接底下溜过去，而通道不保存未送达的信号。
	if _, err := pubsub.Receive(ctx); err != nil {
		_ = pubsub.Close()
		return nil, fmt.Errorf("subscribe account channel: %w", err)
	}
	// 泵的生命周期由这份订阅界定，不跟着建连请求的 ctx 取消——连接活着的时候
	// handler 的 ctx 也活着，但清理路径上（Close）取消要由我们自己发起。
	pumpCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	sub := &redisSubscription{
		pubsub: pubsub, box: newSignalBox(), cancel: cancel, done: make(chan struct{}),
	}
	go sub.pump(pumpCtx)
	return sub, nil
}

type redisSubscription struct {
	pubsub    *goredis.PubSub
	box       *signalBox
	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once
}

func (s *redisSubscription) Signals() <-chan Frame { return s.box.signals() }

func (s *redisSubscription) Close() {
	s.closeOnce.Do(func() {
		s.cancel()
		_ = s.pubsub.Close()
	})
	<-s.done
}

// pump 是这份订阅**唯一**的生产者：从 Pub/Sub 读到什么就往信箱里塞什么。
// ReceiveMessage 自带断线重连与重订阅，它返回错误意味着订阅真的没了（Close，
// 或 ctx 结束）——那时关掉信箱，持有连接的一方据此断开，客户端重连后主动 Pull。
func (s *redisSubscription) pump(ctx context.Context) {
	defer close(s.done)
	// 泵不论因何结束都把自己的 ctx 释放掉，不必等到调用方 Close()。
	defer s.cancel()
	defer s.box.close()
	for {
		message, err := s.pubsub.ReceiveMessage(ctx)
		if err != nil {
			return
		}
		frame, err := DecodeFrame([]byte(message.Payload))
		if err != nil {
			logger.Ctx(ctx).Warn("account channel: 丢弃无法解析的信号",
				zap.String("channel", message.Channel), zap.Error(err))
			continue
		}
		s.box.offer(frame)
	}
}

// signalBoxSlots 是信箱的格数，也就是它同时压得住的信号种类数。取值比现有种类
// 宽出一截：更新的副本可能广播这个副本还不认得的种类（DecodeFrame 只要求 Type
// 非空），那些也要能一起排队，而不是把认得的挤掉。
const signalBoxSlots = 8

// signalBox 是一条连接的信箱，**每种信号各占一格**。同一种里还没被读走的那条可以
// 和新来的合并（规格「合并」）：慢客户端因此既不需要背压，也堵不住扇出。
//
// 合并只在**同种**之间发生，且取版本较大者而不是「后来的覆盖先来的」——Pub/Sub
// 不保证顺序，取最大值才不会把游标往回带。跨种类不合并：种类之间彼此无关，而
// 版本号在别的种类上没有意义，拿它去比等于随机丢一条。
//
// offer 全程持锁地「把没读走的全取出来、按种类归并、再塞回去」。那些发送一定不会
// 阻塞：取出来的最多 signalBoxSlots 条，加上新来的这一条最多也只是把某一格填满
// （同种归并掉）或多占一格，而读取方只取不放、别的写入方被锁挡在外面。
type signalBox struct {
	mu     sync.Mutex
	out    chan Frame
	closed bool
}

func newSignalBox() *signalBox {
	return &signalBox{out: make(chan Frame, signalBoxSlots)}
}

func (b *signalBox) signals() <-chan Frame { return b.out }

func (b *signalBox) offer(frame Frame) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	held := b.drainLocked()
	if pending, ok := held[frame.Type]; ok && pending.Version > frame.Version {
		frame = pending
	}
	held[frame.Type] = frame
	for _, f := range held {
		select {
		case b.out <- f:
		default:
			// 排到这里意味着待发种类比格子还多（只可能来自更新的副本）。丢掉一条
			// 信号是这条通道允许的失败（规格「漏帧无害」），退化成兜底轮询而已；
			// 阻塞在这里则会卡住整个扇出，那才是真正要避免的。
		}
	}
}

// drainLocked 把信箱里没读走的都取出来，按种类归并成一格一条。只在 offer 的锁内调用。
func (b *signalBox) drainLocked() map[string]Frame {
	held := make(map[string]Frame, signalBoxSlots)
	for {
		select {
		case f := <-b.out:
			if pending, ok := held[f.Type]; !ok || f.Version > pending.Version {
				held[f.Type] = f
			}
		default:
			return held
		}
	}
}

func (b *signalBox) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	close(b.out)
}

func signalChannel(accountID int64) string {
	return fmt.Sprintf("accountchan:signal:%d", accountID)
}
