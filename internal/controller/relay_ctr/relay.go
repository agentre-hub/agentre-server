// Package relay_ctr 提供 daemon 与客户端的 websocket 中转入口。
package relay_ctr

import (
	"errors"
	"net/http"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"agentre-server/internal/pkg/code"
	"agentre-server/internal/service/relay_svc"
)

var upgrader = websocket.Upgrader{}

type Relay struct {
	svc relay_svc.RelaySvc
}

func New(svc relay_svc.RelaySvc) *Relay { return &Relay{svc: svc} }

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
	detach, err := r.svc.AttachDaemon(c.Request.Context(), route, conn)
	if err != nil {
		return
	}
	defer detach()
	if err := r.svc.RegisterDaemon(c.Request.Context(), route); err != nil {
		return
	}

	conn.SetPingHandler(func(appData string) error {
		if err := r.svc.RenewDaemon(c.Request.Context(), route); err != nil {
			return err
		}
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(time.Second))
	})
	for {
		messageType, frame, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if err := r.svc.RenewDaemon(c.Request.Context(), route); err != nil {
			return
		}
		if err := r.svc.ForwardDaemon(c.Request.Context(), route, messageType, frame); err != nil {
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
	channelID, detach, err := r.svc.AttachClient(c.Request.Context(), route, conn)
	if err != nil {
		return
	}
	defer detach()

	for {
		messageType, frame, err := conn.ReadMessage()
		if err != nil {
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
