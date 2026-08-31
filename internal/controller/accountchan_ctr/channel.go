// Package accountchan_ctr 提供账号级实时通道的 websocket 入口。
//
// 与中继的两个端点的根本区别是**不指定目标 daemon**：它是账号级的常连通道，
// 桌面端与浏览器都可建立，服务端只往上面推「这个账号的同步版本推进到 V」这一种
// 信号，客户端收到照常走自己的 Pull（决策 18 / 19）。
package accountchan_ctr

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/agentre-hub/agentre-server/internal/controller/connguard"
	"github.com/agentre-hub/agentre-server/internal/controller/relay_ctr/relayws"
	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

type AccountChannel struct {
	svc       accountchan_svc.AccountChanSvc
	transport relayws.Transport
}

// New 创建通道控制器。传输沿用中继那套连接生命周期策略：心跳不依赖对端配合，
// 凭据的逐次复查因此挂得住（见 relayws.Hooks 的说明）。
func New(svc accountchan_svc.AccountChanSvc) *AccountChannel {
	return &AccountChannel{svc: svc, transport: relayws.New(relayws.ClientReadLimit)}
}

// Drain 优雅下线:与中继同一件事 —— 账号通道也是长连接,进程要走时先说一声
// (1001 Going Away)再关,浏览器据此立刻重连到别的副本。
func (a *AccountChannel) Drain() int { return a.transport.Drain() }

// Channel 是 GET /v1/account/channel：一条只出不进的常连通道。
//
// 订阅刻意排在 upgrade **之前**：一来建不起来时还能以 HTTP 如实作答（客户端据此
// 退回 30 秒轮询），二来 upgrade 成功之后发生的每一次广播都必然落在这份订阅上，
// 不留「刚连上就漏掉一条」的窗口——通道不保存未送达的信号，也不需要保存。
func (h *AccountChannel) Channel(c *gin.Context) {
	// ctx 在这里取一次：心跳回调跑在另一个 goroutine 上，不能在那里碰 gin.Context。
	ctx := c.Request.Context()
	accountID, jti := claims(c)
	subscription, err := h.svc.Subscribe(ctx, accountID)
	if err != nil {
		apierr.Abort(c, http.StatusServiceUnavailable, code.AccountChannelUnavailable)
		return
	}
	defer subscription.Close()

	guard := connguard.New(ctx, accountID, jti)
	conn, err := h.transport.Upgrade(c.Writer, c.Request, relayws.Hooks{
		OnPeerActivity: guard, OnHeartbeat: guard,
	})
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()

	go pump(subscription, conn)
	// 通道是单向的，客户端不发帧。读循环只为感知断开：读到错误就返回，两个 defer
	// 随即收掉连接与订阅。
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

// pump 把信号写成线上帧。信号流关掉意味着这条连接的订阅没了（Redis 订阅彻底失败，
// 或连接正在收尾），此时主动断开而不是留一条再也收不到信号的假活连接：客户端重连
// 时会主动 Pull 一次，断线期间的变更由那一次补齐。
func pump(subscription accountchan_svc.Subscription, conn relayws.Connection) {
	for frame := range subscription.Signals() {
		payload, err := encodeNotification(frame)
		if err != nil {
			break
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
			return
		}
	}
	_ = conn.Close()
}

// connectionGuard 把「这条连接还能继续吗」翻译成传输层认得的终止信号，判据与中继
// 的两条连接完全一致（规格：凭据被撤销时连接必须断开，与中继同一条判据）。
//
// claims 取鉴权中间件放进上下文的账号与凭据标识。两种凭据在这里没有区别：
// Device JWT 与浏览器票据都只贡献「哪个账号 + 哪一份凭据」。
func claims(c *gin.Context) (int64, string) {
	return ginctx.UserID(c), ginctx.JTI(c)
}
