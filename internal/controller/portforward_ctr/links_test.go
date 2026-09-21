package portforward_ctr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

const (
	linksCookieName = "server_session"
	linksUserID     = int64(7)
	linksDeviceID   = int64(12)
	linksMappingID  = int64(3)
)

// stubLinkAllocator 实现 portforward_ctr.LinkAllocator（portforward_svc.Links 的
// ISP 窄接口）。
type stubLinkAllocator struct {
	link *portforward_svc.Link
	err  error
	// calls 记下每次分配问的是 (账号, 设备, 映射 id)。
	calls []struct{ userID, deviceID, mappingID int64 }
}

func (s *stubLinkAllocator) Link(_ context.Context, userID, deviceID, mappingID int64) (*portforward_svc.Link, error) {
	s.calls = append(s.calls, struct{ userID, deviceID, mappingID int64 }{userID, deviceID, mappingID})
	if s.err != nil {
		return nil, s.err
	}
	return s.link, nil
}

// linksHarness 装起真实的 device_svc.OwnedDevice（与 forward_test.go 同一条路：
// 只把 device_repo 换成 mockgen 的 mock），只有 LinkAllocator 是替身——分配器本身
// 的幂等 / 碰撞重试由 portforward_svc 自己的用例覆盖，这里只问「控制器把归属判定
// 与分配器接对了没有」。
type linksHarness struct {
	server  *httptest.Server
	devices *mock_device_repo.MockDeviceRepo
	links   *stubLinkAllocator
}

func newLinksHarness(t *testing.T) *linksHarness {
	t.Helper()
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), 86400)))
	device_svc.SetDefault(device_svc.New(device_svc.Config{}))

	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(devices)

	links := &stubLinkAllocator{}

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:              &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Bearer:           bearertest.Resolver{},
		PortForwardLinks: links,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	return &linksHarness{server: server, devices: devices, links: links}
}

func ownedDevice() *device_entity.Device {
	return &device_entity.Device{ID: linksDeviceID, UserID: linksUserID, Status: consts.ACTIVE}
}

func newSessionCookie(t *testing.T, userID int64) (string, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return sid, sess.CSRFToken
}

func doLinkRequest(t *testing.T, url, cookie, body string, csrf ...string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	require.NoError(t, err)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: linksCookieName, Value: cookie})
	}
	if len(csrf) > 0 && csrf[0] != "" {
		req.Header.Set("X-CSRF-Token", csrf[0])
	}
	// S1 加固之后同源写请求必须带这个头，否则 CSRF 中间件按 Sec-Fetch-Site 直接拒绝
	// ——这是在真实生产路径上跑，不是绕过它（memory: feedback_tests_must_hit_production_path）。
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

type linkEnvelope struct {
	Code int `json:"code"`
	Data struct {
		Prefix string `json:"prefix"`
		URL    string `json:"url"`
	} `json:"data"`
}

func decodeLinkResponse(t *testing.T, resp *http.Response) linkEnvelope {
	t.Helper()
	var envelope linkEnvelope
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	return envelope
}

// 对自己名下的设备申请前缀：分配器拿到的是会话里的账号、请求里的设备与映射 id。
func TestCreateLink_WorksForBrowserSession_OwnedDevice(t *testing.T) {
	h := newLinksHarness(t)
	h.devices.EXPECT().Find(gomock.Any(), linksDeviceID).Return(ownedDevice(), nil)
	h.links.link = &portforward_svc.Link{Prefix: "abcdefghijkl", URL: "http://abcdefghijkl.fw.agentre.docker.local:8443/"}
	cookie, csrf := newSessionCookie(t, linksUserID)

	resp := doLinkRequest(t, h.server.URL+"/v1/port-forwards/links", cookie,
		`{"device_id":12,"mapping_id":3}`, csrf)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	env := decodeLinkResponse(t, resp)
	assert.Equal(t, 0, env.Code)
	assert.Equal(t, "abcdefghijkl", env.Data.Prefix)
	assert.Equal(t, "http://abcdefghijkl.fw.agentre.docker.local:8443/", env.Data.URL)
	require.Len(t, h.links.calls, 1)
	assert.Equal(t, linksUserID, h.links.calls[0].userID)
	assert.Equal(t, linksDeviceID, h.links.calls[0].deviceID)
	assert.Equal(t, linksMappingID, h.links.calls[0].mappingID)
}

// 重复调用拿到同一个前缀（决策 2）：控制器本身不缓存，交回的是分配器给的值——真正的
// 幂等由 portforward_svc.Links 保证，这里断言控制器把它如实转发，且每次都真的问了
// 分配器（不会自己短路第二次调用）。
func TestCreateLink_RepeatCallsReturnTheAllocatorsIdempotentPrefix(t *testing.T) {
	h := newLinksHarness(t)
	h.devices.EXPECT().Find(gomock.Any(), linksDeviceID).Return(ownedDevice(), nil).Times(2)
	h.links.link = &portforward_svc.Link{Prefix: "stableprefix", URL: "https://stableprefix.fw.agentrehub.com/"}
	cookie, csrf := newSessionCookie(t, linksUserID)

	for range 2 {
		resp := doLinkRequest(t, h.server.URL+"/v1/port-forwards/links", cookie,
			`{"device_id":12,"mapping_id":3}`, csrf)
		env := decodeLinkResponse(t, resp)
		assert.Equal(t, "stableprefix", env.Data.Prefix)
	}
	assert.Len(t, h.links.calls, 2, "两次调用都必须真的问过分配器")
}

// 设备不是这个账号的：404，与「设备不存在」不可区分——同一个 DeviceNotFound 出口
// （device_svc.OwnedDevice 本身就是那份判定，UsableBy 里 user_id 对不上）。
func TestCreateLink_ForBrowserSession_RejectsForeignDevice(t *testing.T) {
	h := newLinksHarness(t)
	foreign := ownedDevice()
	foreign.UserID = 99
	h.devices.EXPECT().Find(gomock.Any(), linksDeviceID).Return(foreign, nil)
	cookie, csrf := newSessionCookie(t, linksUserID)

	resp := doLinkRequest(t, h.server.URL+"/v1/port-forwards/links", cookie,
		`{"device_id":12,"mapping_id":3}`, csrf)

	require.Equal(t, http.StatusNotFound, resp.StatusCode)
	env := decodeLinkResponse(t, resp)
	assert.Equal(t, code.DeviceNotFound, env.Code)
	assert.Empty(t, h.links.calls, "设备归属没过就不该再问分配器")
}

// 设备已撤销：与「不是你的」同一个答复。
func TestCreateLink_ForBrowserSession_RejectsRevokedDevice(t *testing.T) {
	h := newLinksHarness(t)
	revoked := ownedDevice()
	revoked.Status = consts.DELETE
	h.devices.EXPECT().Find(gomock.Any(), linksDeviceID).Return(revoked, nil)
	cookie, csrf := newSessionCookie(t, linksUserID)

	resp := doLinkRequest(t, h.server.URL+"/v1/port-forwards/links", cookie,
		`{"device_id":12,"mapping_id":3}`, csrf)

	require.Equal(t, http.StatusNotFound, resp.StatusCode)
	env := decodeLinkResponse(t, resp)
	assert.Equal(t, code.DeviceNotFound, env.Code)
	assert.Empty(t, h.links.calls)
}

// 设备不存在：与前两种同一个答复。
func TestCreateLink_ForBrowserSession_RejectsMissingDevice(t *testing.T) {
	h := newLinksHarness(t)
	h.devices.EXPECT().Find(gomock.Any(), linksDeviceID).Return(nil, nil)
	cookie, csrf := newSessionCookie(t, linksUserID)

	resp := doLinkRequest(t, h.server.URL+"/v1/port-forwards/links", cookie,
		`{"device_id":12,"mapping_id":3}`, csrf)

	require.Equal(t, http.StatusNotFound, resp.StatusCode)
	env := decodeLinkResponse(t, resp)
	assert.Equal(t, code.DeviceNotFound, env.Code)
	assert.Empty(t, h.links.calls)
}

// 没有配置 base_domain 的部署：分配器交回的错误原样透传，答复是「这个部署此刻提供
// 不了端口转发」而不是设备侧的 404。
func TestCreateLink_GivenNoBaseDomain_ReturnsUnavailable(t *testing.T) {
	h := newLinksHarness(t)
	h.devices.EXPECT().Find(gomock.Any(), linksDeviceID).Return(ownedDevice(), nil)
	h.links.err = i18n.NewErrorWithStatus(
		context.Background(), http.StatusServiceUnavailable, code.PortForwardLinksUnavailable)
	cookie, csrf := newSessionCookie(t, linksUserID)

	resp := doLinkRequest(t, h.server.URL+"/v1/port-forwards/links", cookie,
		`{"device_id":12,"mapping_id":3}`, csrf)

	require.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
	env := decodeLinkResponse(t, resp)
	assert.Equal(t, code.PortForwardLinksUnavailable, env.Code)
}

// 写操作必须过 CSRF：会话 cookie 没配 X-CSRF-Token 一律 403——这条端点走的是「浏览器
// session」那个中间件组，与 S1 既有约定同一条。
func TestCreateLink_ForBrowserSession_RejectsMissingCSRFToken(t *testing.T) {
	h := newLinksHarness(t)
	cookie, _ := newSessionCookie(t, linksUserID)

	resp := doLinkRequest(t, h.server.URL+"/v1/port-forwards/links", cookie,
		`{"device_id":12,"mapping_id":3}`)

	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.Empty(t, h.links.calls)
}

// 未登录：401，不问设备也不问分配器。
func TestCreateLink_RejectsAnonymousCaller(t *testing.T) {
	h := newLinksHarness(t)

	resp := doLinkRequest(t, h.server.URL+"/v1/port-forwards/links", "", `{"device_id":12,"mapping_id":3}`)

	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	assert.Empty(t, h.links.calls)
}
