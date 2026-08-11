package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// 浏览器原生 WebSocket 无法设置自定义请求头,连 /v1/relay/client 的设备 JWT 只能
// 走 query(access_token)。queryTokenBridge 把 query 里的 token 搬到 Authorization
// 头,让既有的 DeviceJWT 中间件原样复用(校验 + 黑名单),不引入第二套鉴权。
func TestQueryTokenBridge_CopiesQueryTokenIntoAuthorization(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	var seen string
	router.GET("/v1/relay/client", queryTokenBridge(), func(c *gin.Context) {
		seen = c.GetHeader("Authorization")
	})

	request := httptest.NewRequest(http.MethodGet, "/v1/relay/client?daemon_fingerprint=fp-1&access_token=jwt-abc", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "Bearer jwt-abc", seen)
}

// Authorization 头在场时以头为准,query 的 access_token 不覆盖 —— 桌面端等能设头的
// 客户端仍然走原有的 Bearer 头,行为不变。
func TestQueryTokenBridge_PrefersAuthorizationHeaderOverQuery(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	var seen string
	router.GET("/v1/relay/client", queryTokenBridge(), func(c *gin.Context) {
		seen = c.GetHeader("Authorization")
	})

	request := httptest.NewRequest(http.MethodGet, "/v1/relay/client?access_token=query-token", nil)
	request.Header.Set("Authorization", "Bearer header-token")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "Bearer header-token", seen)
}

// query 里没有 token 时头保持为空 —— DeviceJWT 中间件会照常拒绝,不在这里放行。
func TestQueryTokenBridge_LeavesAuthorizationEmptyWhenNoToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	var seen string
	router.GET("/v1/relay/client", queryTokenBridge(), func(c *gin.Context) {
		seen = c.GetHeader("Authorization")
	})

	request := httptest.NewRequest(http.MethodGet, "/v1/relay/client?daemon_fingerprint=fp-1", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "", seen)
}
