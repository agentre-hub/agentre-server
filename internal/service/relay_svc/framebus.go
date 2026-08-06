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

	goredis "github.com/redis/go-redis/v9"
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
	Attach(ctx context.Context, target Route, peer Peer, writer FrameWriter) (func(), error)
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
	writer FrameWriter
	mu     sync.Mutex
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

func (f *redisForwarder) Attach(ctx context.Context, target Route, peer Peer, writer FrameWriter) (func(), error) {
	if writer == nil {
		return nil, errors.New("relay frame writer is required")
	}
	local := target
	if peer == PeerClient {
		local.InstanceID = f.instanceID
	} else if target.InstanceID != f.instanceID {
		return nil, errors.New("relay daemon attached to a different instance")
	}
	stream := streamKey(local)
	attachment := &attachedPeer{writer: writer}

	f.mu.Lock()
	if f.attachments[stream] == nil {
		f.attachments[stream] = make(map[Peer]map[*attachedPeer]struct{})
	}
	if f.attachments[stream][peer] == nil {
		f.attachments[stream][peer] = make(map[*attachedPeer]struct{})
	}
	wasEmpty := len(f.attachments[stream][peer]) == 0
	f.attachments[stream][peer][attachment] = struct{}{}
	f.startConsumerLocked(stream)
	f.mu.Unlock()

	if peer == PeerClient && wasEmpty {
		if err := f.registerClient(ctx, local); err != nil {
			f.detach(stream, peer, attachment, local)
			return nil, err
		}
	}

	var once sync.Once
	return func() {
		once.Do(func() { f.detach(stream, peer, attachment, local) })
	}, nil
}

func (f *redisForwarder) Forward(ctx context.Context, target Route, source Peer, messageType int, frame []byte) error {
	var destinations []Route
	var peer Peer
	switch source {
	case PeerClient:
		destinations, peer = []Route{target}, PeerDaemon
	case PeerDaemon:
		var err error
		destinations, err = f.clientDestinations(ctx, target)
		if err != nil {
			return err
		}
		peer = PeerClient
	default:
		return fmt.Errorf("unknown relay frame source %q", source)
	}

	for _, destination := range destinations {
		if destination.InstanceID == f.instanceID {
			if err := f.deliver(streamKey(destination), peer, messageType, frame); err != nil {
				return err
			}
			continue
		}
		if err := f.publishAndWait(ctx, destination, peer, messageType, frame); err != nil {
			return err
		}
	}
	return nil
}

func (f *redisForwarder) publishAndWait(ctx context.Context, target Route, peer Peer, messageType int, frame []byte) error {
	stream := streamKey(target)
	ack, err := deliveryAckKey(stream)
	if err != nil {
		return err
	}
	if _, err := f.redis.XAdd(ctx, &goredis.XAddArgs{Stream: stream, Values: map[string]any{
		"peer": string(peer), "type": strconv.Itoa(messageType),
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

func (f *redisForwarder) consume(ctx context.Context, stream string) {
	if err := f.redis.XGroupCreateMkStream(ctx, stream, frameBusGroup, "0").Err(); err != nil && !isBusyGroup(err) {
		return
	}
	_ = f.redis.Expire(ctx, stream, f.ttl).Err()
	pending := true
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if err := f.redis.Expire(ctx, stream, f.ttl).Err(); err != nil {
			return
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
			return
		}
		for _, result := range streams {
			for _, message := range result.Messages {
				peer, messageType, frame, ack, err := decodeFrame(message.Values)
				if err == nil {
					err = f.deliver(stream, peer, messageType, frame)
				}
				if err != nil {
					pending = true
					time.Sleep(10 * time.Millisecond)
					break
				}
				if err := f.redis.XAck(ctx, stream, frameBusGroup, message.ID).Err(); err != nil {
					pending = true
					break
				}
				if err := f.redis.Set(ctx, ack, "1", f.ttl).Err(); err != nil {
					pending = true
					break
				}
			}
		}
	}
}

func (f *redisForwarder) deliver(stream string, peer Peer, messageType int, frame []byte) error {
	f.mu.Lock()
	peers := make([]*attachedPeer, 0, len(f.attachments[stream][peer]))
	for attachment := range f.attachments[stream][peer] {
		peers = append(peers, attachment)
	}
	f.mu.Unlock()
	if len(peers) == 0 {
		return fmt.Errorf("no local %s relay websocket", peer)
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
	lastPeer := len(attachments) == 0
	if lastPeer {
		delete(f.attachments[stream], peer)
	}
	if len(f.attachments[stream]) == 0 {
		delete(f.attachments, stream)
		if cancel, ok := f.consumers[stream]; ok {
			cancel()
			delete(f.consumers, stream)
		}
	}
	f.mu.Unlock()

	if peer == PeerClient && lastPeer {
		f.unregisterClient(local)
	}
	if lastPeer {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = f.redis.XGroupDelConsumer(cleanupCtx, stream, frameBusGroup, f.instanceID).Err()
		_ = f.redis.Expire(cleanupCtx, stream, f.ttl).Err()
	}
}

func (f *redisForwarder) registerClient(ctx context.Context, target Route) error {
	presence := clientPresenceKey(target)
	if err := f.redis.Set(ctx, presence, target.InstanceID, f.ttl).Err(); err != nil {
		return fmt.Errorf("register relay client presence: %w", err)
	}
	if err := f.redis.SAdd(ctx, clientInstancesKey(target), target.InstanceID).Err(); err != nil {
		return fmt.Errorf("register relay client instance: %w", err)
	}
	f.mu.Lock()
	if _, ok := f.presence[presence]; !ok {
		presenceCtx, cancel := context.WithCancel(context.Background())
		f.presence[presence] = cancel
		go f.renewClientPresence(presenceCtx, target)
	}
	f.mu.Unlock()
	return nil
}

func (f *redisForwarder) renewClientPresence(ctx context.Context, target Route) {
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
			_ = f.redis.Set(ctx, clientPresenceKey(target), target.InstanceID, f.ttl).Err()
		}
	}
}

func (f *redisForwarder) unregisterClient(target Route) {
	presence := clientPresenceKey(target)
	f.mu.Lock()
	if cancel, ok := f.presence[presence]; ok {
		cancel()
		delete(f.presence, presence)
	}
	f.mu.Unlock()
	cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = f.redis.Del(cleanupCtx, presence).Err()
	_ = f.redis.SRem(cleanupCtx, clientInstancesKey(target), target.InstanceID).Err()
}

func (f *redisForwarder) clientDestinations(ctx context.Context, target Route) ([]Route, error) {
	instances, err := f.redis.SMembers(ctx, clientInstancesKey(target)).Result()
	if err != nil {
		return nil, fmt.Errorf("list relay client instances: %w", err)
	}
	destinations := make([]Route, 0, len(instances))
	for _, instanceID := range instances {
		local := target
		local.InstanceID = instanceID
		if err := f.redis.Get(ctx, clientPresenceKey(local)).Err(); errors.Is(err, goredis.Nil) {
			_ = f.redis.SRem(ctx, clientInstancesKey(target), instanceID).Err()
			continue
		} else if err != nil {
			return nil, fmt.Errorf("get relay client presence: %w", err)
		}
		destinations = append(destinations, local)
	}
	return destinations, nil
}

func (f *redisForwarder) hasAttachment(stream string, peer Peer) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.attachments[stream][peer]) > 0
}

func decodeFrame(values map[string]any) (Peer, int, []byte, string, error) {
	peer, ok := values["peer"].(string)
	if !ok || (Peer(peer) != PeerDaemon && Peer(peer) != PeerClient) {
		return "", 0, nil, "", errors.New("invalid relay frame peer")
	}
	messageType, err := strconv.Atoi(fmt.Sprint(values["type"]))
	if err != nil {
		return "", 0, nil, "", fmt.Errorf("invalid relay frame type: %w", err)
	}
	encoded, ok := values["frame"].(string)
	if !ok {
		return "", 0, nil, "", errors.New("invalid relay frame payload")
	}
	frame, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return "", 0, nil, "", fmt.Errorf("decode relay frame payload: %w", err)
	}
	ack, ok := values["ack"].(string)
	if !ok || ack == "" {
		return "", 0, nil, "", errors.New("missing relay frame acknowledgement")
	}
	return Peer(peer), messageType, frame, ack, nil
}

func streamKey(route Route) string {
	return fmt.Sprintf("relay:frames:%d:%s:%s", route.AccountID,
		base64.RawURLEncoding.EncodeToString([]byte(route.Fingerprint)),
		base64.RawURLEncoding.EncodeToString([]byte(route.InstanceID)))
}

func clientInstancesKey(route Route) string {
	return fmt.Sprintf("relay:clients:%d:%s", route.AccountID,
		base64.RawURLEncoding.EncodeToString([]byte(route.Fingerprint)))
}

func clientPresenceKey(route Route) string {
	return fmt.Sprintf("%s:%s", clientInstancesKey(route),
		base64.RawURLEncoding.EncodeToString([]byte(route.InstanceID)))
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
