package middleware

import (
	"context"
	"net/http"

	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// DeviceJWT 只放行设备 access token：按摘要解析出一台仍在用的设备，再过账号闸门。
// 浏览器的中继票据与 server 自用凭据进不来。判定只读 MySQL，Redis 不可用不影响它。
func DeviceJWT(tokens BearerResolver) gin.HandlerFunc {
	return func(c *gin.Context) {
		token, _ := bearerToken(c)
		p, status, businessCode, ok := devicePrincipal(c, tokens, token)
		if !ok {
			apierr.Abort(c, status, businessCode)
			return
		}
		if accountBlocked(c, p.AccountID) {
			return
		}
		setBearerPrincipal(c, p)
		c.Next()
	}
}

// RelayTicketClaimer 认领「用这张票连一次中继」，交回这一次是不是第一次。生产上是
// credstore.Store。
type RelayTicketClaimer interface {
	ClaimRelayConnect(ctx context.Context, handle string) (bool, error)
}

// RelayClientJWT accepts native clients' device access tokens and the browser's
// short-lived relay_client ticket. The latter is deliberately rejected by DeviceJWT.
//
// tokens 在生产上是 auth_svc.CredentialResolver：设备 access token 与 DeviceJWT 走同一条
// 摘要解析、判据逐条相同；不属于任何设备的身份只有浏览器票据进得来，server 自用凭据
// （server_mirror）进不来。
func RelayClientJWT(tokens BearerResolver, tickets RelayTicketClaimer) gin.HandlerFunc {
	return func(c *gin.Context) {
		token, _ := bearerToken(c)
		p, status, businessCode, ok := resolvePrincipal(c, tokens, token)
		if ok && p.DeviceID == 0 && !admitRelayTicket(c, tickets, p) {
			ok, status, businessCode = false, http.StatusUnauthorized, code.Unauthorized
		}
		if !ok {
			apierr.Abort(c, status, businessCode)
			return
		}
		if accountBlocked(c, p.AccountID) {
			return
		}
		setBearerPrincipal(c, p)
		c.Next()
	}
}

// admitRelayTicket 判一枚不属于任何设备的身份能不能连中继：必须是浏览器票据，且这是它
// 第一次连。
//
// 一张票只换一条连接（票经子协议传输，可能落进反代日志；日志里那份因此是废票）。认领判不
// 出来（Redis 不可用）同样拒绝（fail-closed）。原生端的设备 access token 不在此列：它是长期
// 凭据，本来就要反复使用。票据在有效期内仍可被对端反复核验，那一条不经过这里。
func admitRelayTicket(c *gin.Context, tickets RelayTicketClaimer, p *device_svc.Principal) bool {
	if p.Kind != credstore.KindRelayClient || tickets == nil {
		return false
	}
	ctx := c.Request.Context()
	first, err := tickets.ClaimRelayConnect(ctx, p.Handle)
	if err != nil {
		logger.Ctx(ctx).Warn("claim relay ticket connect failed, rejecting", zap.Error(err))
		return false
	}
	return first
}
