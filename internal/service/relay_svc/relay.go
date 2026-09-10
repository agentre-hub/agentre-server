// Package relay_svc 管理 daemon 的短暂在线态，并定义帧转发总线的服务边界。
package relay_svc

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	goredis "github.com/redis/go-redis/v9"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

var (
	ErrDaemonNotFound  = errors.New("relay daemon not found")
	ErrDaemonOffline   = errors.New("relay daemon offline")
	ErrForwardFailed   = errors.New("relay forwarding failed")
	ErrDaemonForbidden = errors.New("relay daemon forbidden")
	// ErrTargetInvalid 是通道声明的目标本身不成形：既不是
	// conversation:<uuid> 也不是 machine:<fingerprint>。它与「解析不出机器」
	// (ErrDaemonNotFound) 是两件事——前者是客户端写错了，后者是账号里确实没有。
	ErrTargetInvalid = errors.New("relay channel target is invalid")
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

func (unavailableRelaySvc) ResolveTarget(context.Context, int64, string) (Route, error) {
	return Route{}, ErrRelayUnconfigured
}

func (unavailableRelaySvc) IsDaemonOnline(context.Context, int64, string) (bool, error) {
	return false, ErrRelayUnconfigured
}

func (unavailableRelaySvc) DaemonConnID(context.Context, int64, string) (string, error) {
	return "", ErrRelayUnconfigured
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
	// ConnID 标识 daemon 的**这一条** websocket，每次 PrepareDaemon 现取一个。
	//
	// 在线态原本只答得出「这台机器在线吗」，答不出「还是不是原来那条连接」。而
	// daemon 侧的虚拟通道连同它的鉴权状态都活在那条链路上，链路一换就都没了：中继
	// 按指纹寻址，旧通道 id 的帧照样投给新接上的那条 websocket，daemon 对没见过的
	// 通道 id 新建一条**未鉴权**通道，于是那条通道上的 session.* 从此一律
	// Unauthorized。常驻镜像正是靠这个值发现自己手里那条通道已经作废
	// （mirror_svc.follower.keepalive）。
	//
	// 客户端一侧解析出来的 Route（ConnectClient / ResolveTarget）带的是**此刻**登记
	// 的那条链路，因此「解析出来的目标」与「daemon 登记的目标」始终是同一个值。
	ConnID string
}

// Peer 标识帧从 daemon 或客户端一侧进入总线。
type Peer string

const (
	PeerDaemon Peer = "daemon"
	PeerClient Peer = "client"
)

// Forwarder 是 server-internal Redis 帧总线边界。Check 必须在 websocket upgrade
// 前返回可区分的转发失败；Forward 的 peer/channel/messageType 是跨副本路由 metadata，
// frame 是 opaque Protobuf RPC bytes，帧总线不解析其 method 或 payload。
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
	// ResolveTarget 解析一条**虚拟通道**声明的目标。中继连接本身不再有目标
	// （决策 10），所以这件事逐通道发生，一条连接上的两条通道可以落在两台
	// 不同的机器上。
	ResolveTarget(ctx context.Context, accountID int64, target string) (Route, error)
	IsDaemonOnline(ctx context.Context, accountID int64, fingerprint string) (bool, error)
	// DaemonConnID 交出这台机器此刻那条 daemon 连接的身份，机器不在线时交出
	// ErrDaemonOffline。拿着旧值的调用方据此知道对端换过链路，自己手里那条虚拟
	// 通道已经作废，见 Route.ConnID。
	//
	// 旧格式的在线态键（滚动升级期间）交出空串：认不出换代，而不是误判成换过代。
	DaemonConnID(ctx context.Context, accountID int64, fingerprint string) (string, error)
	AttachDaemon(ctx context.Context, target Route, writer FrameWriter) (func(), error)
	AttachClient(ctx context.Context, target Route, writer FrameWriter) (channelID string, detach func(), err error)
	ForwardDaemon(ctx context.Context, target Route, messageType int, frame []byte) error
	ForwardClient(ctx context.Context, target Route, channelID string, messageType int, frame []byte) error
}

type relaySvc struct {
	config    Config
	devices   device_repo.DeviceRepo
	saves     agent_session_repo.SaveRepo
	redis     *goredis.Client
	forwarder Forwarder

	// 每条 daemon 链路一个分派器,把转发从读循环上摘下来,见 fanout.go。
	fanoutMu sync.Mutex
	fanouts  map[Route]*daemonFanout
}

// New 创建 RelaySvc。实例 ID 必须在每个 server 进程中唯一。
func New(
	config Config, devices device_repo.DeviceRepo, saves agent_session_repo.SaveRepo,
	redisClient *goredis.Client, forwarder Forwarder,
) RelaySvc {
	return &relaySvc{
		config: config, devices: devices, saves: saves, redis: redisClient, forwarder: forwarder,
		fanouts: map[Route]*daemonFanout{},
	}
}

func (s *relaySvc) PrepareDaemon(ctx context.Context, accountID, deviceID int64, kind string) (Route, error) {
	if !isAddressableKind(kind) {
		return Route{}, ErrDaemonForbidden
	}
	device, err := s.devices.Find(ctx, deviceID)
	if err != nil {
		return Route{}, err
	}
	if !device.UsableBy(accountID) || !isAddressableKind(device.Kind) {
		return Route{}, ErrDaemonForbidden
	}
	// 一条 websocket 一个 ConnID：PrepareDaemon 在 handler 里只跑一次，见 Route.ConnID。
	connID, err := newDaemonConnID()
	if err != nil {
		return Route{}, err
	}
	return Route{
		AccountID: accountID, Fingerprint: device.Fingerprint,
		InstanceID: s.config.InstanceID, ConnID: connID,
	}, nil
}

func isAddressableKind(kind string) bool {
	return kind == device_entity.KindAgentred || kind == device_entity.KindDesktop
}

func (s *relaySvc) RegisterDaemon(ctx context.Context, route Route) error {
	if err := s.redis.Set(ctx, routeKey(route.AccountID, route.Fingerprint), routeValue(route), s.config.OnlineTTL).Err(); err != nil {
		return fmt.Errorf("register relay daemon: %w", err)
	}
	// 登记完才出声，而且只有登记这一处出声：RenewDaemon 是心跳续期，不是状态变化，
	// 跟着喊会让这个账号所有在线连接每 15 秒白拉一页设备列表。下线没有对应的一条
	// ——在线态的模型就是「键到期即离线，不主动删除」（见 accountchan_svc
	// .FrameTypeDevicePresence）。
	accountchan_svc.BroadcastSignalBestEffort(ctx, route.AccountID, accountchan_svc.FrameTypeDevicePresence)
	return nil
}

func (s *relaySvc) RenewDaemon(ctx context.Context, route Route) error {
	key := routeKey(route.AccountID, route.Fingerprint)
	value, err := s.redis.Get(ctx, key).Result()
	if errors.Is(err, goredis.Nil) {
		return ErrDaemonOffline
	}
	if err != nil {
		return fmt.Errorf("get relay daemon: %w", err)
	}
	// 只比实例：判据仍是「这台机器此刻归不归本副本」。同一副本上新连接接替旧连接时,
	// 迟到的那次续期续的是同一个值,只动 TTL,不改在线态。
	if instanceID, _ := splitRouteValue(value); instanceID != route.InstanceID {
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

	value, err := s.redis.Get(ctx, routeKey(accountID, fingerprint)).Result()
	if errors.Is(err, goredis.Nil) {
		return Route{}, ErrDaemonOffline
	}
	if err != nil {
		return Route{}, fmt.Errorf("resolve relay daemon: %w", err)
	}
	// 拆开：InstanceID 是帧总线的寻址依据，整段复合值送进去谁都路由不到。
	instanceID, connID := splitRouteValue(value)
	route := Route{
		AccountID: accountID, Fingerprint: fingerprint,
		InstanceID: instanceID, ConnID: connID,
	}
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

func (s *relaySvc) DaemonConnID(ctx context.Context, accountID int64, fingerprint string) (string, error) {
	value, err := s.redis.Get(ctx, routeKey(accountID, fingerprint)).Result()
	if errors.Is(err, goredis.Nil) {
		return "", ErrDaemonOffline
	}
	if err != nil {
		return "", fmt.Errorf("get relay daemon connection: %w", err)
	}
	_, connID := splitRouteValue(value)
	return connID, nil
}

// channelCloseTimeout 限制「通知 daemon 通道关闭」这一步的耗时:它跑在客户端
// 断开的清理路径上,阻塞在这里会拖住 websocket handler 的返回。
const channelCloseTimeout = 3 * time.Second

func (s *relaySvc) AttachDaemon(ctx context.Context, target Route, writer FrameWriter) (func(), error) {
	detach, err := s.attach(ctx, target, PeerDaemon, "", writer)
	if err != nil {
		return nil, err
	}
	// 分派器与这条链路同生共死:它一收工,排着的帧就不该再投,新来的帧也不该再收。
	closeFanout := s.registerFanout(target)
	return func() {
		closeFanout()
		detach()
	}, nil
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

// ForwardDaemon 只做两件事:拆信封、把内层帧排给它那条虚拟通道。**不等转发完成**。
//
// 调用它的是 daemon 的读循环,而转发在跨副本时要等一次 Redis 投递回执。在这里等
// 就等于让一台机器上所有会话的每一个 token 排同一条队(见 fanout.go 开头)。
//
// 信封解不开是**协议违例**,不是转发失败:它照旧同步报上去,控制器据此拆掉这条链路。
// 而转发本身的失败发生在 worker 里,不再连坐这条共享的物理连接。
func (s *relaySvc) ForwardDaemon(ctx context.Context, target Route, messageType int, frame []byte) error {
	if messageType != websocket.BinaryMessage {
		return errors.New("relay daemon envelope must be a binary websocket message")
	}
	channelID, innerFrame, err := UnwrapEnvelope(frame)
	if err != nil {
		return fmt.Errorf("decode relay daemon envelope: %w", err)
	}
	fanout, ok := s.fanoutFor(target)
	if !ok {
		return fmt.Errorf("%w: relay daemon link is not attached", ErrForwardFailed)
	}
	return fanout.enqueue(ctx, channelID, innerFrame)
}

func (s *relaySvc) ForwardClient(ctx context.Context, target Route, channelID string, messageType int, frame []byte) error {
	envelope, err := WrapEnvelope(channelID, frame)
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

func newDaemonConnID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate relay daemon connection ID: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

// routeValueSeparator 分开在线态值里的实例与连接。base64.RawURLEncoding 的字母表
// （A-Z a-z 0-9 - _）里没有它，所以两段永远分得开。
const routeValueSeparator = "|"

// routeValue 是在线态键里存的东西：本副本的实例 id + daemon 的这条连接。
func routeValue(route Route) string {
	if route.ConnID == "" {
		return route.InstanceID
	}
	return route.InstanceID + routeValueSeparator + route.ConnID
}

// splitRouteValue 拆回实例与连接。旧格式（滚动升级期间还没被覆盖的键）只有实例一段，
// 连接交回空串——调用方据此退回「认不出换代」，而不是把每一台机器都判成换过代。
func splitRouteValue(value string) (instanceID, connID string) {
	instanceID, connID, _ = strings.Cut(value, routeValueSeparator)
	return instanceID, connID
}

// WrapEnvelope 把一帧套上通道信封：2 字节通道 ID 长度 + 通道 ID + 载荷。
//
// 两条链路共用这一个格式。目标下沉到通道之后（决策 10），客户端那条链路上一条
// 物理连接同时跑多条通道，因此它也开始收发信封，而不再是裸载荷。
func WrapEnvelope(channelID string, frame []byte) ([]byte, error) {
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

// UnwrapEnvelope 拆开通道信封。空载荷是合法的：它是「这条通道关了」的信号。
func UnwrapEnvelope(envelope []byte) (string, []byte, error) {
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
