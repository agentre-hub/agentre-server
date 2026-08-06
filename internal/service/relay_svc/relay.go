// Package relay_svc 管理 daemon 的短暂在线态，并定义帧转发总线的服务边界。
package relay_svc

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	goredis "github.com/redis/go-redis/v9"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/repository/device_repo"
)

var (
	ErrDaemonNotFound  = errors.New("relay daemon not found")
	ErrDaemonOffline   = errors.New("relay daemon offline")
	ErrForwardFailed   = errors.New("relay forwarding failed")
	ErrDaemonForbidden = errors.New("relay daemon forbidden")
)

var defaultSvc RelaySvc

func Default() RelaySvc     { return defaultSvc }
func SetDefault(s RelaySvc) { defaultSvc = s }

// Config 是中转在线态的运行期参数。
type Config struct {
	InstanceID string
	OnlineTTL  time.Duration
}

// Route 是 Redis 寻址记录和帧总线共同使用的目标。
type Route struct {
	AccountID   int64
	Fingerprint string
	InstanceID  string
}

// Peer 标识帧从 daemon 或客户端一侧进入总线。
type Peer string

const (
	PeerDaemon Peer = "daemon"
	PeerClient Peer = "client"
)

// Forwarder 是任务 11 实现的 Redis 帧总线边界。Check 必须在 websocket
// upgrade 前返回可区分的转发失败；Forward 接收已 upgrade 的二进制或文本帧。
type Forwarder interface {
	Check(ctx context.Context, target Route) error
	Forward(ctx context.Context, target Route, source Peer, channelID string, messageType int, frame []byte) error
}

type unavailableForwarder struct{}

// NewUnavailableForwarder 为显式禁用帧总线的测试或降级装配保留。它让客户端在升级
// websocket 前收到可区分的 upstream 错误，而不是建立一条无效连接。
func NewUnavailableForwarder() Forwarder { return unavailableForwarder{} }

func (unavailableForwarder) Check(context.Context, Route) error {
	return errors.New("relay frame bus is unavailable")
}

func (unavailableForwarder) Forward(context.Context, Route, Peer, string, int, []byte) error {
	// 客户端会在 Check 阶段被拒绝，因此此处只会消费 daemon 的心跳帧；
	// 禁用总线不能让它们中断 TTL 续期。
	return nil
}

// RelaySvc 协调设备归属校验、Redis 在线态与帧总线。
type RelaySvc interface {
	PrepareDaemon(ctx context.Context, accountID, deviceID int64, kind string) (Route, error)
	RegisterDaemon(ctx context.Context, route Route) error
	RenewDaemon(ctx context.Context, route Route) error
	ConnectClient(ctx context.Context, accountID int64, fingerprint string) (Route, error)
	AttachDaemon(ctx context.Context, target Route, writer FrameWriter) (func(), error)
	AttachClient(ctx context.Context, target Route, writer FrameWriter) (channelID string, detach func(), err error)
	ForwardDaemon(ctx context.Context, target Route, messageType int, frame []byte) error
	ForwardClient(ctx context.Context, target Route, channelID string, messageType int, frame []byte) error
}

type relaySvc struct {
	config    Config
	devices   device_repo.DeviceRepo
	redis     *goredis.Client
	forwarder Forwarder
}

// New 创建 RelaySvc。实例 ID 必须在每个 server 进程中唯一。
func New(config Config, devices device_repo.DeviceRepo, redisClient *goredis.Client, forwarder Forwarder) RelaySvc {
	return &relaySvc{config: config, devices: devices, redis: redisClient, forwarder: forwarder}
}

func (s *relaySvc) PrepareDaemon(ctx context.Context, accountID, deviceID int64, kind string) (Route, error) {
	if kind != device_entity.KindAgentred {
		return Route{}, ErrDaemonForbidden
	}
	device, err := s.devices.Find(ctx, deviceID)
	if err != nil {
		return Route{}, err
	}
	if device == nil || device.UserID != accountID || device.Kind != device_entity.KindAgentred || !device.IsActive() {
		return Route{}, ErrDaemonForbidden
	}
	return Route{AccountID: accountID, Fingerprint: device.Fingerprint, InstanceID: s.config.InstanceID}, nil
}

func (s *relaySvc) RegisterDaemon(ctx context.Context, route Route) error {
	if err := s.redis.Set(ctx, routeKey(route.AccountID, route.Fingerprint), route.InstanceID, s.config.OnlineTTL).Err(); err != nil {
		return fmt.Errorf("register relay daemon: %w", err)
	}
	return nil
}

func (s *relaySvc) RenewDaemon(ctx context.Context, route Route) error {
	key := routeKey(route.AccountID, route.Fingerprint)
	instanceID, err := s.redis.Get(ctx, key).Result()
	if errors.Is(err, goredis.Nil) {
		return ErrDaemonOffline
	}
	if err != nil {
		return fmt.Errorf("get relay daemon: %w", err)
	}
	if instanceID != route.InstanceID {
		return ErrDaemonOffline
	}
	if err := s.redis.Expire(ctx, key, s.config.OnlineTTL).Err(); err != nil {
		return fmt.Errorf("renew relay daemon: %w", err)
	}
	return nil
}

func (s *relaySvc) ConnectClient(ctx context.Context, accountID int64, fingerprint string) (Route, error) {
	device, err := s.devices.FindByFingerprint(ctx, accountID, fingerprint)
	if err != nil {
		return Route{}, err
	}
	if device == nil || device.Kind != device_entity.KindAgentred || !device.IsActive() {
		return Route{}, ErrDaemonNotFound
	}

	instanceID, err := s.redis.Get(ctx, routeKey(accountID, fingerprint)).Result()
	if errors.Is(err, goredis.Nil) {
		return Route{}, ErrDaemonOffline
	}
	if err != nil {
		return Route{}, fmt.Errorf("resolve relay daemon: %w", err)
	}
	route := Route{AccountID: accountID, Fingerprint: fingerprint, InstanceID: instanceID}
	if err := s.forwarder.Check(ctx, route); err != nil {
		return Route{}, fmt.Errorf("%w: %v", ErrForwardFailed, err)
	}
	return route, nil
}

func (s *relaySvc) AttachDaemon(ctx context.Context, target Route, writer FrameWriter) (func(), error) {
	return s.attach(ctx, target, PeerDaemon, "", writer)
}

func (s *relaySvc) AttachClient(ctx context.Context, target Route, writer FrameWriter) (string, func(), error) {
	channelID, err := newChannelID()
	if err != nil {
		return "", nil, err
	}
	detach, err := s.attach(ctx, target, PeerClient, channelID, writer)
	if err != nil {
		return "", nil, err
	}
	return channelID, detach, nil
}

func (s *relaySvc) attach(ctx context.Context, target Route, peer Peer, channelID string, writer FrameWriter) (func(), error) {
	forwarder, ok := s.forwarder.(AttachmentForwarder)
	if !ok {
		return nil, errors.New("relay frame bus does not support websocket attachment")
	}
	return forwarder.Attach(ctx, target, peer, channelID, writer)
}

func (s *relaySvc) ForwardDaemon(ctx context.Context, target Route, messageType int, frame []byte) error {
	if messageType != websocket.BinaryMessage {
		return errors.New("relay daemon envelope must be a binary websocket message")
	}
	channelID, innerFrame, err := unwrapEnvelope(frame)
	if err != nil {
		return fmt.Errorf("decode relay daemon envelope: %w", err)
	}
	return s.forward(ctx, target, PeerDaemon, channelID, websocket.BinaryMessage, innerFrame)
}

func (s *relaySvc) ForwardClient(ctx context.Context, target Route, channelID string, messageType int, frame []byte) error {
	envelope, err := wrapEnvelope(channelID, frame)
	if err != nil {
		return fmt.Errorf("encode relay client envelope: %w", err)
	}
	return s.forward(ctx, target, PeerClient, "", websocket.BinaryMessage, envelope)
}

func (s *relaySvc) forward(ctx context.Context, target Route, source Peer, channelID string, messageType int, frame []byte) error {
	if err := s.forwarder.Forward(ctx, target, source, channelID, messageType, frame); err != nil {
		return fmt.Errorf("%w: %v", ErrForwardFailed, err)
	}
	return nil
}

func newChannelID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate relay channel ID: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func wrapEnvelope(channelID string, frame []byte) ([]byte, error) {
	if channelID == "" {
		return nil, errors.New("relay channel ID is required")
	}
	if len(channelID) > 1<<16-1 {
		return nil, errors.New("relay channel ID exceeds envelope limit")
	}
	envelope := make([]byte, 2+len(channelID)+len(frame))
	envelope[0] = byte(len(channelID) >> 8)
	envelope[1] = byte(len(channelID))
	copy(envelope[2:], channelID)
	copy(envelope[2+len(channelID):], frame)
	return envelope, nil
}

func unwrapEnvelope(envelope []byte) (string, []byte, error) {
	if len(envelope) < 2 {
		return "", nil, errors.New("relay envelope is shorter than channel length")
	}
	channelLength := int(envelope[0])<<8 | int(envelope[1])
	if channelLength == 0 {
		return "", nil, errors.New("relay envelope has no channel ID")
	}
	if len(envelope) < 2+channelLength {
		return "", nil, errors.New("relay envelope is shorter than channel ID")
	}
	channelID := string(envelope[2 : 2+channelLength])
	if !utf8.ValidString(channelID) {
		return "", nil, errors.New("relay envelope channel ID is not UTF-8")
	}
	return channelID, envelope[2+channelLength:], nil
}

func routeKey(accountID int64, fingerprint string) string {
	return fmt.Sprintf("relay:daemon:%d:%s", accountID, base64.RawURLEncoding.EncodeToString([]byte(fingerprint)))
}
