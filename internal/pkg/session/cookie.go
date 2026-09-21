package session

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// cookieMaxAge 是会话 cookie 的存活秒数（14 天）。
//
// 与 Store 的滑动 TTL 是两回事：这个数决定浏览器什么时候自己丢掉这张票，
// 那个数决定 Redis 什么时候丢掉会话本身。
const cookieMaxAge = 14 * 24 * 3600

// SetCookie 下发会话 cookie。
//
// 每条能建立会话的路径都调它，一个都不许自己抄一份：GitHub 回调与通行密钥登录
// 各写一遍的代价是「同一个账号的两次登录发出的票不一样」——少一个 HttpOnly 就是
// 一条 XSS 读得到的票，少一个 Secure 就是一张会走明文的票，而这种差异不会有任何
// 东西报错，只会在某一条路径上安静地弱下去。
//
// insecure 只在开发态为真（本地 HTTP 调试），它取反就是 Secure。
func SetCookie(c *gin.Context, name, value string, insecure bool) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(name, value, cookieMaxAge, "/", "", !insecure, true)
}

// ClearCookie 让会话 cookie 当场过期。
//
// Secure 按名字反推，不是入参：`__Host-` 前缀的 cookie 要求浏览器只认带 Secure
// 的 Set-Cookie，缺了它浏览器会整条丢弃这次删除指令，于是「登出了」而 __Host-
// 那张票还在。反过来，http（dev）部署下的 server_session 不带 __Host- 前缀，这里
// 也不给它 Secure——登出必须在任何场景下都真的把票删掉，一张带 Secure 的删除指令
// 在 HTTP 页面上会被浏览器忽略。
func ClearCookie(c *gin.Context, name string) {
	secure := strings.HasPrefix(name, "__Host-")
	c.SetCookie(name, "", -1, "/", "", secure, true)
}

// forwardCookieBase 是端口转发票的基础名（规格 2026-09-21-port-forward-subdomain
// 「转发登录」第 4 步）。它写在 <前缀>.<base_domain> 上、host-only，与控制台会话
// cookie 永远不在同一个 host 上相遇。
const forwardCookieBase = "agentre_fw"

// ForwardCookieName 是转发票这次部署该用的名字：https 下带 __Host- 前缀（浏览器保证
// 同站的兄弟子域种不进来），http（dev）下不带——与 auth_svc.CookieName() 同一个判据
// （PublicURL 的 scheme），SetCookie / ClearCookie 据此给出匹配的 Secure。
func ForwardCookieName(secure bool) string {
	if secure {
		return "__Host-" + forwardCookieBase
	}
	return forwardCookieBase
}
