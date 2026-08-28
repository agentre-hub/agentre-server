package middleware

import (
	"net/http"
	"strconv"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/pkg/ratelimit"
)

// perKeyLimit 是本文件全部限流中间件的**唯一**实现。
//
// 每个端点之间只有两处不同：Redis 里的计数前缀，以及「这一次算在谁头上」。把这
// 二十行按端点抄一遍的代价不是行数——是六份各自会漂移的 429 应答：某一份忘了
// Retry-After、某一份把 fail-open 写成 fail-closed，而这些差异不会有任何东西报错。
//
// 前缀必须各不相同：共用一个计数器时，一个端点被刷会把另外几个一起锁死，而它们的
// 发起方完全不同。
//
// keyOf 返回的第二个值是「这次请求受不受这道限流管辖」——按账号那道在取不到
// user_id 时不限流（交给后面的 handler 去回 401），按 IP 那道则一律管辖。
func perKeyLimit(prefix string, limit int64, keyOf func(*gin.Context) (string, bool)) gin.HandlerFunc {
	l := ratelimit.New(redis.Default(), prefix, limit, time.Minute)
	return func(c *gin.Context) {
		key, subject := keyOf(c)
		if !subject {
			c.Next()
			return
		}
		// 判不出来就放行（fail-open）：限流是防滥用，不是鉴权判定，一次 Redis
		// 抖动不该把正常用户挡在门外。account_gate 的 fail-closed 与此刻意相反。
		if ok, err := l.Allow(c.Request.Context(), key); err != nil || ok {
			c.Next()
			return
		}
		c.Header("Retry-After", "60")
		apierr.Abort(c, http.StatusTooManyRequests, code.OperationFailed)
	}
}

// byIP 按来源 IP 归集，一律受管辖。
func byIP(c *gin.Context) (string, bool) { return c.ClientIP(), true }

// byAccount 按账号归集。账号 id 由 SessionAuth 放进上下文，因此挂了这道限流的
// 分组必须排在它后面；取不到就不限流，让后面的 handler 去回 401。
func byAccount(c *gin.Context) (string, bool) {
	userID := ginctx.UserID(c)
	if userID == 0 {
		return "", false
	}
	return strconv.FormatInt(userID, 10), true
}

// AuthorizePerIPLimit：每 IP 每分钟最多 N 次（设备流）。
func AuthorizePerIPLimit(limit int64) gin.HandlerFunc {
	return perKeyLimit("rl:authz:", limit, byIP)
}

// GithubAuthorizePerIPLimit：GitHub OAuth authorize 端点的 IP 限流。与设备流 Authorize 用独立计数前缀。
func GithubAuthorizePerIPLimit(limit int64) gin.HandlerFunc {
	return perKeyLimit("rl:github_authz:", limit, byIP)
}

// GithubCallbackPerIPLimit：GitHub OAuth callback 端点的 IP 限流。与设备流 Authorize 用独立计数前缀。
func GithubCallbackPerIPLimit(limit int64) gin.HandlerFunc {
	return perKeyLimit("rl:github_callback:", limit, byIP)
}

// PasskeyRegisterBeginPerIPLimit：通行密钥注册 begin 端点的 IP 限流。与设备流
// Authorize、GitHub OAuth 各用独立计数前缀——一个端点被刷不该把另外几个一起锁死。
func PasskeyRegisterBeginPerIPLimit(limit int64) gin.HandlerFunc {
	return perKeyLimit("rl:passkey_reg_begin_ip:", limit, byIP)
}

// PasskeyRegisterBeginPerAccountLimit：通行密钥注册 begin 端点的**账号**限流。
//
// 按 IP 限流挡不住这一路：注册要求已登录，一个账号完全可以从任意多个出口发起，
// 每次都在 Redis 上留一条 challenge。它必须跑在 SessionAuth 之后。
func PasskeyRegisterBeginPerAccountLimit(limit int64) gin.HandlerFunc {
	return perKeyLimit("rl:passkey_reg_begin_acct:", limit, byAccount)
}

// PasskeyLoginBeginPerIPLimit：通行密钥**登录** begin 端点的 IP 限流。
//
// 只有按 IP 这一道：登录不要求任何标识（决策 10），此刻还没有账号可以按。计数前缀
// 与注册那道分开——共用一个计数器，一次登录洪水就会把注册一起锁死，而这两件事的
// 发起方完全不同。
func PasskeyLoginBeginPerIPLimit(limit int64) gin.HandlerFunc {
	return perKeyLimit("rl:passkey_login_begin_ip:", limit, byIP)
}
