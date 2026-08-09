// Package relay_ctr 提供 daemon 与客户端的 websocket 中转入口。
package relay_ctr

import (
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"agentre-server/internal/pkg/code"
	"agentre-server/internal/service/relay_svc"
)

const (
	maxMessageSize    = 10 << 20
	heartbeatInterval = 15 * time.Second
	readTimeout       = 45 * time.Second
	writeTimeout      = 10 * time.Second
)

var upgrader = websocket.Upgrader{}

// LifecycleTiming 是 relay websocket 生命周期的计时策略。生产入口使用固定默认值，
// 测试通过缩短这些时长验证超时行为，而不等待生产时长。
type LifecycleTiming struct {
	HeartbeatInterval time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
}

type Relay struct {
	svc    relay_svc.RelaySvc
	timing LifecycleTiming
}

type websocketPeer struct {
	conn         *websocket.Conn
	writeTimeout time.Duration
	writeMu      sync.Mutex
}

// DefaultLifecycleTiming 返回生产 relay websocket 使用的固定生命周期策略。
func DefaultLifecycleTiming() LifecycleTiming {
	return LifecycleTiming{
		HeartbeatInterval: heartbeatInterval,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
	}
}

func New(svc relay_svc.RelaySvc) *Relay {
	return NewWithLifecycleTiming(svc, DefaultLifecycleTiming())
}

// NewWithLifecycleTiming 建立可注入计时策略的 relay 控制器，供真实 websocket 测试使用。
func NewWithLifecycleTiming(svc relay_svc.RelaySvc, timing LifecycleTiming) *Relay {
	return &Relay{svc: svc, timing: timing}
}

func (p *websocketPeer) WriteMessage(messageType int, data []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.conn.SetWriteDeadline(time.Now().Add(p.writeTimeout)); err != nil {
		_ = p.conn.Close()
		return err
	}
	if err := p.conn.WriteMessage(messageType, data); err != nil {
		_ = p.conn.Close()
		return err
	}
	return nil
}

func (p *websocketPeer) writeControl(messageType int, data []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.conn.WriteControl(messageType, data, time.Now().Add(p.writeTimeout)); err != nil {
		_ = p.conn.Close()
		return err
	}
	return nil
}

func (r *Relay) preparePeer(conn *websocket.Conn, renew func() error) (*websocketPeer, func(), error) {
	peer := &websocketPeer{conn: conn, writeTimeout: r.timing.WriteTimeout}
	conn.SetReadLimit(maxMessageSize)
	extendReadDeadline := func() error {
		return conn.SetReadDeadline(time.Now().Add(r.timing.ReadTimeout))
	}
	if err := extendReadDeadline(); err != nil {
		return nil, nil, err
	}
	conn.SetPingHandler(func(appData string) error {
		if err := extendReadDeadline(); err != nil {
			return err
		}
		if renew != nil {
			if err := renew(); err != nil {
				return err
			}
		}
		return peer.writeControl(websocket.PongMessage, []byte(appData))
	})
	conn.SetPongHandler(func(string) error {
		if err := extendReadDeadline(); err != nil {
			return err
		}
		if renew != nil {
			return renew()
		}
		return nil
	})

	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(r.timing.HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := peer.writeControl(websocket.PingMessage, nil); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}()
	return peer, func() { close(done) }, nil
}

func (r *Relay) extendReadDeadline(conn *websocket.Conn) error {
	return conn.SetReadDeadline(time.Now().Add(r.timing.ReadTimeout))
}

// Daemon 接收 agentred 的出站连接。在线态只由 Redis TTL 表示；连接断开时
// 不主动删除，进程失联后也会在最后一次续期后自动消失。
func (r *Relay) Daemon(c *gin.Context) {
	accountID, deviceID, kind := deviceClaims(c)
	route, err := r.svc.PrepareDaemon(c.Request.Context(), accountID, deviceID, kind)
	if err != nil {
		relayError(c, err)
		return
	}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	peer, stopHeartbeat, err := r.preparePeer(conn, func() error {
		return r.svc.RenewDaemon(c.Request.Context(), route)
	})
	if err != nil {
		return
	}
	defer stopHeartbeat()
	detach, err := r.svc.AttachDaemon(c.Request.Context(), route, peer)
	if err != nil {
		return
	}
	defer detach()
	if err := r.svc.RegisterDaemon(c.Request.Context(), route); err != nil {
		return
	}

	for {
		messageType, frame, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if err := r.extendReadDeadline(conn); err != nil {
			return
		}
		if err := r.svc.RenewDaemon(c.Request.Context(), route); err != nil {
			return
		}
		if err := r.svc.ForwardDaemon(c.Request.Context(), route, messageType, frame); err != nil {
			// daemon websocket 由所有客户端通道共享。单个客户端已经断开或写入失败时，
			// service 仍须如实返回转发失败，但不能因此关闭其它通道共用的物理连接。
			if errors.Is(err, relay_svc.ErrForwardFailed) {
				continue
			}
			return
		}
	}
}

// Client 接收同账号客户端指定目标 daemon 的连接。所有能在 upgrade 前判定的
// 错误都以 HTTP 响应返回，使调用方能区分未登记、离线和转发不可用。
func (r *Relay) Client(c *gin.Context) {
	accountID, _, _ := deviceClaims(c)
	route, err := r.svc.ConnectClient(c.Request.Context(), accountID, c.Query("daemon_fingerprint"))
	if err != nil {
		relayError(c, err)
		return
	}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	peer, stopHeartbeat, err := r.preparePeer(conn, nil)
	if err != nil {
		return
	}
	defer stopHeartbeat()
	channelID, detach, err := r.svc.AttachClient(c.Request.Context(), route, peer)
	if err != nil {
		return
	}
	defer detach()

	for {
		messageType, frame, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if err := r.extendReadDeadline(conn); err != nil {
			return
		}
		if err := r.svc.ForwardClient(c.Request.Context(), route, channelID, messageType, frame); err != nil {
			return
		}
	}
}

func deviceClaims(c *gin.Context) (int64, int64, string) {
	uid, _ := c.Get("user_id")
	did, _ := c.Get("device_id")
	kind, _ := c.Get("device_kind")
	accountID, _ := uid.(int64)
	deviceID, _ := did.(int64)
	deviceKind, _ := kind.(string)
	return accountID, deviceID, deviceKind
}

func relayError(c *gin.Context, err error) {
	status, businessCode := http.StatusInternalServerError, code.ServerError
	switch {
	case errors.Is(err, relay_svc.ErrDaemonNotFound):
		status, businessCode = http.StatusNotFound, code.RelayDaemonNotFound
	case errors.Is(err, relay_svc.ErrDaemonOffline):
		status, businessCode = http.StatusConflict, code.RelayDaemonOffline
	case errors.Is(err, relay_svc.ErrForwardFailed):
		status, businessCode = http.StatusBadGateway, code.RelayForwardFailed
	case errors.Is(err, relay_svc.ErrDaemonForbidden):
		status, businessCode = http.StatusForbidden, code.Forbidden
	}
	c.AbortWithStatusJSON(status, gin.H{
		"code": businessCode, "msg": i18n.T(c.Request.Context(), businessCode), "data": nil,
	})
}
