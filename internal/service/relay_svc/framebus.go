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
)

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
}

type attachedPeer struct {
	channelID string
	writer    FrameWriter
	mu        sync.Mutex
}

type localDeliveryError struct {
	peer  Peer
	cause error
}

func (e *localDeliveryError) Error() string { return e.cause.Error() }
func (e *localDeliveryError) Unwrap() error { return e.cause }

// NewRedisForwarder 创建以 Redis Stream 为后端的帧总线。每个目标实例拥有
// 一个 stream；消费者只会在本实例有 websocket 附着时运行。
func NewRedisForwarder(config Config, redisClient *goredis.Client) Forwarder {
	ttl := config.OnlineTTL
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &redisForwarder{
		redis: redisClient, instanceID: config.InstanceID, ttl: ttl,
		attachments: make(map[string]map[Peer]map[*attachedPeer]struct{}),
		consumers:   make(map[string]context.CancelFunc),
		presence:    make(map[string]context.CancelFunc),
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
	if f.attachments[stream][peer] == nil {
		f.attachments[stream][peer] = make(map[*attachedPeer]struct{})
	}
	f.attachments[stream][peer][attachment] = struct{}{}
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
	var destination Route
	var peer Peer
	switch source {
	case PeerClient:
		destination, peer = target, PeerDaemon
	case PeerDaemon:
		var found bool
		var err error
		destination, found, err = f.clientDestination(ctx, target, channelID)
		if err != nil {
			return err
		}
		if !found {
			return nil
		}
		peer = PeerClient
	default:
		return fmt.Errorf("unknown relay frame source %q", source)
	}

	if destination.InstanceID == f.instanceID {
		err := f.deliver(streamKey(destination), peer, channelID, messageType, frame)
		if isDiscardableClientDeliveryError(err) {
			return nil
		}
		return err
	}
	return f.publishAndWait(ctx, destination, peer, channelID, messageType, frame)
}

func (f *redisForwarder) publishAndWait(ctx context.Context, target Route, peer Peer, channelID string, messageType int, frame []byte) error {
	stream := streamKey(target)
	ack, err := deliveryAckKey(stream)
	if err != nil {
		return err
	}
	if _, err := f.redis.XAdd(ctx, &goredis.XAddArgs{Stream: stream, Values: map[string]any{
		"peer": string(peer), "channel": channelID, "type": strconv.Itoa(messageType),
		"frame": base64.RawStdEncoding.EncodeToString(frame), "ack": ack,
	}}).Result(); err != nil {
		return fmt.Errorf("publish relay frame: %w", err)
	}
	if err := f.redis.Expire(ctx, stream, f.ttl).Err(); err != nil {
		return fmt.Errorf("expire relay stream: %w", err)
	}
	if err := f.waitForAck(ctx, ack); err != nil {
		return fmt.Errorf("confirm relay frame delivery: %w", err)
	}
	return nil
}

func (f *redisForwarder) waitForAck(ctx context.Context, ack string) error {
	ctx, cancel := context.WithTimeout(ctx, deliveryWaitTimeout)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		_, err := f.redis.Get(ctx, ack).Result()
		if err == nil {
			return nil
		}
		if !errors.Is(err, goredis.Nil) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (f *redisForwarder) startConsumerLocked(stream string) {
	if _, ok := f.consumers[stream]; ok {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	f.consumers[stream] = cancel
	go f.consume(ctx, stream)
}

// consume 的生命周期由 startConsumerLocked / detach 的 cancel 界定,**不是**由
// Redis 的健康程度界定。一次瞬时故障(主从切换 / LOADING / 读超时)若让它 return,
// f.consumers[stream] 里那条 cancel 仍然在,startConsumerLocked 因此再也不会重启它:
// daemon 的 websocket 还连着、Check 仍然通过,但跨实例来的帧从此无人消费,每一帧
// 都只能等到 deliveryWaitTimeout。所以这里退避重试,只在 ctx 结束时才真正退出。
func (f *redisForwarder) consume(ctx context.Context, stream string) {
	failures := 0
	for ctx.Err() == nil {
		if f.consumeOnce(ctx, stream) {
			failures = 0
			continue
		}
		if !sleepContext(ctx, consumerRetryDelay(failures)) {
			return
		}
		failures++
	}
}

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

// consumeOnce 跑一轮消费,返回 false 表示这一轮被 Redis 错误打断、需要退避重试。
// 重新进入时 pending 从 true 起步,先把本消费者 PEL 里没确认的帧重读一遍。
func (f *redisForwarder) consumeOnce(ctx context.Context, stream string) bool {
	if err := f.redis.XGroupCreateMkStream(ctx, stream, frameBusGroup, "0").Err(); err != nil && !isBusyGroup(err) {
		return false
	}
	_ = f.redis.Expire(ctx, stream, f.ttl).Err()
	pending := true
	for {
		select {
		case <-ctx.Done():
			return true
		default:
		}
		if err := f.redis.Expire(ctx, stream, f.ttl).Err(); err != nil {
			return false
		}
		start := ">"
		if pending {
			start, pending = "0", false
		}
		streams, err := f.redis.XReadGroup(ctx, &goredis.XReadGroupArgs{
			Group: frameBusGroup, Consumer: f.instanceID, Count: 16, Block: 100 * time.Millisecond,
			Streams: []string{stream, start},
		}).Result()
		if errors.Is(err, goredis.Nil) {
			continue
		}
		if err != nil {
			return false
		}
		for _, result := range streams {
			for _, message := range result.Messages {
				peer, channelID, messageType, frame, ack, err := decodeFrame(message.Values)
				if err == nil {
					err = f.deliver(stream, peer, channelID, messageType, frame)
				}
				if isDiscardableClientDeliveryError(err) {
					// 客户端可能在 daemon 响应到达前断开，或在写入响应时暴露出已断开。
					// 与同实例投递一致，晚到的响应视为已处理并丢弃，不能让一个已关闭
					// 通道拖断共享的 daemon websocket。
					err = nil
				}
				if err != nil {
					// 投不出去(本实例没有那一侧的 websocket)或解不开的帧,重试永远不会
					// 让它变得可投递,而发布方最多只等 deliveryWaitTimeout。把它留在 PEL
					// 里重读只会让队头堵死整条 stream:pending 被置回 true,下一轮又只读
					// "0"、又是同一条队头,">" 永远轮不到 —— 同一条 stream 上其它收件人
					// (还连着的客户端通道)的帧从此一条也进不来。所以删掉并确认它、但**不**写
					// 投递回执:发布方的 waitForAck 照常超时,如实收到转发失败。
					if ackErr := f.acknowledgeFrame(ctx, stream, message.ID, ""); ackErr != nil {
						pending = true
						break
					}
					logger.Ctx(ctx).Warn("relay frame dropped: no local delivery target",
						zap.String("stream", stream), zap.String("peer", string(peer)),
						zap.String("messageID", message.ID), zap.Error(err))
					continue
				}
				if err := f.acknowledgeFrame(ctx, stream, message.ID, ack); err != nil {
					pending = true
					break
				}
			}
		}
	}
}

func (f *redisForwarder) acknowledgeFrame(ctx context.Context, stream, messageID, ack string) error {
	_, err := f.redis.TxPipelined(ctx, func(pipe goredis.Pipeliner) error {
		pipe.XDel(ctx, stream, messageID)
		pipe.XAck(ctx, stream, frameBusGroup, messageID)
		if ack != "" {
			pipe.Set(ctx, ack, "1", f.ttl)
		}
		return nil
	})
	return err
}

func isDiscardableClientDeliveryError(err error) bool {
	var deliveryErr *localDeliveryError
	return errors.As(err, &deliveryErr) && deliveryErr.peer == PeerClient
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
		return &localDeliveryError{
			peer: peer, cause: fmt.Errorf("no local %s relay websocket", peer),
		}
	}
	for _, attachment := range peers {
		attachment.mu.Lock()
		err := attachment.writer.WriteMessage(messageType, frame)
		attachment.mu.Unlock()
		if err != nil {
			return &localDeliveryError{
				peer: peer, cause: fmt.Errorf("write relay %s frame: %w", peer, err),
			}
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
	}
	if lastForStream {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = f.redis.XGroupDelConsumer(cleanupCtx, stream, frameBusGroup, f.instanceID).Err()
		_ = f.redis.Expire(cleanupCtx, stream, f.ttl).Err()
	}
}

func (f *redisForwarder) registerClient(ctx context.Context, target Route, channelID string) error {
	presence := clientChannelKey(target, channelID)
	if err := f.redis.Set(ctx, presence, target.InstanceID, f.ttl).Err(); err != nil {
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
	interval := f.ttl / 2
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
			_ = f.redis.Expire(ctx, clientChannelKey(target, channelID), f.ttl).Err()
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

func (f *redisForwarder) clientDestination(ctx context.Context, target Route, channelID string) (Route, bool, error) {
	instanceID, err := f.redis.Get(ctx, clientChannelKey(target, channelID)).Result()
	if errors.Is(err, goredis.Nil) {
		return Route{}, false, nil
	}
	if err != nil {
		return Route{}, false, fmt.Errorf("resolve relay client channel: %w", err)
	}
	destination := target
	destination.InstanceID = instanceID
	return destination, true, nil
}

func (f *redisForwarder) hasAttachment(stream string, peer Peer) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.attachments[stream][peer]) > 0
}

func decodeFrame(values map[string]any) (Peer, string, int, []byte, string, error) {
	peer, ok := values["peer"].(string)
	if !ok || (Peer(peer) != PeerDaemon && Peer(peer) != PeerClient) {
		return "", "", 0, nil, "", errors.New("invalid relay frame peer")
	}
	channelID, ok := values["channel"].(string)
	if !ok {
		return "", "", 0, nil, "", errors.New("invalid relay frame channel")
	}
	messageType, err := strconv.Atoi(fmt.Sprint(values["type"]))
	if err != nil {
		return "", "", 0, nil, "", fmt.Errorf("invalid relay frame type: %w", err)
	}
	encoded, ok := values["frame"].(string)
	if !ok {
		return "", "", 0, nil, "", errors.New("invalid relay frame payload")
	}
	frame, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", 0, nil, "", fmt.Errorf("decode relay frame payload: %w", err)
	}
	ack, ok := values["ack"].(string)
	if !ok || ack == "" {
		return "", "", 0, nil, "", errors.New("missing relay frame acknowledgement")
	}
	return Peer(peer), channelID, messageType, frame, ack, nil
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
