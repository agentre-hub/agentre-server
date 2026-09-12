package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

/*
浏览器的票不该出现在 URL 里。

原生 WebSocket 可以通过第二个参数设置子协议（`new WebSocket(url, protocols)`），
不应把票据放进 query；URL 会被记录进 ingress access log、反代日志、浏览器 history
与 Referer，一处泄漏就是一段可用凭据。而**子协议列表是能设的**，
它走的是 Sec-WebSocket-Protocol 请求头，不进 URL。

所以票改走子协议：浏览器提两个，`agentre-protobuf` 与 `agentre.bearer.<token>`；
服务端从提议列表里取票、照常回选前者（后者只是载体，不参与协商）。

服务端只接受子协议中的票据；URL query 参数不参与认证。
*/
func TestRelayTokenBridge(t *testing.T) {
	gin.SetMode(gin.TestMode)
	seen := func(t *testing.T, req *http.Request) string {
		t.Helper()
		var got string
		r := gin.New()
		r.GET("/relay", relayTokenBridge(), func(c *gin.Context) {
			got = c.GetHeader("Authorization")
			c.Status(http.StatusOK)
		})
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code)
		return got
	}

	t.Run("票走子协议时搬进 Authorization", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/relay", nil)
		req.Header.Set("Sec-WebSocket-Protocol", "agentre-protobuf, agentre.bearer.tok-123")
		assert.Equal(t, "Bearer tok-123", seen(t, req))
	})

	t.Run("URL 上的票一概不认：它是会进日志的那一条", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/relay?access_token=tok-in-url", nil)
		assert.Empty(t, seen(t, req))
	})

	t.Run("已经带了 Authorization 的原生端不受影响", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/relay", nil)
		req.Header.Set("Sec-WebSocket-Protocol", "agentre-protobuf, agentre.bearer.tok-123")
		req.Header.Set("Authorization", "Bearer native")
		assert.Equal(t, "Bearer native", seen(t, req))
	})

	t.Run("只有子协议、没有票时什么都不搬", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/relay", nil)
		req.Header.Set("Sec-WebSocket-Protocol", "agentre-protobuf")
		assert.Empty(t, seen(t, req))
	})

	// 没有票时头保持为空 —— 后面的 RelayClientJWT 会照常拒绝，
	// 这一层不负责放行，也不该编一个空 Bearer 出来。
	t.Run("没有票时头保持为空", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/relay?daemon_fingerprint=fp-1", nil)
		assert.Empty(t, seen(t, req))
	})
}
