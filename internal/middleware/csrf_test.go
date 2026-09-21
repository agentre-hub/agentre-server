package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
)

// withCSRFToken 模拟 session 分支已经把这次会话的 CSRF token 放进上下文——
// CSRF() 本身不管它从哪来，只负责比对，也只负责本文件要测的加固层（Sec-Fetch-Site
// / Origin）。
func withCSRFToken(token string) gin.HandlerFunc {
	return func(c *gin.Context) { c.Set(ginctx.KeyCSRFToken, token) }
}

func csrfRoute(allowedOrigins []string) *gin.Engine {
	r := gin.New()
	r.POST("/write", withCSRFToken("tok"), middleware.CSRF(allowedOrigins), func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	r.GET("/read", withCSRFToken("tok"), middleware.CSRF(allowedOrigins), func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	return r
}

func doWrite(r *gin.Engine, secFetchSite, origin, csrf string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/write", nil)
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	if secFetchSite != "" {
		req.Header.Set("Sec-Fetch-Site", secFetchSite)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestCSRF_SecFetchSiteSameOrigin_Passes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := csrfRoute([]string{"https://console.example"})
	w := doWrite(r, "same-origin", "", "tok")
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestCSRF_SecFetchSiteNone_Passes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := csrfRoute([]string{"https://console.example"})
	w := doWrite(r, "none", "", "tok")
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestCSRF_SecFetchSiteCrossSite_Rejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := csrfRoute([]string{"https://console.example"})
	w := doWrite(r, "cross-site", "", "tok")
	assert.Equal(t, http.StatusForbidden, w.Code)
}

func TestCSRF_SecFetchSiteSameSite_Rejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := csrfRoute([]string{"https://console.example"})
	w := doWrite(r, "same-site", "", "tok")
	assert.Equal(t, http.StatusForbidden, w.Code)
}

// 没有 Sec-Fetch-Site 时退回校验 Origin：命中允许名单才放行。
func TestCSRF_NoSecFetchSite_FallsBackToMatchingOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := csrfRoute([]string{"https://console.example"})
	w := doWrite(r, "", "https://console.example", "tok")
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestCSRF_NoSecFetchSite_MismatchedOriginRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := csrfRoute([]string{"https://console.example"})
	w := doWrite(r, "", "https://evil.example", "tok")
	assert.Equal(t, http.StatusForbidden, w.Code)
}

// 两个头都没有：与今天 CSRF 失败的答复相同，403，不悄悄放行。
func TestCSRF_NeitherHeaderPresent_Rejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := csrfRoute([]string{"https://console.example"})
	w := doWrite(r, "", "", "tok")
	assert.Equal(t, http.StatusForbidden, w.Code)
}

// 安全方法（GET）不受这道加固影响，和既有 csrfOK 的豁免一致。
func TestCSRF_SafeMethodBypassesOriginCheck(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := csrfRoute([]string{"https://console.example"})
	req := httptest.NewRequest(http.MethodGet, "/read", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

// 缺 CSRF token 时即便 Origin/Sec-Fetch-Site 都对，仍然要 403——这是两道独立的
// 判据，都要满足。
func TestCSRF_MissingTokenStillRejectedEvenWithGoodOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := csrfRoute([]string{"https://console.example"})
	w := doWrite(r, "same-origin", "", "")
	assert.Equal(t, http.StatusForbidden, w.Code)
}
