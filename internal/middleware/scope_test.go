package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// principalSetter 模拟鉴权中间件已经放进上下文的身份。
func principalSetter(kind string, scopes ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		ginctx.SetUserID(c, 7)
		if kind != "" {
			ginctx.SetDevice(c, 0, kind)
		}
		ginctx.SetScopes(c, scopes)
	}
}

func runWith(t *testing.T, id gin.HandlerFunc, gate gin.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/x", id, gate, func(c *gin.Context) { c.String(http.StatusOK, "reached") })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	return w
}

func TestRequireScope(t *testing.T) {
	pat := device_svc.KindPersonalToken
	t.Run("personal token without the scope is refused with the exact text", func(t *testing.T) {
		w := runWith(t, principalSetter(pat, "chat"), middleware.RequireScope("devices:write"))
		assert.Equal(t, http.StatusForbidden, w.Code)
		assert.Contains(t, w.Body.String(), `"error":"token lacks scope devices:write"`)
		assert.Contains(t, w.Body.String(), `"msg":"token lacks scope devices:write"`)
	})
	t.Run("personal token with the scope passes", func(t *testing.T) {
		w := runWith(t, principalSetter(pat, "devices:write"), middleware.RequireScope("devices:write"))
		assert.Equal(t, http.StatusOK, w.Code)
	})
	t.Run("any one of several scopes passes; refusal names the first", func(t *testing.T) {
		assert.Equal(t, http.StatusOK, runWith(t, principalSetter(pat, "chat"), middleware.RequireScope("read", "chat")).Code)
		w := runWith(t, principalSetter(pat, "approve"), middleware.RequireScope("read", "chat"))
		assert.Equal(t, http.StatusForbidden, w.Code)
		assert.Contains(t, w.Body.String(), "token lacks scope read")
	})
	t.Run("personal token without any scope is refused", func(t *testing.T) {
		assert.Equal(t, http.StatusForbidden, runWith(t, principalSetter(pat), middleware.RequireScope("read")).Code)
	})
	t.Run("non-token principals are not scoped", func(t *testing.T) {
		for _, kind := range []string{"", device_entity.KindCLI, device_entity.KindAgentred, device_entity.KindDesktop} {
			assert.Equal(t, http.StatusOK, runWith(t, principalSetter(kind), middleware.RequireScope("devices:write")).Code, kind)
		}
	})
}

func TestDenyCLIAndTokens(t *testing.T) {
	for _, kind := range []string{device_entity.KindCLI, device_svc.KindPersonalToken} {
		assert.Equal(t, http.StatusForbidden, runWith(t, principalSetter(kind, "read"), middleware.DenyCLIAndTokens()).Code, kind)
	}
	for _, kind := range []string{device_entity.KindAgentred, device_entity.KindDesktop} {
		assert.Equal(t, http.StatusOK, runWith(t, principalSetter(kind), middleware.DenyCLIAndTokens()).Code, kind)
	}
}
