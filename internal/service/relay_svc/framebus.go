package relay_svc

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

const (
	frameBusGroup       = "relay"
	deliveryWaitTimeout = 5 * time.Second
	// ackDispatchBlock 是回执分发器每次 BLPOP 的阻塞时长。它只影响「多久回一次
	// 循环顶端去看 ctx」,不影响回执的到达延迟——有回执时 BLPOP 立刻返回。
	ackDispatchBlock = time.Second
	// consumerBlock 是消费循环每次 XREADGROUP 的阻塞窗口。它只决定「空闲时多久
	// 醒一次」,不影响任何一帧的到达延迟——有帧时 XREADGROUP 立刻返回。从前这里
	// 是 100ms,于是每条 stream 空闲状态下也要恒定烧掉 10 次 XREADGROUP/秒。
	consumerBlock = 5 * time.Second
)

var errLocalTargetMissing = errors.New("local relay target is missing")

// FrameWriter 抽象 websocket 的单帧写入，使帧总线不依赖 HTTP 控制器。
type FrameWriter interface {
	WriteMessage(messageType int, data []byte) error
}

// AttachmentForwarder 是可将本地 websocket 附到帧总线的 Forwarder 扩展。
// Forwarder 本身保持任务 10 定义的构造边界不变。
type AttachmentForwarder interface {
	Attach(ctx context.Context, target Route, peer Peer, channelID string, writer FrameWriter) (func(), error)
}

type redisForwarder struct {
	redis      *goredis.Client
	instanceID string
	ttl        time.Duration

	mu          sync.Mutex
	attachments map[string]map[Peer]map[*attachedPeer]struct{}
	consumers   map[string]context.CancelFunc
	presence    map[string]context.CancelFunc

	// 等待投递回执的帧。所有在途的帧共用一条回执队列和一个分发协程,见 dispatchAcks。
	ackMu       sync.Mutex
	ackWaiters  map[string]chan struct{}
	ackDispatch bool

	// 虚拟通道 → 浏览器所在副本的本地缓存,见 clientDestination。
	routeMu  sync.Mutex
	routes   map[string]clientRoute
	routeTTL time.Duration
	now      func() time.Time

	// 投不出去的副本,见 unreachableInstanceTTL。与 routes 共用 routeMu:两者
	// 都在同一条转发路径上被读写,分两把锁只会多一次加锁。
	unreachable map[string]time.Time

	// deliveryWait 是等一帧投递回执的上限,默认 deliveryWaitTimeout。做成字段
	// 只为让用例不必真的等满 —— 超时时长本身不是那些用例要钉的东西。
	deliveryWait time.Duration
}

// clientRoute 是「这条虚拟通道的浏览器连在哪个副本」的一份本地答案,以及它何时作废。
type clientRoute struct {
	instanceID string
	expires    time.Time
}

// clientRouteCacheTTL 是这份答案的保鲜期,并且永远不超过 Redis 上那条在线登记的
// TTL —— 缓存不该比它所镜像的事实活得更久。
//
// 有了失败即失效(见 forwardToClient)之后,这个期限只是兜底:它同时管住「一条再也
// 不会被用到的通道」在 map 里赖着不走。
const clientRouteCacheTTL = 5 * time.Second

// clientRouteSweepThreshold 是顺带清理过期条目的门槛。通道是短命的,只靠「用到时
// 才发现过期」清不掉那些再也不会被问到的。
const clientRouteSweepThreshold = 1024

// unreachableInstanceTTL 是「这个副本此刻投不出去」这条判断的保鲜期,也就是熔断
// 窗口。
//
// 为什么需要它:浏览器所在的副本**崩掉**(不是正常下线)时,它来不及发那条通道关闭
// 帧,而 relay:client:* 的在线登记要到 TTL 才过期。这段窗口里 daemon 并不知道对面
// 没了,会继续推流,于是每一帧都要重新发现一次「投不出去」—— 每次一个投递超时,
// 而这条路径是 daemon 读循环上的同步调用:那台机器上所有会话一起停摆。
//
// 发现一次就够了。窗口取得比投递超时略长:短于它等于没熔断,长得多则一次瞬时抖动
// 会把一个已经恢复的副本一直拒在门外。一次成功投递立刻解除,不必等满。
const unreachableInstanceTTL = 10 * time.Second

// clientPresenceTTL 是虚拟通道在线登记(relay:client:*)的保鲜期。
//
// 它**不该**跟 daemon 在线态共用一个数,那是两件事:daemon 在线态问「这台机器还
// 连着吗」,续期靠对端的心跳;而这条登记问「这条通道的浏览器在哪个副本」,续期是
// 本副本自己的 goroutine 干的。本副本崩掉之后,这条登记就是纯粹的误导 —— daemon
// 照着它往一个死副本投,直到 TTL 到期。
//
// 所以它该短,短到什么程度由本地续期够不够得上决定(renewClientPresence 每 TTL/2
// 一次),而不是由在线态那个数决定。副本崩溃后的误导窗口因此从 30 秒缩到 10 秒;
// 窗口内的每一帧还有熔断兜着(见 unreachableInstanceTTL)。
const clientPresenceTTL = 10 * time.Second

type attachedPeer struct {
	channelID string
	writer    FrameWriter
	mu        sync.Mutex
}

// NewRedisForwarder 创建以 Redis Stream 为后端的帧总线。每个目标实例拥有
// 一个 stream；消费者只会在本实例有 websocket 附着时运行。
func NewRedisForwarder(config Config, redisClient *goredis.Client) Forwarder {
	ttl := config.OnlineTTL
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &redisForwarder{
		redis: redisClient, instanceID: config.InstanceID, ttl: ttl,
		attachments:  make(map[string]map[Peer]map[*attachedPeer]struct{}),
		consumers:    make(map[string]context.CancelFunc),
		presence:     make(map[string]context.CancelFunc),
		ackWaiters:   make(map[string]chan struct{}),
		routes:       make(map[string]clientRoute),
		routeTTL:     min(clientRouteCacheTTL, ttl),
		now:          time.Now,
		unreachable:  make(map[string]time.Time),
		deliveryWait: deliveryWaitTimeout,
	}
}

func (f *redisForwarder) Check(ctx context.Context, target Route) error {
	if err := f.redis.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("ping relay frame bus: %w", err)
	}
	if target.InstanceID == f.instanceID && !f.hasAttachment(streamKey(target), PeerDaemon) {
		return errors.New("relay daemon is not attached to this instance")
	}
	return nil
}

func (f *redisForwarder) Attach(ctx context.Context, target Route, peer Peer, channelID string, writer FrameWriter) (func(), error) {
	if writer == nil {
		return nil, errors.New("relay frame writer is required")
	}
	if peer == PeerClient && channelID == "" {
		return nil, errors.New("relay client channel ID is required")
	}
	local := target
	if peer == PeerClient {
		local.InstanceID = f.instanceID
	} else if target.InstanceID != f.instanceID {
		return nil, errors.New("relay daemon attached to a different instance")
	}
	stream := streamKey(local)
	attachment := &attachedPeer{channelID: channelID, writer: writer}

	f.mu.Lock()
	if f.attachments[stream] == nil {
		f.attachments[stream] = make(map[Peer]map[*attachedPeer]struct{})
	}
	if peer == PeerDaemon {
		// 同一(account, fingerprint, instance)只能有一条当前 daemon websocket。
		// 重连期间旧 handler 可能尚未观察到 close；若把新旧连接同时留下，浏览器帧
		// 会被广播到两边，旧连接的一次写失败便会把已经送达新连接的请求判成失败，
		// controller 随即关闭浏览器 websocket。直接换成只含新 attachment 的集合；
		// 旧 handler 迟到的 detach 按指针删除自己，不会误删新连接。
		f.attachments[stream][peer] = map[*attachedPeer]struct{}{attachment: {}}
	} else if f.attachments[stream][peer] == nil {
		f.attachments[stream][peer] = make(map[*attachedPeer]struct{})
		f.attachments[stream][peer][attachment] = struct{}{}
	} else {
		f.attachments[stream][peer][attachment] = struct{}{}
	}
	f.startConsumerLocked(stream)
	f.mu.Unlock()

	if peer == PeerClient {
		if err := f.registerClient(ctx, local, channelID); err != nil {
			f.detach(stream, peer, attachment, local)
			return nil, err
		}
	}

	var once sync.Once
	return func() {
		once.Do(func() { f.detach(stream, peer, attachment, local) })
	}, nil
}

func (f *redisForwarder) Forward(ctx context.Context, target Route, source Peer, channelID string, messageType int, frame []byte) error {
	switch source {
	case PeerClient:
		// 去往 daemon 的方向不必解析路由:daemon 就挂在 target 上。
		return f.dispatch(ctx, target, PeerDaemon, channelID, messageType, frame)
	case PeerDaemon:
		return f.forwardToClient(ctx, target, channelID, messageType, frame)
	default:
		return fmt.Errorf("unknown relay frame source %q", source)
	}
}

// dispatch 把一帧交到 destination 所在的副本:本机直投,异地经 Redis Stream 转投。
func (f *redisForwarder) dispatch(ctx context.Context, destination Route, peer Peer, channelID string, messageType int, frame []byte) error {
	if destination.InstanceID == f.instanceID {
		return f.deliver(streamKey(destination), peer, channelID, messageType, frame)
	}
	// 熔断:这个副本刚刚投不出去,窗口内直接判失败,不再进入等待。见
	// unreachableInstanceTTL。
	if f.isUnreachable(destination.InstanceID) {
		return fmt.Errorf("relay instance %q is unreachable", destination.InstanceID)
	}
	err := f.publishAndWait(ctx, destination, peer, channelID, messageType, frame)
	f.recordReachability(destination.InstanceID, err)
	return err
}

// isUnreachable 回答「这个副本此刻还在熔断窗口里吗」。过期条目顺手删掉。
func (f *redisForwarder) isUnreachable(instanceID string) bool {
	f.routeMu.Lock()
	defer f.routeMu.Unlock()
	at, ok := f.unreachable[instanceID]
	if !ok {
		return false
	}
	if f.now().Sub(at) < unreachableInstanceTTL {
		return true
	}
	delete(f.unreachable, instanceID)
	return false
}

// recordReachability 按这一次投递的成败开合熔断。成功立刻解除:副本恢复了就该
// 马上恢复投递,不必等满窗口。
func (f *redisForwarder) recordReachability(instanceID string, err error) {
	f.routeMu.Lock()
	defer f.routeMu.Unlock()
	if err == nil {
		delete(f.unreachable, instanceID)
		return
	}
	f.unreachable[instanceID] = f.now()
}

// forwardToClient 把 daemon 发来的一帧送到那条虚拟通道的浏览器那边。
//
// 这条路径由 daemon 的读循环**同步**调用,也就是说一轮流式回复的每个 token 都要走
// 一遍。它问的那个问题("这条通道的浏览器连在哪个副本")在通道存活期间不会变 ——
// channelID 是客户端 Open() 时随机生成的,一条通道对应一个客户端连接 —— 所以答案
// 缓存在本地,不必每帧押一次 Redis 往返。
//
// 缓存靠**失败自愈**保正确,而不是靠猜:投不出去就是「这份答案过期了」的信号,清掉
// 重解析一次再判成失败。这个信号是可靠的 —— 本机投递缺附着直接返回
// errLocalTargetMissing;跨副本投递时对方即便读到帧、发现本地没有收件人,也**故意
// 不写投递回执**(见 consume 里那段注释),发布方照常等到超时、如实收到失败。
// 于是陈旧至多代价一帧,不会持续错投。
func (f *redisForwarder) forwardToClient(ctx context.Context, target Route, channelID string, messageType int, frame []byte) error {
	key := clientChannelKey(target, channelID)
	// 至多两轮:第一轮可能用了缓存,第二轮一定是刚从 Redis 读回来的。
	var failed string
	for attempt := 0; attempt < 2; attempt++ {
		instanceID, cached, found, err := f.clientDestination(ctx, key)
		if err != nil {
			return err
		}
		if !found {
			return nil
		}
		// 重解析出来还是刚刚失败的那个副本:同一个答案、同一个死副本,不会有不同
		// 的结果。再投一次只是白等一个投递超时。
		if instanceID == failed {
			return fmt.Errorf("relay client instance %q is unreachable", instanceID)
		}
		destination := target
		destination.InstanceID = instanceID
		err = f.dispatch(ctx, destination, PeerClient, channelID, messageType, frame)
		if err == nil {
			return nil
		}
		failed = instanceID
		if cached {
			f.forgetClientRoute(key)
			continue
		}
		// 通道已经不在了是正常情况(浏览器刚关掉),不往上报。
		if errors.Is(err, errLocalTargetMissing) {
			return nil
		}
		return err
	}
	return nil
}

func (f *redisForwarder) publishAndWait(ctx context.Context, target Route, peer Peer, channelID string, messageType int, frame []byte) error {
	stream := streamKey(target)
	ack, err := deliveryAckKey(stream)
	if err != nil {
		return err
	}
	// 登记必须早于 XAdd,否则回执可能先于收件人到达。
	acked, release := f.registerAckWaiter(ack)
	defer release()
	// Redis Stream fields 只承载 server-internal 路由 metadata；frame 以 base64 保持
	// opaque bytes，不是 Agentre RPC envelope，也不在这里解析 Protobuf。
	// ackto 告诉收件方把回执推回哪条队列;升级前的副本不认得它,收件方会据此回落
	// 到写回执键(见 acknowledgeFrame)。
	if _, err := f.redis.XAdd(ctx, &goredis.XAddArgs{Stream: stream, Values: map[string]any{
		"peer": string(peer), "channel": channelID, "type": strconv.Itoa(messageType),
		"frame": base64.RawStdEncoding.EncodeToString(frame), "ack": ack, "ackto": f.instanceID,
	}}).Result(); err != nil {
		return fmt.Errorf("publish relay frame: %w", err)
	}
	if err := f.redis.Expire(ctx, stream, f.ttl).Err(); err != nil {
		return fmt.Errorf("expire relay stream: %w", err)
	}
	if err := f.waitForAck(ctx, f.deliveryWait, acked); err != nil {
		return fmt.Errorf("confirm relay frame delivery: %w", err)
	}
	return nil
}

// registerAckWaiter 登记一帧的回执等待,并保证本副本的回执分发协程已经在跑。
// 必须在 XAdd **之前**调用:回执队列是持久的,所以先推后收不会丢,但等待登记要
// 早于回执到达,否则分发协程找不到收件人、这一帧只能等满投递超时。
func (f *redisForwarder) registerAckWaiter(ack string) (<-chan struct{}, func()) {
	waiter := make(chan struct{})
	f.ackMu.Lock()
	f.ackWaiters[ack] = waiter
	if !f.ackDispatch {
		f.ackDispatch = true
		go f.dispatchAcks(context.Background(), ackListKey(f.instanceID))
	}
	f.ackMu.Unlock()
	return waiter, func() {
		f.ackMu.Lock()
		delete(f.ackWaiters, ack)
		f.ackMu.Unlock()
	}
}

func (f *redisForwarder) completeAck(ack string) {
	f.ackMu.Lock()
	waiter, ok := f.ackWaiters[ack]
	if ok {
		delete(f.ackWaiters, ack)
	}
	f.ackMu.Unlock()
	if ok {
		close(waiter)
	}
}

// dispatchAcks 是本副本唯一的回执接收者:所有在途的帧共用它,于是「等回执」这件事
// 无论有多少帧在飞都只占一条 Redis 连接。
//
// 回执写在一条按副本分片的**列表**上,而不是发布订阅频道上,因为列表是持久的:
// 分发协程重连的空档里到达的回执仍然在队列里等着。发布订阅换来的会是「当时没人
// 订阅就永远消失」,那一帧只能等满 deliveryWaitTimeout——而这条路径由 daemon 的
// 读循环同步调用,等满一次就是五秒的队头阻塞。
//
// 退出条件是 ctx 结束或客户端已关闭;其余错误一律退避重试,理由与 consume 相同:
// 一次瞬时故障不该让本副本从此再也收不到任何回执。
func (f *redisForwarder) dispatchAcks(ctx context.Context, key string) {
	failures := 0
	for ctx.Err() == nil {
		values, err := f.redis.BLPop(ctx, ackDispatchBlock, key).Result()
		switch {
		case err == nil:
			failures = 0
			if len(values) == 2 {
				f.completeAck(values[1])
			}
		case errors.Is(err, goredis.Nil):
			// 阻塞窗口内没有回执,正常空转。
			failures = 0
		case errors.Is(err, goredis.ErrClosed), errors.Is(err, context.Canceled):
			return
		default:
			if !sleepContext(ctx, consumerRetryDelay(failures)) {
				return
			}
			failures++
		}
	}
}

// waitForAck 等一帧的投递回执。正常路径是回执分发协程把 waiter 关掉——一次往返、
// 零轮询。从前这里是 10ms 一跳的 ticker,一帧最坏空转 500 次 GET。
func (f *redisForwarder) waitForAck(ctx context.Context, budget time.Duration, acked <-chan struct{}) error {
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	select {
	case <-acked:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (f *redisForwarder) startConsumerLocked(stream string) {
	if _, ok := f.consumers[stream]; ok {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	f.consumers[stream] = cancel
	go f.consume(ctx, stream)
	go f.renewStream(ctx, stream)
}

// renewStream 按固定节奏给 stream 续期。从前这件事挂在消费循环的每一轮上,于是
// 「续期」的频率被「阻塞窗口」绑死了:窗口一拉长,TTL 就会断。拆开之后两者各按
// 各自的道理取值——续期看 TTL,阻塞窗口看空闲开销。
//
// 与 renewClientPresence 同一形状,只是下限更低:那一处是 1 秒,而这里的 stream
// 在用例里常配 1 秒 TTL,取半再封 1 秒会正好卡在过期边界上。
func (f *redisForwarder) renewStream(ctx context.Context, stream string) {
	interval := f.ttl / 2
	if interval < 200*time.Millisecond {
		interval = 200 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = f.redis.Expire(ctx, stream, f.ttl).Err()
		}
	}
}

// consume 的生命周期由 startConsumerLocked / detach 的 cancel 界定,**不是**由
// Redis 的健康程度界定。一次瞬时故障(主从切换 / LOADING / 读超时)若让它 return,
// f.consumers[stream] 里那条 cancel 仍然在,startConsumerLocked 因此再也不会重启它:
// daemon 的 websocket 还连着、Check 仍然通过,但跨实例来的帧从此无人消费,每一帧
// 都只能等到 deliveryWaitTimeout。所以这里退避重试,只在 ctx 结束时才真正退出。
func (f *redisForwarder) consume(ctx context.Context, stream string) {
	outage := &consumerOutage{stream: stream, instanceID: f.instanceID, now: f.now}
	healthy := func() { outage.recovered(ctx) }
	for ctx.Err() == nil {
		err := f.consumeOnce(ctx, stream, healthy)
		if err == nil {
			return
		}
		// 退避时长按**本次失败之前**的计数取，与从前逐字一致：第一次失败等
		// 50ms，之后翻倍。interrupted 随后才把计数推进一格。
		retryIn := consumerRetryDelay(outage.attempts)
		outage.interrupted(ctx, err, retryIn)
		if !sleepContext(ctx, retryIn) {
			return
		}
	}
}

// consumerOutage 记一段故障的始末，并决定这段故障在日志上说几句、说到哪个级别。
//
// 分级的判据是「要不要人来看」，不是「出没出错」：
//   - 第一次失败 → Warn。退避重试本来就是为瞬时故障（主从切换 / LOADING /
//     读超时）准备的，绝大多数在毫秒级自愈，够得上「降级但已处理」。
//   - 失败累计到 consumerOutageEscalation → Error 一次。退避已经打满，说明这不是
//     抖动，跨实例的帧从此每一帧都只能等满 deliveryWaitTimeout，得有人去看 Redis。
//   - 恢复 → Info，带上试了多少次、断了多久。这一行是「这段故障已经结束」的收口，
//     没有它，Warn/Error 那两行永远读不出「后来呢」。
//
// 每段故障在每个级别上只说一行。50ms 起步的重试阶梯若逐次记账，一次十分钟的
// Redis 故障会刷出几万行，那和没有日志是同一个效果。
type consumerOutage struct {
	stream     string
	instanceID string
	now        func() time.Time
	attempts   int
	since      time.Time
}

func (o *consumerOutage) interrupted(ctx context.Context, err error, retryIn time.Duration) {
	o.attempts++
	switch o.attempts {
	case 1:
		o.since = o.now()
		logger.Ctx(ctx).Warn("relay frame bus consumer interrupted, retrying",
			zap.String("stream", o.stream), zap.String("instanceId", o.instanceID),
			zap.Duration("retryIn", retryIn), zap.Error(err))
	case consumerOutageEscalation:
		logger.Ctx(ctx).Error("relay frame bus consumer down",
			zap.String("stream", o.stream), zap.String("instanceId", o.instanceID),
			zap.Int("attempts", o.attempts),
			zap.Duration("outage", o.now().Sub(o.since)), zap.Error(err))
	}
}

// recovered 由消费循环在每一次成功的读之后调用；没有正在进行的故障时它什么也不做。
//
// 顺带把退避阶梯归零。从前那句 `failures = 0` 挂在 consumeOnce 返回 true 上，而
// 它只在 ctx 结束时才返回 true——也就是说阶梯从来没有真正重置过，一次抖动之后
// 半小时才发生的第二次抖动会直接从封顶的 1s 起步。
func (o *consumerOutage) recovered(ctx context.Context) {
	if o.attempts == 0 {
		return
	}
	logger.Ctx(ctx).Info("relay frame bus consumer recovered",
		zap.String("stream", o.stream), zap.String("instanceId", o.instanceID),
		zap.Int("attempts", o.attempts),
		zap.Duration("outage", o.now().Sub(o.since)))
	o.attempts = 0
}

// consumerOutageEscalation 是「抖动」与「挂了」之间那条线：退避阶梯打满(见
// consumerRetryDelay,第 5 次失败起固定 1s)说明这已经不是一次瞬时故障,日志从
// Warn 升到 Error。取这个数而不是随手一个常量,是为了让升级点跟着退避走——改了
// 阶梯,升级点自动还是「退避已经没得退了」那一刻。
const consumerOutageEscalation = 5

// consumerRetryDelay 是消费循环的重连退避阶梯:抖动通常是秒级的,上限压在
// deliveryWaitTimeout 以内,恢复后最多耽误一个投递窗口。
//
// 封顶判据取 max/2 —— 与本轮另外两处退避(HubLink.backoff、daemon 的
// defaultRefreshBackoff)同一形状。写成 `delay >= max` 会在翻倍**之前**判断,
// 于是 failures=5 交出 1600ms(越过自己声明的 1s 上限),failures=6 又回落到
// 1000ms:阶梯既超限又不单调。
func consumerRetryDelay(failures int) time.Duration {
	const maxDelay = time.Second
	delay := 50 * time.Millisecond
	for range failures {
		if delay >= maxDelay/2 {
			return maxDelay
		}
		delay *= 2
	}
	return delay
}

func sleepContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// consumeOnce 跑一轮消费,交回打断它的 Redis 错误;nil 表示 ctx 结束、正常收工。
// 重新进入时 pending 从 true 起步,先把本消费者 PEL 里没确认的帧重读一遍。
//
// 错误必须交回而不是就地咽掉:调用方要拿它记账并写进日志,否则一次故障在服务端的
// 全部痕迹就只剩「每一帧都等满 deliveryWaitTimeout」。onHealthy 在每一次 Redis 正常
// 应答之后调用,是「这段故障结束了」的唯一判据——建组成功不算数,那时读还没发生。
func (f *redisForwarder) consumeOnce(ctx context.Context, stream string, onHealthy func()) error {
	if err := f.redis.XGroupCreateMkStream(ctx, stream, frameBusGroup, "0").Err(); err != nil && !isBusyGroup(err) {
		return fmt.Errorf("create relay frame bus group: %w", err)
	}
	_ = f.redis.Expire(ctx, stream, f.ttl).Err()
	pending := true
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		start := ">"
		if pending {
			start, pending = "0", false
		}
		streams, err := f.redis.XReadGroup(ctx, &goredis.XReadGroupArgs{
			Group: frameBusGroup, Consumer: f.instanceID, Count: 16, Block: consumerBlock,
			Streams: []string{stream, start},
		}).Result()
		if errors.Is(err, goredis.Nil) {
			onHealthy()
			continue
		}
		if err != nil {
			return fmt.Errorf("read relay frame bus group: %w", err)
		}
		onHealthy()
		for _, result := range streams {
			for _, message := range result.Messages {
				peer, channelID, messageType, frame, ack, ackTo, err := decodeFrame(message.Values)
				if err == nil {
					err = f.deliver(stream, peer, channelID, messageType, frame)
				}
				if err != nil {
					// 本实例没有目标 websocket、目标写入失败或帧无法解码时，重试不会让当前
					// 投递变成成功，而发布方最多只等 deliveryWaitTimeout。把它留在 PEL
					// 里重读只会让队头堵死整条 stream:pending 被置回 true,下一轮又只读
					// "0"、又是同一条队头,">" 永远轮不到 —— 同一条 stream 上其它收件人
					// (还连着的客户端通道)的帧从此一条也进不来。所以删掉并确认它、但**不**写
					// 投递回执:发布方的 waitForAck 照常超时,如实收到转发失败。
					if ackErr := f.acknowledgeFrame(ctx, stream, message.ID, "", ""); ackErr != nil {
						pending = true
						break
					}
					logger.Ctx(ctx).Warn("relay frame dropped: local delivery failed",
						zap.String("stream", stream), zap.String("peer", string(peer)),
						zap.String("messageId", message.ID), zap.Error(err))
					continue
				}
				if err := f.acknowledgeFrame(ctx, stream, message.ID, ack, ackTo); err != nil {
					pending = true
					break
				}
			}
		}
	}
}

// acknowledgeFrame 删帧、确认组消费,并把投递回执交回发布方。
//
// ackTo 是发布方的实例 ID:推进它那条回执队列,发布方那个阻塞中的分发协程立刻醒来。
func (f *redisForwarder) acknowledgeFrame(ctx context.Context, stream, messageID, ack, ackTo string) error {
	_, err := f.redis.TxPipelined(ctx, func(pipe goredis.Pipeliner) error {
		pipe.XDel(ctx, stream, messageID)
		pipe.XAck(ctx, stream, frameBusGroup, messageID)
		switch {
		case ack == "":
		case ackTo != "":
			queue := ackListKey(ackTo)
			pipe.RPush(ctx, queue, ack)
			// 发布方的副本要是刚好没了,这条队列靠 TTL 收口,不会无限长下去。
			pipe.Expire(ctx, queue, f.ttl)
		}
		return nil
	})
	return err
}

func (f *redisForwarder) deliver(stream string, peer Peer, channelID string, messageType int, frame []byte) error {
	f.mu.Lock()
	peers := make([]*attachedPeer, 0, len(f.attachments[stream][peer]))
	for attachment := range f.attachments[stream][peer] {
		if peer == PeerClient && attachment.channelID != channelID {
			continue
		}
		peers = append(peers, attachment)
	}
	f.mu.Unlock()
	if len(peers) == 0 {
		return fmt.Errorf("%w: no local %s relay websocket", errLocalTargetMissing, peer)
	}
	for _, attachment := range peers {
		attachment.mu.Lock()
		err := attachment.writer.WriteMessage(messageType, frame)
		attachment.mu.Unlock()
		if err != nil {
			return fmt.Errorf("write relay %s frame: %w", peer, err)
		}
	}
	return nil
}

func (f *redisForwarder) detach(stream string, peer Peer, attachment *attachedPeer, local Route) {
	f.mu.Lock()
	attachments := f.attachments[stream][peer]
	delete(attachments, attachment)
	if len(attachments) == 0 {
		delete(f.attachments[stream], peer)
	}
	// 组内消费者的注销必须与消费 goroutine 的停止同条件。曾经用的是「这一**类**
	// 对端没了」:实例上 daemon 与客户端算出的是同一条 stream,最后一个客户端走时
	// 它就为真,于是 XGroupDelConsumer 把一个还在跑的消费者连同它的 PEL 一起删掉
	// —— 已读未确认的帧就此永久丢失,发布方只能等满 deliveryWaitTimeout。
	lastForStream := len(f.attachments[stream]) == 0
	if lastForStream {
		delete(f.attachments, stream)
		if cancel, ok := f.consumers[stream]; ok {
			cancel()
			delete(f.consumers, stream)
		}
	}
	f.mu.Unlock()

	if peer == PeerClient {
		f.unregisterClient(local, attachment.channelID)
		// 本机这条通道没了,自己的缓存先清干净;别的副本靠失败自愈与期限兜底。
		f.forgetClientRoute(clientChannelKey(local, attachment.channelID))
	}
	if lastForStream {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = f.redis.XGroupDelConsumer(cleanupCtx, stream, frameBusGroup, f.instanceID).Err()
		_ = f.redis.Expire(cleanupCtx, stream, f.ttl).Err()
	}
}

// clientTTL 是通道登记实际用的保鲜期:取 clientPresenceTTL 与本实例在线态 TTL 的
// 较小者。用例里常把 OnlineTTL 配成 1 秒来逼出过期路径,硬用 10 秒会把那些用例的
// 前提抽掉。
func (f *redisForwarder) clientTTL() time.Duration {
	return min(clientPresenceTTL, f.ttl)
}

func (f *redisForwarder) registerClient(ctx context.Context, target Route, channelID string) error {
	presence := clientChannelKey(target, channelID)
	if err := f.redis.Set(ctx, presence, target.InstanceID, f.clientTTL()).Err(); err != nil {
		return fmt.Errorf("register relay client channel: %w", err)
	}
	f.mu.Lock()
	if _, ok := f.presence[presence]; !ok {
		presenceCtx, cancel := context.WithCancel(context.Background())
		f.presence[presence] = cancel
		go f.renewClientPresence(presenceCtx, target, channelID)
	}
	f.mu.Unlock()
	return nil
}

func (f *redisForwarder) renewClientPresence(ctx context.Context, target Route, channelID string) {
	interval := f.clientTTL() / 2
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = f.redis.Expire(ctx, clientChannelKey(target, channelID), f.clientTTL()).Err()
		}
	}
}

func (f *redisForwarder) unregisterClient(target Route, channelID string) {
	presence := clientChannelKey(target, channelID)
	f.mu.Lock()
	if cancel, ok := f.presence[presence]; ok {
		cancel()
		delete(f.presence, presence)
	}
	f.mu.Unlock()
	cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = f.redis.Del(cleanupCtx, presence).Err()
}

// clientDestination 解析一条虚拟通道的浏览器落在哪个副本。cached 报告这个答案是不是
// 从本地缓存来的 —— 调用方据此决定投递失败之后值不值得重解析一次。
func (f *redisForwarder) clientDestination(ctx context.Context, key string) (instanceID string, cached, found bool, err error) {
	if id, ok := f.cachedClientRoute(key); ok {
		return id, true, true, nil
	}
	id, err := f.redis.Get(ctx, key).Result()
	if errors.Is(err, goredis.Nil) {
		return "", false, false, nil
	}
	if err != nil {
		return "", false, false, fmt.Errorf("resolve relay client channel: %w", err)
	}
	f.rememberClientRoute(key, id)
	return id, false, true, nil
}

func (f *redisForwarder) cachedClientRoute(key string) (string, bool) {
	f.routeMu.Lock()
	defer f.routeMu.Unlock()
	entry, ok := f.routes[key]
	if !ok {
		return "", false
	}
	if !f.now().Before(entry.expires) {
		delete(f.routes, key)
		return "", false
	}
	return entry.instanceID, true
}

func (f *redisForwarder) rememberClientRoute(key, instanceID string) {
	f.routeMu.Lock()
	defer f.routeMu.Unlock()
	if len(f.routes) >= clientRouteSweepThreshold {
		now := f.now()
		for k, entry := range f.routes {
			if !now.Before(entry.expires) {
				delete(f.routes, k)
			}
		}
	}
	f.routes[key] = clientRoute{instanceID: instanceID, expires: f.now().Add(f.routeTTL)}
}

func (f *redisForwarder) forgetClientRoute(key string) {
	f.routeMu.Lock()
	delete(f.routes, key)
	f.routeMu.Unlock()
}

func (f *redisForwarder) hasAttachment(stream string, peer Peer) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.attachments[stream][peer]) > 0
}

// decodeFrame 解出一条帧的路由 metadata。
func decodeFrame(values map[string]any) (Peer, string, int, []byte, string, string, error) {
	peer, ok := values["peer"].(string)
	if !ok || (Peer(peer) != PeerDaemon && Peer(peer) != PeerClient) {
		return "", "", 0, nil, "", "", errors.New("invalid relay frame peer")
	}
	channelID, ok := values["channel"].(string)
	if !ok {
		return "", "", 0, nil, "", "", errors.New("invalid relay frame channel")
	}
	messageType, err := strconv.Atoi(fmt.Sprint(values["type"]))
	if err != nil {
		return "", "", 0, nil, "", "", fmt.Errorf("invalid relay frame type: %w", err)
	}
	encoded, ok := values["frame"].(string)
	if !ok {
		return "", "", 0, nil, "", "", errors.New("invalid relay frame payload")
	}
	frame, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", 0, nil, "", "", fmt.Errorf("decode relay frame payload: %w", err)
	}
	ack, ok := values["ack"].(string)
	if !ok || ack == "" {
		return "", "", 0, nil, "", "", errors.New("missing relay frame acknowledgement")
	}
	ackTo, _ := values["ackto"].(string)
	if ackTo == "" {
		return "", "", 0, nil, "", "", errors.New("missing relay frame acknowledgement destination")
	}
	return Peer(peer), channelID, messageType, frame, ack, ackTo, nil
}

func streamKey(route Route) string {
	return fmt.Sprintf("relay:frames:%d:%s:%s", route.AccountID,
		base64.RawURLEncoding.EncodeToString([]byte(route.Fingerprint)),
		base64.RawURLEncoding.EncodeToString([]byte(route.InstanceID)))
}

func clientChannelKey(route Route, channelID string) string {
	return fmt.Sprintf("relay:client:%d:%s:%s", route.AccountID,
		base64.RawURLEncoding.EncodeToString([]byte(route.Fingerprint)),
		base64.RawURLEncoding.EncodeToString([]byte(channelID)))
}

// ackListKey 是一个副本的回执队列。按副本分片,于是每个进程只需要一条 BLPOP
// 连接就能收齐发往自己的全部回执。
func ackListKey(instanceID string) string {
	return "relay:ack:" + base64.RawURLEncoding.EncodeToString([]byte(instanceID))
}

func deliveryAckKey(stream string) (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate relay acknowledgement: %w", err)
	}
	return stream + ":ack:" + base64.RawURLEncoding.EncodeToString(random), nil
}

func isBusyGroup(err error) bool {
	return err != nil && len(err.Error()) >= len("BUSYGROUP") && err.Error()[:len("BUSYGROUP")] == "BUSYGROUP"
}

var _ Forwarder = (*redisForwarder)(nil)
var _ AttachmentForwarder = (*redisForwarder)(nil)
