package release_ctr_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/release_svc"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

const testCookieName = "server_session"

// stubRelease 顶替 release_svc.ReleaseSvc：控制器这一层只证明「服务说了什么就原样
// 落进 JSON」，不重复服务层已经证明过的判定。
type stubRelease struct {
	release_svc.ReleaseSvc
	latest release_svc.Latest
	found  bool
	err    error
}

func (s *stubRelease) Latest(context.Context) (release_svc.Latest, bool, error) {
	return s.latest, s.found, s.err
}

func serve(t *testing.T, svc release_svc.ReleaseSvc) (*httptest.Server, string, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	release_svc.SetDefault(svc)
	t.Cleanup(func() { release_svc.SetDefault(nil) })
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	tm := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Signer: signer,
	}).Router(context.Background(), tm.Router))
	server := httptest.NewServer(tm.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	sid, _, err := auth_svc.Default().StartSession(context.Background(), 7)
	require.NoError(t, err)
	return server, sid, testCookieName
}

func get(t *testing.T, url, sessionID, cookieName string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	require.NoError(t, err)
	if sessionID != "" {
		req.AddCookie(&http.Cookie{Name: cookieName, Value: sessionID})
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// Given 服务层如实答「不知道」；When 浏览器读端点；Then 响应体是 known:false 且不带
// version——不能借「没有值」冒充「已是最新」（决策 19）。
func TestLatest_ServiceAnswersUnknown_ResponseSaysUnknown(t *testing.T) {
	server, sid, cookieName := serve(t, &stubRelease{found: false})

	resp := get(t, server.URL+"/v1/release/latest", sid, cookieName)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	body := readData(t, resp)
	assert.Contains(t, body, `"known":false`)
	assert.NotContains(t, body, `"version"`)
}

// Given 服务层给出一次成功拉取过的版本号；When 浏览器读端点；Then 原样落到响应里。
func TestLatest_ServiceHasCachedVersion_ResponseCarriesIt(t *testing.T) {
	server, sid, cookieName := serve(t, &stubRelease{
		found: true, latest: release_svc.Latest{Version: "0.3.0"},
	})

	resp := get(t, server.URL+"/v1/release/latest", sid, cookieName)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	body := readData(t, resp)
	assert.Contains(t, body, `"known":true`)
	assert.Contains(t, body, `"version":"0.3.0"`)
}

// 服务层真的坏掉（不是「不知道」，是 Redis 读错）时端点不能悄悄说「不知道」——那会把
// 一次基础设施故障伪装成一个正常结果。
func TestLatest_ServiceErrors_RequestFails(t *testing.T) {
	server, sid, cookieName := serve(t, &stubRelease{err: errors.New("redis down")})

	resp := get(t, server.URL+"/v1/release/latest", sid, cookieName)

	assert.NotEqual(t, http.StatusOK, resp.StatusCode)
}

func readData(t *testing.T, resp *http.Response) string {
	t.Helper()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return string(raw)
}
