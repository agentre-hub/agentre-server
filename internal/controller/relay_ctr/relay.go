// Package relay_ctr 提供 daemon 与客户端的 websocket 中转入口。
package relay_ctr

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/controller/connguard"
	"github.com/agentre-hub/agentre-server/internal/controller/relay_ctr/relayws"
	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

type Relay struct {
	svc relay_svc.RelaySvc
	// 两个端点的读上限不同,所以是两个 transport:daemon 那条收的是信封(载荷 +
	// 通道 ID 头),客户端那条收的是裸载荷。见 relayws.MaxPayloadBytes。
	daemonTransport relayws.Transport
	clientTransport relayws.Transport
}

func New(svc relay_svc.RelaySvc) *Relay {
	return &Relay{
		svc:             svc,
		daemonTransport: relayws.New(relayws.DaemonReadLimit),
		clientTransport: relayws.New(relayws.ClientReadLimit),
	}
}

// Drain 优雅下线:把这个进程手里两个端点上还活着的中继 websocket 逐条礼貌关掉
// (1001 Going Away),让对端立刻重连到别的副本,而不是当成网络抖动慢慢退避。
//
// 关掉之后每个 handler 的读循环随即出错返回,它的 detach 才跑得到 —— 那是把连接
// 从帧总线上摘下来的唯一一步,也是 mux 的 Shutdown 等的那件事。
func (r *Relay) Drain() int {
	return r.daemonTransport.Drain() + r.clientTransport.Drain()
}

// Daemon 接收 agentred 的出站连接。在线态只由 Redis TTL 表示；连接断开时
// 不主动删除，进程失联后也会在最后一次续期后自动消失。
func (r *Relay) Daemon(c *gin.Context) {
	// ctx 在这里取一次：心跳回调跑在另一个 goroutine 上，不能在那里碰 gin.Context。
	ctx := c.Request.Context()
	accountID, deviceID, kind, jti := deviceClaims(c)
	route, err := r.svc.PrepareDaemon(ctx, accountID, deviceID, kind)
	if err != nil {
		relayError(c, err)
		return
	}
	guard := connguard.New(ctx, accountID, jti)
	conn, err := r.daemonTransport.Upgrade(c.Writer, c.Request, relayws.Hooks{
		OnPeerActivity: func() error {
			if err := guard(); err != nil {
				return err
			}
			return r.svc.RenewDaemon(ctx, route)
		},
		OnHeartbeat: guard,
	})
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	detach, err := r.svc.AttachDaemon(ctx, route, conn)
	if err != nil {
		return
	}
	defer detach()
	if err := r.svc.RegisterDaemon(ctx, route); err != nil {
		return
	}

	// 登记这一步刚把在线态 TTL 写满,所以从现在开始计时。
	renew := &renewThrottle{interval: relayws.HeartbeatInterval, last: time.Now()}

	for {
		messageType, frame, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if renew.due(time.Now()) {
			if err := r.svc.RenewDaemon(ctx, route); err != nil {
				return
			}
		}
		if err := r.svc.ForwardDaemon(ctx, route, messageType, frame); err != nil {
			// daemon websocket 由所有客户端通道共享。单个客户端已经断开或写入失败时，
			// service 仍须如实返回转发失败，但不能因此关闭其它通道共用的物理连接。
			if errors.Is(err, relay_svc.ErrForwardFailed) {
				continue
			}
			return
		}
	}
}

// renewThrottle 把 daemon 读循环里的在线态续期压到每 interval 至多一次。
//
// 从前是每收一帧续一次。在线态 TTL 是 30 秒,而心跳的 pong 每 HeartbeatInterval
// 就会走一次 OnPeerActivity 续期,于是逐帧那一次是纯冗余——代价却是每帧多两次
// **串行** Redis 往返(RenewDaemon 是 GET + EXPIRE),而转发就跑在这条读循环上,
// 这两次往返原样计入每一帧的转发延迟。
//
// 保留这一路而不是完全删掉:一条只顾发数据、pong 迟迟不来的连接,读超时是 45 秒
// 而 TTL 只有 30 秒,中间那段它会被当成离线。节流后仍然保证「在发帧的连接每
// HeartbeatInterval 至少续一次」,不变量没变,只是不再逐帧重复。
//
// 单条连接的读循环独占一个实例,因此不需要加锁。
type renewThrottle struct {
	interval time.Duration
	last     time.Time
}

func (t *renewThrottle) due(now time.Time) bool {
	if now.Sub(t.last) < t.interval {
		return false
	}
	t.last = now
	return true
}

// Client 接收同账号客户端指定目标 daemon 的连接。所有能在 upgrade 前判定的
// 错误都以 HTTP 响应返回，使调用方能区分未登记、离线和转发不可用。
func (r *Relay) Client(c *gin.Context) {
	ctx := c.Request.Context()
	accountID, _, _, jti := deviceClaims(c)
	route, err := r.svc.ConnectClient(ctx, accountID, c.Query("daemon_fingerprint"))
	if err != nil {
		relayError(c, err)
		return
	}
	guard := connguard.New(ctx, accountID, jti)
	conn, err := r.clientTransport.Upgrade(c.Writer, c.Request, relayws.Hooks{
		OnPeerActivity: guard, OnHeartbeat: guard,
	})
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	channelID, detach, err := r.svc.AttachClient(ctx, route, conn)
	if err != nil {
		return
	}
	defer detach()

	for {
		messageType, frame, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if err := r.svc.ForwardClient(ctx, route, channelID, messageType, frame); err != nil {
			return
		}
	}
}

// connectionGuard 把「这条连接还能继续吗」翻译成传输层认得的终止信号。
//
// 中继 websocket 只在 upgrade 那一刻过一次鉴权中间件，登出、设备撤销与账号封禁因此
// 都只挡得住**新**连接；只有这里的逐次复查，才能把它们落到一条已经建好的连接上。
//
// 两条判据的失败方向刻意相反，别顺手统一掉：凭据撤销判不出来时不断开
// （auth_svc.WatchRelayCredential 的 fail-open，那只是一次早已生效的撤销的收尾），
// 账号闸门判不出来时断开（user_svc.AccountGate 的 fail-closed，那是授权判定本身）。
func deviceClaims(c *gin.Context) (int64, int64, string, string) {
	return ginctx.UserID(c), ginctx.DeviceID(c), ginctx.DeviceKind(c), ginctx.JTI(c)
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
	apierr.Abort(c, status, businessCode)
}
