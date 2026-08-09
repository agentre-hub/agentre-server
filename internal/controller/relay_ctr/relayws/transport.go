// Package relayws 封装 relay WebSocket 的连接生命周期与传输策略。
package relayws

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxMessageSize    = 10 << 20
	heartbeatInterval = 15 * time.Second
	readTimeout       = 45 * time.Second
	writeTimeout      = 10 * time.Second
)

// Timing 定义 WebSocket 心跳与读写期限。
type Timing struct {
	HeartbeatInterval time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
}

// Connection 是控制器进行帧编排所需的传输连接。
type Connection interface {
	ReadMessage() (messageType int, data []byte, err error)
	WriteMessage(messageType int, data []byte) error
	Close() error
}

// Transport 将 HTTP 请求升级为受生命周期策略管理的 WebSocket 连接。
type Transport interface {
	Upgrade(w http.ResponseWriter, r *http.Request, renew func() error) (Connection, error)
}

type transport struct {
	timing   Timing
	upgrader websocket.Upgrader
}

type connection struct {
	conn         *websocket.Conn
	readTimeout  time.Duration
	writeTimeout time.Duration
	done         chan struct{}
	closeOnce    sync.Once
	writeMu      sync.Mutex
}

// DefaultTiming 返回生产 relay WebSocket 使用的固定生命周期策略。
func DefaultTiming() Timing {
	return Timing{
		HeartbeatInterval: heartbeatInterval,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
	}
}

// New 创建采用指定生命周期策略的 WebSocket 传输组件。
func New(timing Timing) Transport {
	return &transport{timing: timing}
}

func (t *transport) Upgrade(w http.ResponseWriter, r *http.Request, renew func() error) (Connection, error) {
	conn, err := t.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, err
	}
	peer := &connection{
		conn:         conn,
		readTimeout:  t.timing.ReadTimeout,
		writeTimeout: t.timing.WriteTimeout,
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
		if renew != nil {
			if err := renew(); err != nil {
				return err
			}
		}
		return peer.writeControl(websocket.PongMessage, []byte(appData))
	})
	conn.SetPongHandler(func(string) error {
		if err := peer.extendReadDeadline(); err != nil {
			return err
		}
		if renew != nil {
			return renew()
		}
		return nil
	})
	go peer.heartbeat(t.timing.HeartbeatInterval)
	return peer, nil
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

func (p *connection) heartbeat(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := p.writeControl(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-p.done:
			return
		}
	}
}
