package middleware

import (
	"net/http"
	"slices"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
)

// csrfOK 判定一次请求是否清过 CSRF：安全方法直接放行，写方法必须出示与会话
// 匹配的 X-CSRF-Token。CSRF() 与 SessionOrDeviceAuth 的 session 分支共用它，
// 保证「凭 cookie 鉴权的写操作」在两处是同一条判据。
func csrfOK(c *gin.Context, expected string) bool {
	switch c.Request.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	if expected == "" {
		return false
	}
	got := c.GetHeader("X-CSRF-Token")
	return got == expected
}

// originOK 是 CSRF token 之外的第二道判据：token 只证明请求方读得到这次会话的
// CSRF 页面（同源限制的产物），Sec-Fetch-Site / Origin 直接问浏览器「这个请求是
// 从哪个站点发起的」，两者互不替代。安全方法与 csrfOK 同一豁免。
//
// 优先信 Sec-Fetch-Site：现代浏览器给同源请求带 same-origin，给没有发起方页面的
// 请求（地址栏直接输入、书签）带 none，这两种之外（same-site、cross-site）都不算数
// ——同站但跨源的场景（*.fw.<base_domain> 转发域）必须按 cross-site 处理，否则转发
// 域上的页面就能借同站关系发起写请求。没有这个头（老浏览器、某些代理会剥掉 Fetch
// Metadata 头）时退回校验 Origin：必须命中允许名单，命中的判据是完全相等，不做
// 前缀或后缀匹配——子域的口子必须显式加进名单，不能因为「看着像」就默认放行。
// 两个头都没有就按不满足处理：这本来就是「结构性绕不开」的加固层，宁可错杀，
// 答复与今天 CSRF 失败一样，都是 403。
func originOK(c *gin.Context, allowedOrigins []string) bool {
	switch c.Request.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	if site := c.GetHeader("Sec-Fetch-Site"); site != "" {
		return site == "same-origin" || site == "none"
	}
	origin := c.GetHeader("Origin")
	if origin == "" {
		return false
	}
	return slices.Contains(allowedOrigins, origin)
}

// CSRF 校验凭 cookie 鉴权的写请求：CSRF token 匹配、且 Sec-Fetch-Site/Origin 落在
// allowedOrigins 圈定的来源里，两条判据都要满足。allowedOrigins 是控制台自己的
// origin（PublicURL 推出）加已配置的 origins（webauthn.origins），即 router.go 传入的
// cfg.ConsoleOrigins()——WebAuthn 的 Relying Party 校验与这里问的是同一件事：这个
// 请求真的来自控制台自己吗。
func CSRF(allowedOrigins []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !csrfOK(c, ginctx.CSRFToken(c)) || !originOK(c, allowedOrigins) {
			abortForbidden(c)
			return
		}
		c.Next()
	}
}

func abortForbidden(c *gin.Context) {
	apierr.Abort(c, http.StatusForbidden, code.Forbidden)
}
