package middleware

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/relayticket"
)

func DeviceJWT(signer *jwt.Signer) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims, biz, ok := verifiedJWT(c, signer)
		if !ok {
			apierr.Abort(c, http.StatusUnauthorized, biz)
			return
		}
		if !isDeviceCredential(claims) {
			apierr.Abort(c, http.StatusUnauthorized, code.Unauthorized)
			return
		}
		if accountBlocked(c, claims.UID) {
			return
		}
		setJWTClaims(c, claims)
		c.Next()
	}
}

// relayTicketBurnTTL 是焚毁记号的存活时间:盖住票自己的有效期(签发处的
// relayTicketTTL,2 分钟)再加上验签允许的时钟偏移就够 —— 票在那之后本来就验不过,
// 记号活得更久没有意义。
const relayTicketBurnTTL = 2*time.Minute + jwt.Leeway

// consumeBrowserTicket 认领这张浏览器票据。已经用过、或判不出来,都当场拒掉
// (fail-closed,理由见 relayticket.Consume)。
func consumeBrowserTicket(c *gin.Context, jti string) bool {
	first, err := relayticket.Consume(c.Request.Context(), jti, relayTicketBurnTTL)
	if err != nil || !first {
		apierr.Abort(c, http.StatusUnauthorized, code.Unauthorized)
		return false
	}
	return true
}

// RelayClientJWT accepts ordinary device JWTs for native clients and the browser's
// short-lived relay_client ticket. The latter is deliberately rejected by DeviceJWT.
func RelayClientJWT(signer *jwt.Signer) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims, biz, ok := verifiedJWT(c, signer)
		if !ok {
			apierr.Abort(c, http.StatusUnauthorized, biz)
			return
		}
		if !isRelayClientCredential(claims) {
			apierr.Abort(c, http.StatusUnauthorized, code.Unauthorized)
			return
		}
		// 浏览器票据用后即焚，见 auth_svc.ConsumeRelayTicket。原生端的设备 JWT
		// (DID != 0) 不在此列:它是长期凭据,本来就要反复使用。
		if claims.Kind == "relay_client" && !consumeBrowserTicket(c, claims.JTI) {
			return
		}
		if accountBlocked(c, claims.UID) {
			return
		}
		setJWTClaims(c, claims)
		c.Next()
	}
}
