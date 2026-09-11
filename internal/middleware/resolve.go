package middleware

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// 本文件是三个鉴权中间件共用的**判定**：取 Bearer、解析 Bearer 凭据、会话查找。
//
// 判定与「失败时怎么终止」刻意分开：终止形态归各自的中间件，判定只能有这一份——三处各写
// 一遍时，往其中一处加一条校验而漏掉另一处不会有任何编译错误，只会留下一个能绕过它的入口。

// BearerResolver 是鉴权中间件对「这枚 Bearer 凭据属于谁」的全部需要。
//
// 设备入口上是 device_svc.Default()：按摘要查 MySQL，不经 Redis。中继客户端入口上是
// auth_svc.CredentialResolver，另外认得 server 记录的短效凭据。凭据本身不带任何可解析的
// 内容，身份只能由它交出。
type BearerResolver interface {
	ResolveBearer(ctx context.Context, token string) (*device_svc.Principal, error)
}

// bearerToken 取 Authorization 头里 Bearer 后面的凭据。presented 报告请求是否出示了
// Bearer；出示了但凭据为空时 token 是空串，由调用方按拒绝处理。
func bearerToken(c *gin.Context) (token string, presented bool) {
	return strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
}

// resolvePrincipal 把一枚 Bearer 凭据解析成调用方身份。失败时交回该用的 HTTP 状态与业务码，
// 由调用方决定怎么终止。
//
// 空令牌、未知、过期、所属设备已撤销、未装配解析方，一律 401 Unauthorized：对持有者是同一
// 件事。解析方自己出错（查库失败）不是对凭据的结论，答 500：否则客户端会把一次数据库抖动当成
// 凭据失效，去刷新甚至重新配对。短效凭据判不出来（Redis 不可用）则 fail-closed 答 401：设备
// access token 先于它判定、不受影响，走到这一步的只剩浏览器票据，而浏览器对 401 的反应就是
// 重取一张。令牌本身从不进日志。
func resolvePrincipal(c *gin.Context, tokens BearerResolver, token string) (*device_svc.Principal, int, int, bool) {
	if token == "" || tokens == nil {
		return nil, http.StatusUnauthorized, code.Unauthorized, false
	}
	ctx := c.Request.Context()
	p, err := tokens.ResolveBearer(ctx, token)
	switch {
	case err == nil && p != nil:
		return p, 0, 0, true
	case err == nil, errors.Is(err, device_svc.ErrBearerInvalid):
		return nil, http.StatusUnauthorized, code.Unauthorized, false
	case errors.Is(err, auth_svc.ErrCredentialUnverifiable):
		logger.Ctx(ctx).Warn("resolve short-lived credential failed, rejecting", zap.Error(err))
		return nil, http.StatusUnauthorized, code.Unauthorized, false
	default:
		logger.Ctx(ctx).Error("resolve bearer credential failed", zap.Error(err))
		return nil, http.StatusInternalServerError, code.ServerError, false
	}
}

// devicePrincipal 在 resolvePrincipal 之上只认属于某台设备的身份：票据与 server 自用凭据
// 解析得出来也进不了设备入口——凭据不串入口。
func devicePrincipal(c *gin.Context, tokens BearerResolver, token string) (*device_svc.Principal, int, int, bool) {
	p, status, businessCode, ok := resolvePrincipal(c, tokens, token)
	if ok && p.DeviceID == 0 {
		return nil, http.StatusUnauthorized, code.Unauthorized, false
	}
	return p, status, businessCode, ok
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

// setBearerPrincipal 把解析出的身份转交下游。三个接受 Bearer 的中间件共用，保证放行时
// 落下的是同一组身份；浏览器票据没有设备号，device_id 留 0、形态是 relay_client。
//
// 凭据句柄是「这条请求用的是哪一份凭据」。中继类长连接只在 upgrade 这一次经过鉴权中间件，
// 之后要靠它自己反复复查撤销，因此必须拿得到。
func setBearerPrincipal(c *gin.Context, p *device_svc.Principal) {
	ginctx.SetUserID(c, p.AccountID)
	ginctx.SetDevice(c, p.DeviceID, p.Kind)
	ginctx.SetCredentialHandle(c, p.Handle)
}

// setSessionPrincipal 把会话身份转交下游。会话分支没有设备号，device_id 因此留空。
func setSessionPrincipal(c *gin.Context, sess *session.Session) {
	ginctx.SetUserID(c, sess.UserID)
	ginctx.SetCSRFToken(c, sess.CSRFToken)
}
