package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// agrctl 资源接口（spec 2026-09-22「server 执行者」）只认设备 Bearer：没有凭据、或只
// 拿着浏览器会话 cookie 的请求一律 401；设备令牌能打到它（不是「没有这条路由」的 404）。
func TestRouter_CtlResourcesAcceptsOnlyDeviceBearer(t *testing.T) {
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&RouterDeps{
		Cfg: &bootstrap.ServerConfig{}, Bearer: bearertest.Resolver{},
	}).Router(context.Background(), testMux.Router))
	engine := testMux.IRouter.(*gin.Engine)

	do := func(header, value string) int {
		req := httptest.NewRequest(http.MethodPost, "/v1/ctl/resources", strings.NewReader(`{}`))
		if header != "" {
			req.Header.Set(header, value)
		}
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		return rec.Code
	}

	require.Equal(t, http.StatusUnauthorized, do("", ""), "没有凭据")
	require.Equal(t, http.StatusUnauthorized, do("Cookie", "server_session=browser"), "浏览器会话不算")
	token := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 3, Kind: device_entity.KindAgentred})
	code := do("Authorization", "Bearer "+token)
	require.NotEqual(t, http.StatusNotFound, code, "设备令牌必须打得到这条路由")
	require.NotEqual(t, http.StatusUnauthorized, code)
}
