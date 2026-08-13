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
	// ErrRelayUnconfigured 由 Default() 的安全占位实现返回：调用方从未
	// SetDefault() 过真实的 RelaySvc（例如只装配了 device flow、没有跑完整
	// bootstrap 的测试或 handler）。区别于 nil 接口——调用方能拿到一个明确
	// 的错误而不是 panic。
	ErrRelayUnconfigured = errors.New("relay service is not configured")
)

var defaultSvc RelaySvc

// Default 返回当前注册的 RelaySvc。SetDefault() 之前从未被调用时，返回
// unavailableRelaySvc 而不是 nil：任何依赖 Default() 的调用方（比如
// device_svc.ListUserDevices 的在线态 fail-open）都能拿到明确的
// ErrRelayUnconfigured，而不是对 nil 接口调用方法触发 panic。
func Default() RelaySvc {
	if defaultSvc == nil {
		return unavailableRelaySvc{}
	}
	return defaultSvc
}

func SetDefault(s RelaySvc) { defaultSvc = s }

// unavailableRelaySvc 是 Default() 在没有注册真实 RelaySvc 时的安全占位实现，
// 与 unavailableForwarder 同一模式：每个方法都明确返回 ErrRelayUnconfigured，
// 而不是把 nil 接口留给调用方去踩。
type unavailableRelaySvc struct{}

func (unavailableRelaySvc) PrepareDaemon(context.Context, int64, int64, string) (Route, error) {
	return Route{}, ErrRelayUnconfigured
}

func (unavailableRelaySvc) RegisterDaemon(context.Context, Route) error {
	return ErrRelayUnconfigured
}

func (unavailableRelaySvc) RenewDaemon(context.Context, Route) error {
	return ErrRelayUnconfigured
}

func (unavailableRelaySvc) ConnectClient(context.Context, int64, string) (Route, error) {
	return Route{}, ErrRelayUnconfigured
}

func (unavailableRelaySvc) IsDaemonOnline(context.Context, int64, string) (bool, error) {
	return false, ErrRelayUnconfigured
}

func (unavailableRelaySvc) AttachDaemon(context.Context, Route, FrameWriter) (func(), error) {
	return nil, ErrRelayUnconfigured
}

func (unavailableRelaySvc) AttachClient(context.Context, Route, FrameWriter) (string, func(), error) {
	return "", nil, ErrRelayUnconfigured
}

func (unavailableRelaySvc) ForwardDaemon(context.Context, Route, int, []byte) error {
	return ErrRelayUnconfigured
}

func (unavailableRelaySvc) ForwardClient(context.Context, Route, string, int, []byte) error {
	return ErrRelayUnconfigured
}

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
	IsDaemonOnline(ctx context.Context, accountID int64, fingerprint string) (bool, error)
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
	if !isAddressableKind(kind) {
		return Route{}, ErrDaemonForbidden
	}
	device, err := s.devices.Find(ctx, deviceID)
	if err != nil {
		return Route{}, err
	}
	if device == nil || device.UserID != accountID || !isAddressableKind(device.Kind) || !device.IsActive() {
		return Route{}, ErrDaemonForbidden
	}
	return Route{AccountID: accountID, Fingerprint: device.Fingerprint, InstanceID: s.config.InstanceID}, nil
}

func isAddressableKind(kind string) bool {
	return kind == device_entity.KindAgentred || kind == device_entity.KindDesktop
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
	if device == nil || !isAddressableKind(device.Kind) || !device.IsActive() {
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

// IsDaemonOnline 报告 daemon 的在线登记是否存在（R20 在线态）：
// Redis 路由键存在即在线（带 TTL，断连或进程消失后自动过期），与 devices.status 无关。
func (s *relaySvc) IsDaemonOnline(ctx context.Context, accountID int64, fingerprint string) (bool, error) {
	n, err := s.redis.Exists(ctx, routeKey(accountID, fingerprint)).Result()
	if err != nil {
		return false, fmt.Errorf("check relay daemon presence: %w", err)
	}
	return n > 0, nil
}

// channelCloseTimeout 限制「通知 daemon 通道关闭」这一步的耗时:它跑在客户端
// 断开的清理路径上,阻塞在这里会拖住 websocket handler 的返回。
const channelCloseTimeout = 3 * time.Second

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
	return channelID, func() {
		// 客户端走了:先把「这条虚拟通道没了」告诉 daemon,再摘掉本地附着。
		// 共享的 relay websocket 还开着,daemon 侧不会收到任何整链路断开事件,
		// 只能靠这个逐通道信号避免留下幽灵对端(见 relay_test 的说明)。
		// 用 WithoutCancel:走到这里时 handler 的 request ctx 通常已经取消了。
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), channelCloseTimeout)
		defer cancel()
		_ = s.ForwardClient(closeCtx, target, channelID, websocket.BinaryMessage, nil)
		detach()
	}, nil
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
