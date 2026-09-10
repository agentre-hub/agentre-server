// Package relayws 封装 relay WebSocket 的连接生命周期与传输策略。
package relayws

import (
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ErrCredentialRevoked 由生命周期回调返回，表示这条连接背后的凭据已被撤销、服务端
// 要主动断开。传输层为它走正常的 websocket 关闭路径（1008 + 原因），让对端能把它与
// 网络中断区分开：daemon 照常退避重连，重连会在 upgrade 处被鉴权拒掉。
var ErrCredentialRevoked = errors.New("relay credential revoked")

const credentialRevokedReason = "credential revoked"

// drainingReason 是优雅下线时写进关闭帧的原因。它跟着 1001 一起过去,对端据此
// 在日志里说得出「是服务端要走了」,而不是留下一条没头没尾的 1006。
const drainingReason = "server draining"

// ProtobufSubprotocol 是客户端主动声明时协商的 WebSocket 子协议。未声明子协议也能
// 建立 relay；relay 只路由 opaque Protobuf RPC 字节，不解析其中的 RpcFrame。
const ProtobufSubprotocol = "agentre-protobuf"

// Hooks 是中继连接生命周期的两个回调。任一回调返回错误都会断开连接。
type Hooks struct {
	// OnPeerActivity 在收到对端 ping/pong 时调用，daemon 用它续期在线登记。
	OnPeerActivity func() error
	// OnHeartbeat 在服务端每次心跳时调用，**不依赖对端配合**。凭据撤销的复查必须挂在
	// 这条路径上：只挂在 OnPeerActivity 上的话，一个只发帧、从不回应 ping 的对端
	// （读期限被自己的帧不断续上）就永远轮不到复查，撤销形同虚设。
	OnHeartbeat func() error
}

// MaxPayloadBytes 是一条 RPC 载荷的上限，**整条链路共用这一个数**：桌面端 ↔ agentred
// 的直连（agentre 的 protorpc.MaxFrameBytes）、浏览器接入这一侧、以及 daemon 那条中继
// 链路，三处必须同源。
//
// 三处曾经不同源：直连与 daemon 侧是 16 MiB，服务端这里是 10 MiB。后果不是「大一点的
// 请求失败了」——超限时 gorilla 回 1009 并让读循环出错，于是**整条物理连接**被拆掉，
// 而 daemon 那条链路上跑着那台机器的全部虚拟通道，所有会话一起断线重连。
//
// 取小的那个数（10 MiB）而不是大的：中继上跑的是别的设备发来的字节，不是本机可信输入。
const MaxPayloadBytes int64 = 10 << 20

// MaxEnvelopeBytes 是信封头的余量：2 字节长度 + 通道 ID（对侧 relaytransport 的
// maxRelayChannelIDLength 是 128）。
//
// **两个端点都要加它。** 从前只有 daemon 那侧加：客户端那条收的是裸载荷，一条连接
// 一条通道，信封由服务端替它套上。目标下沉到通道之后（决策 10），客户端那条连接上
// 同时跑着多条通道，它自己也开始收发信封（relay_svc.WrapEnvelope / UnwrapEnvelope），
// 因此两侧的读上限同为「载荷预算 + 一个信封头」——少给这一份余量，一份刚好 10 MiB
// 的合法载荷会只因为带了信封就被 1009 打掉，而打掉的是整条连接，上面所有通道一起
// 陪葬。
const MaxEnvelopeBytes int64 = 2 + 128

// DaemonReadLimit / ClientReadLimit 是两个端点各自的读上限，由上面两个数推出来，
// 不另外写字面量。
const (
	DaemonReadLimit = MaxPayloadBytes + MaxEnvelopeBytes
	ClientReadLimit = MaxPayloadBytes + MaxEnvelopeBytes
)

const (
	// HeartbeatInterval 是服务端发 ping 的周期,也是对端 pong 触发 OnPeerActivity
	// 的周期。控制器按它给读循环里的在线态续期节流,所以它是导出的:两处必须是
	// 同一个数,否则续期的实际间隔会脱离心跳的保证。
	HeartbeatInterval = 15 * time.Second
	readTimeout       = 45 * time.Second
	writeTimeout      = 10 * time.Second
)

type timing struct {
	heartbeatInterval time.Duration
	readTimeout       time.Duration
	writeTimeout      time.Duration
}

// Connection 是控制器进行帧编排所需的传输连接。
type Connection interface {
	ReadMessage() (messageType int, data []byte, err error)
	WriteMessage(messageType int, data []byte) error
	Close() error
}

// Transport 将 HTTP 请求升级为受生命周期策略管理的 WebSocket 连接。
type Transport interface {
	Upgrade(w http.ResponseWriter, r *http.Request, hooks Hooks) (Connection, error)
	Drainer
}

// Drainer 是优雅下线那一步:把这个 transport 手里还活着的连接**逐条礼貌关掉**。
//
// 为什么不能什么都不做就退出:中继是长连接,进程一走对端读到的是 1006
// (abnormal closure),那与「网线被拔了」完全一样 —— 对端只能按网络抖动退避重试。
// 而这一次它本该立刻重连,并且落到另一个还活着的副本上。1001(Going Away)在协议里
// 的含义正是「服务端要走了」,是唯一说得清这件事的信号。
//
// 交回这一次真的关掉了几条,调用方据此记一行日志。
type Drainer interface {
	Drain() int
}

type transport struct {
	timing    timing
	readLimit int64
	upgrader  websocket.Upgrader

	// live 是本 transport 此刻还握着的连接。只增不减会变成一份内存泄漏,所以
	// connection.Close 里同步摘除(见 forget)。
	mu   sync.Mutex
	live map[*connection]struct{}
}

type connection struct {
	owner        *transport
	conn         *websocket.Conn
	readTimeout  time.Duration
	writeTimeout time.Duration
	hooks        Hooks
	done         chan struct{}
	closeOnce    sync.Once
	writeMu      sync.Mutex
}

// New 创建采用固定生产生命周期策略的 WebSocket 传输组件。
//
// readLimit 由端点决定。两个端点如今收的都是信封，两个上限也因此同值；保留两个
// 名字是因为它们各自表达一个端点的预算，都从 MaxPayloadBytes 推出来，调用方不该
// 另写一个数。
func New(readLimit int64) Transport {
	return newWithTiming(defaultTiming(), readLimit)
}

func newWithTiming(cfg timing, readLimit int64) Transport {
	if readLimit <= 0 {
		readLimit = ClientReadLimit
	}
	return &transport{
		timing:    cfg,
		readLimit: readLimit,
		upgrader:  websocket.Upgrader{Subprotocols: []string{ProtobufSubprotocol}},
		live:      map[*connection]struct{}{},
	}
}

func defaultTiming() timing {
	return timing{
		heartbeatInterval: HeartbeatInterval,
		readTimeout:       readTimeout,
		writeTimeout:      writeTimeout,
	}
}

func (t *transport) Upgrade(w http.ResponseWriter, r *http.Request, hooks Hooks) (Connection, error) {
	conn, err := t.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, err
	}
	peer := &connection{
		owner:        t,
		conn:         conn,
		readTimeout:  t.timing.readTimeout,
		writeTimeout: t.timing.writeTimeout,
		hooks:        hooks,
		done:         make(chan struct{}),
	}
	conn.SetReadLimit(t.readLimit)
	if err := peer.extendReadDeadline(); err != nil {
		_ = peer.Close()
		return nil, err
	}
	conn.SetPingHandler(func(appData string) error {
		if err := peer.extendReadDeadline(); err != nil {
			return err
		}
		if err := peer.peerActivity(); err != nil {
			return err
		}
		return peer.writeControl(websocket.PongMessage, []byte(appData))
	})
	conn.SetPongHandler(func(string) error {
		if err := peer.extendReadDeadline(); err != nil {
			return err
		}
		return peer.peerActivity()
	})
	t.remember(peer)
	go peer.heartbeat(t.timing.heartbeatInterval)
	return peer, nil
}

func (t *transport) remember(peer *connection) {
	t.mu.Lock()
	t.live[peer] = struct{}{}
	t.mu.Unlock()
}

func (t *transport) forget(peer *connection) {
	t.mu.Lock()
	delete(t.live, peer)
	t.mu.Unlock()
}

// Drain 先把登记表整个取走再逐条关:关连接会回头调 forget,握着锁做这件事就是
// 自锁。取走之后表是空的,于是重复调用交回 0 —— 排空天然幂等。
func (t *transport) Drain() int {
	t.mu.Lock()
	draining := make([]*connection, 0, len(t.live))
	for peer := range t.live {
		draining = append(draining, peer)
	}
	t.live = map[*connection]struct{}{}
	t.mu.Unlock()

	for _, peer := range draining {
		// 关闭帧写不出去(对端已经没了)不影响下一步:该关的还是要关。
		_ = peer.writeControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, drainingReason))
		_ = peer.Close()
	}
	return len(draining)
}

func (p *connection) ReadMessage() (int, []byte, error) {
	messageType, data, err := p.conn.ReadMessage()
	if err != nil {
		return 0, nil, err
	}
	if err := p.extendReadDeadline(); err != nil {
		return 0, nil, err
	}
	return messageType, data, nil
}

func (p *connection) WriteMessage(messageType int, data []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.conn.SetWriteDeadline(time.Now().Add(p.writeTimeout)); err != nil {
		_ = p.Close()
		return err
	}
	if err := p.conn.WriteMessage(messageType, data); err != nil {
		_ = p.Close()
		return err
	}
	return nil
}

func (p *connection) Close() error {
	p.closeOnce.Do(func() {
		close(p.done)
		if p.owner != nil {
			p.owner.forget(p)
		}
	})
	return p.conn.Close()
}

func (p *connection) extendReadDeadline() error {
	return p.conn.SetReadDeadline(time.Now().Add(p.readTimeout))
}

func (p *connection) writeControl(messageType int, data []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.conn.WriteControl(messageType, data, time.Now().Add(p.writeTimeout)); err != nil {
		_ = p.Close()
		return err
	}
	return nil
}

// peerActivity 跑对端活动回调。回调要求终止时先把关闭帧写出去，再把错误交回读循环
// ——读循环随后返回，控制器的 detach 照常执行。
func (p *connection) peerActivity() error {
	if p.hooks.OnPeerActivity == nil {
		return nil
	}
	err := p.hooks.OnPeerActivity()
	if err != nil {
		p.terminate(err)
	}
	return err
}

// terminate 断开连接。凭据被撤销时先发一个关闭帧，让对端知道是服务端主动断的、
// 而不是网络抖动；其余错误沿用原来的直接关闭。
func (p *connection) terminate(err error) {
	if errors.Is(err, ErrCredentialRevoked) {
		_ = p.writeControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, credentialRevokedReason))
	}
	_ = p.Close()
}

func (p *connection) heartbeat(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if p.hooks.OnHeartbeat != nil {
				if err := p.hooks.OnHeartbeat(); err != nil {
					p.terminate(err)
					return
				}
			}
			if err := p.writeControl(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-p.done:
			return
		}
	}
}
