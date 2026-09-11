package middleware

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/relayticket"
)

// DeviceJWT 只放行设备 access token：按摘要解析出一台仍在用的设备，再过账号闸门。
// 浏览器的中继票据进不来。判定只读 MySQL，Redis 不可用不影响它。
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
		setDevicePrincipal(c, p)
		c.Next()
	}
}

// relayTicketBurnTTL 是焚毁记号的存活时间:盖住票自己的有效期(签发处的
// relayTicketTTL,2 分钟)再加上验签允许的时钟偏移就够 —— 票在那之后本来就验不过,
// 记号活得更久没有意义。
const relayTicketBurnTTL = 2*time.Minute + jwt.Leeway

// consumeBrowserTicket 认领这张浏览器票据。已经用过、或判不出来,都当场拒掉
// (fail-closed,理由见 relayticket.Consume)。
func consumeBrowserTicket(c *gin.Context, jti string, tickets *relayticket.Tickets) bool {
	first, err := tickets.Consume(c.Request.Context(), jti, relayTicketBurnTTL)
	if err != nil || !first {
		apierr.Abort(c, http.StatusUnauthorized, code.Unauthorized)
		return false
	}
	return true
}

// RelayClientJWT accepts native clients' device access tokens and the browser's
// short-lived relay_client ticket. The latter is deliberately rejected by DeviceJWT.
//
// 票据仍是 JWT：验得过签就只按票据判（形状、黑名单、用后即焚）。设备 access token 是不透明
// 随机串，验签必然不过，落到与 DeviceJWT 同一条摘要解析上——判据与那边逐条相同。
func RelayClientJWT(tokens BearerResolver, signer *jwt.Signer, blacklist *jwtblacklist.Blacklist,
	tickets *relayticket.Tickets) gin.HandlerFunc {
	return func(c *gin.Context) {
		token, _ := bearerToken(c)
		if claims, err := signer.Verify(token); err == nil {
			if !isRelayTicket(claims) {
				apierr.Abort(c, http.StatusUnauthorized, code.Unauthorized)
				return
			}
			if blacklist.Has(c.Request.Context(), claims.JTI) {
				apierr.Abort(c, http.StatusUnauthorized, code.JWTBlacklisted)
				return
			}
			// 浏览器票据用后即焚，见 auth_svc.ConsumeRelayTicket。原生端的设备 access token
			// 不在此列：它是长期凭据，本来就要反复使用。
			if !consumeBrowserTicket(c, claims.JTI, tickets) {
				return
			}
			if accountBlocked(c, claims.UID) {
				return
			}
			setTicketPrincipal(c, claims)
			c.Next()
			return
		}
		p, status, businessCode, ok := devicePrincipal(c, tokens, token)
		if !ok {
			apierr.Abort(c, status, businessCode)
			return
		}
		if accountBlocked(c, p.AccountID) {
			return
		}
		setDevicePrincipal(c, p)
		c.Next()
	}
}
