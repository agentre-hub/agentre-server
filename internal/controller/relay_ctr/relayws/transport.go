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

// ProtobufSubprotocol 是 agentre 与 agentred 经 relay 传递 opaque Protobuf RPC 帧时
// 唯一接受的 WebSocket 子协议。relay 只路由字节，不解析其中的 RpcFrame。
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

const (
	maxMessageSize = 10 << 20
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
}

type transport struct {
	timing   timing
	upgrader websocket.Upgrader
}

type connection struct {
	conn         *websocket.Conn
	readTimeout  time.Duration
	writeTimeout time.Duration
	hooks        Hooks
	done         chan struct{}
	closeOnce    sync.Once
	writeMu      sync.Mutex
}

// New 创建采用固定生产生命周期策略的 WebSocket 传输组件。
func New() Transport {
	return newWithTiming(defaultTiming())
}

func newWithTiming(cfg timing) Transport {
	return &transport{
		timing:   cfg,
		upgrader: websocket.Upgrader{Subprotocols: []string{ProtobufSubprotocol}},
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
	if websocket.IsWebSocketUpgrade(r) && !supportsSubprotocol(r, ProtobufSubprotocol) {
		// 正文是谈不拢子协议的调用方唯一能看到的东西，所以它指名协议与补救办法；
		// 桌面仓 protorpc.LANServer 的 426 用同一句话。
		http.Error(w, "this endpoint speaks only the \""+ProtobufSubprotocol+
			"\" WebSocket subprotocol; upgrade agentred and agentre to the same release so both ends speak it",
			http.StatusUpgradeRequired)
		return nil, errors.New("relay websocket requires agentre-protobuf subprotocol")
	}
	conn, err := t.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, err
	}
	peer := &connection{
		conn:         conn,
		readTimeout:  t.timing.readTimeout,
		writeTimeout: t.timing.writeTimeout,
		hooks:        hooks,
		done:         make(chan struct{}),
	}
	conn.SetReadLimit(maxMessageSize)
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
	go peer.heartbeat(t.timing.heartbeatInterval)
	return peer, nil
}

func supportsSubprotocol(r *http.Request, expected string) bool {
	for _, offered := range websocket.Subprotocols(r) {
		if offered == expected {
			return true
		}
	}
	return false
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
	p.closeOnce.Do(func() { close(p.done) })
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
