package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
)

// clientIPSeenBy 把「这次请求的来源 IP 是谁」这个判定摆到可观察的位置。
//
// 判定归 gin 的 c.ClientIP()，而它的答案完全取决于引擎上那两格设置
// （ForwardedByClientIP + trustedProxies）—— 所有按 IP 归集的限流都读这一个值
// （middleware.byIP），/account 的会话清单展示的登录 IP 也是它。探针路由由用例自己
// 挂上去，被测的是**装配好的那台引擎**，那正是生产上 cago 交给 Router 的那一台。
func clientIPSeenBy(t *testing.T, cfg *bootstrap.ServerConfig, remoteAddr string, forwardedFor string) string {
	t.Helper()
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&RouterDeps{Cfg: cfg}).Router(context.Background(), testMux.Router))
	engine := testMux.IRouter.(*gin.Engine)
	engine.GET("/__client_ip", func(c *gin.Context) { c.String(http.StatusOK, c.ClientIP()) })

	request := httptest.NewRequest(http.MethodGet, "/__client_ip", nil)
	request.RemoteAddr = remoteAddr
	if forwardedFor != "" {
		request.Header.Set("X-Forwarded-For", forwardedFor)
	}
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
	return recorder.Body.String()
}

// Given 没有配置可信代理（缺省）；When 一个请求自带 X-Forwarded-For；
// Then 来源 IP 仍然取实际连上来的那一端。
//
// gin 的缺省是「谁都信」（trustedProxies = 0.0.0.0/0 + ::/0，ForwardedByClientIP
// 为真），于是 ClientIP() 交出 XFF 最左边那一格 —— 一个**请求方自己填的**值。所有
// 按 IP 的限流都按它归集，所以那一格能被伪造就等于设备流 authorize、GitHub OAuth、
// 通行密钥登录的每分钟配额全部形同不存在：换一个 XFF 就是一个新的配额桶。
// compose 那条部署路径上 8443 直接映射到宿主、前面没有反代，攻击者就是「实际连上来
// 的那一端」。
func TestRouter_NoTrustedProxyConfigured_ClientIPIgnoresForwardedFor(t *testing.T) {
	got := clientIPSeenBy(t, &bootstrap.ServerConfig{}, "198.51.100.7:41234", "1.2.3.4")

	assert.Equal(t, "198.51.100.7", got,
		"没有声明可信代理时，XFF 是请求方自己填的，不能拿它当来源 IP")
}

// Given 部署方声明了自己那一跳反代；When 请求确实来自那一跳、并带着它填的 XFF；
// Then 来源 IP 取 XFF —— 这条旋钮存在的理由：反代后面 RemoteAddr 恒为反代自己。
func TestRouter_TrustedProxyConfigured_ClientIPComesFromForwardedFor(t *testing.T) {
	cfg := &bootstrap.ServerConfig{TrustedProxies: []string{"198.51.100.0/24"}}

	got := clientIPSeenBy(t, cfg, "198.51.100.7:41234", "1.2.3.4")

	assert.Equal(t, "1.2.3.4", got, "来自可信代理的 XFF 就是来源 IP")
}

// Given 部署方声明了一跳可信代理；When 请求绕过它直连；Then XFF 不算。
//
// 这一条与上一条成对：只有上一条时，一个「把所有代理都信了」的实现照样绿。
func TestRouter_TrustedProxyConfigured_DirectRequestStillIgnoresForwardedFor(t *testing.T) {
	cfg := &bootstrap.ServerConfig{TrustedProxies: []string{"198.51.100.0/24"}}

	got := clientIPSeenBy(t, cfg, "203.0.113.9:41234", "1.2.3.4")

	assert.Equal(t, "203.0.113.9", got, "没经过可信代理的请求，它的 XFF 不作数")
}

// Given 可信代理写错了（不是 IP 也不是 CIDR）；When 进程启动；Then 装配失败。
//
// 安静忽略的代价是「配了跟没配一样」：运维以为限流按真实客户端 IP 归集，实际上整套
// 按 IP 的配额都还在按一个可伪造的值算，而没有任何东西会说一句。
func TestRouter_MalformedTrustedProxy_FailsAssembly(t *testing.T) {
	testMux := muxtest.NewTestMux()
	cfg := &bootstrap.ServerConfig{TrustedProxies: []string{"not-an-ip"}}

	err := (&RouterDeps{Cfg: cfg}).Router(context.Background(), testMux.Router)

	require.Error(t, err, "写错的可信代理必须让启动失败，而不是安静地退回「谁都信」")
	assert.Contains(t, err.Error(), "trusted")
}
