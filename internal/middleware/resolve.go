package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
)

// 本文件是三个鉴权中间件共用的**判定**：验签、黑名单、凭据形态、会话查找。
//
// 判定与「失败时怎么终止」刻意分开：DeviceJWT 要把 JWTSignatureInvalid /
// JWTBlacklisted 交给 daemon 区分该重签还是该重新配对，而 SessionOrDeviceAuth
// 只回一个笼统的 Unauthorized（它同时接受 cookie，说不清是哪条路走岔了）。
// 终止形态归各自的中间件，判定只能有这一份——三处各写一遍时，往其中一处加一条
// 校验而漏掉另一处不会有任何编译错误，只会留下一个能绕过它的入口。

// verifiedJWT 验一枚 Bearer 凭据：取头、验签、查黑名单。
// 失败时返回该用的业务码，由调用方决定怎么终止。
func verifiedJWT(c *gin.Context, signer *jwt.Signer) (*jwt.Claims, int, bool) {
	h := c.GetHeader("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return nil, code.Unauthorized, false
	}
	claims, err := signer.Verify(strings.TrimPrefix(h, "Bearer "))
	if err != nil {
		return nil, code.JWTSignatureInvalid, false
	}
	if jwtblacklist.Has(c.Request.Context(), claims.JTI) {
		return nil, code.JWTBlacklisted, false
	}
	return claims, 0, true
}

// isDeviceCredential 判定这枚凭据是不是一台真实设备的：浏览器的中继票据
// （relay_client）与没有设备号的凭据都不是，它们进不了普通设备端点。
func isDeviceCredential(claims *jwt.Claims) bool {
	return claims.Kind != "relay_client" && claims.DID != 0
}

// isRelayClientCredential 判定这枚凭据能不能连中继：普通设备凭据要有设备号，
// 浏览器票据则**必须**没有——一枚带设备号的 relay_client 是伪造出来的形状。
func isRelayClientCredential(claims *jwt.Claims) bool {
	if claims.Kind == "relay_client" {
		return claims.DID == 0
	}
	return claims.DID != 0
}

// sessionPrincipal 按 cookie 查登录会话，查不到（没带、已失效、查库出错）返回 false。
func sessionPrincipal(c *gin.Context) (*session.Session, bool) {
	sid, _ := c.Cookie(auth_svc.Default().CookieName())
	if sid == "" {
		return nil, false
	}
	sess, err := auth_svc.Default().GetSession(c.Request.Context(), sid)
	if err != nil || sess == nil {
		return nil, false
	}
	return sess, true
}

// setJWTClaims 把已验签的 claim 转交下游。三个接受 Bearer 的中间件共用，保证
// 放行时落下的是同一组 claim。
//
// jti 是「这条请求用的是哪一份凭据」的唯一标识。中继类长连接只在 upgrade 这一次
// 经过鉴权中间件，之后要靠它自己反复复查撤销，因此必须拿得到——这里只是转交已经
// 校验过的 claim，不改变任何验签判据。
func setJWTClaims(c *gin.Context, claims *jwt.Claims) {
	ginctx.SetUserID(c, claims.UID)
	ginctx.SetDevice(c, claims.DID, claims.Kind)
	ginctx.SetJTI(c, claims.JTI)
}

// setSessionPrincipal 把会话身份转交下游。会话分支没有设备号，device_id 因此留空。
func setSessionPrincipal(c *gin.Context, sess *session.Session) {
	ginctx.SetUserID(c, sess.UserID)
	ginctx.SetCSRFToken(c, sess.CSRFToken)
}
