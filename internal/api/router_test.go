package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
)

// S6：凭据不再由签名密钥自证，公钥端点随之去除。
func TestRouter_PublicKeysEndpointIsGone(t *testing.T) {
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&RouterDeps{Cfg: &bootstrap.ServerConfig{}}).Router(context.Background(), testMux.Router))
	recorder := httptest.NewRecorder()
	testMux.IRouter.(*gin.Engine).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/keys", nil))
	require.Equal(t, http.StatusNotFound, recorder.Code)
}

// S3：单模型写入端点必须绑进路由树才能被浏览器打到。未绑时 gin 对这三条路径一律
// 404（连鉴权中间件都不会跑）；绑了之后 SessionAuth 中间件会先接手，无会话 cookie
// 时应答 401，不再是「压根没有这条路由」的 404——这条区分正是这里要钉住的。
func TestRouter_ProviderModelEndpointsAreBound(t *testing.T) {
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&RouterDeps{Cfg: &bootstrap.ServerConfig{}}).Router(context.Background(), testMux.Router))
	engine := testMux.IRouter.(*gin.Engine)

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/v1/engine/providers/anthropic-main/models"},
		{http.MethodPatch, "/v1/engine/providers/anthropic-main/models/sonnet"},
		{http.MethodDelete, "/v1/engine/providers/anthropic-main/models/sonnet"},
	}
	for _, c := range cases {
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, httptest.NewRequest(c.method, c.path, nil))
		require.NotEqualf(t, http.StatusNotFound, recorder.Code, "%s %s must be bound in the route tree", c.method, c.path)
	}
}
