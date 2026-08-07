package device_ctr_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/api"
	api_device "agentre-server/internal/api/device"
	"agentre-server/internal/bootstrap"
	"agentre-server/internal/middleware"
	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/pkg/session"
	"agentre-server/internal/service/auth_svc"
	"agentre-server/internal/service/device_svc"
)

const testCookieName = "server_session"

// stubDeviceSvc 实现 device_svc.DeviceSvc，只覆盖本测试用到的端点。
type stubDeviceSvc struct {
	userDevices []api_device.ListDevicesItem
	revoked     []int64
	revokedJTI  []string
}

func (s *stubDeviceSvc) Authorize(context.Context, device_svc.AuthorizeInput) (*device_svc.AuthorizeOutput, error) {
	return nil, errors.New("unimplemented")
}
func (s *stubDeviceSvc) Pending(context.Context, string) (*device_svc.PendingInfo, error) {
	return nil, errors.New("unimplemented")
}
func (s *stubDeviceSvc) Approve(context.Context, string, int64) (string, error) {
	return "", errors.New("unimplemented")
}
func (s *stubDeviceSvc) Deny(context.Context, string) error { return errors.New("unimplemented") }
func (s *stubDeviceSvc) ExchangeToken(context.Context, string) (*device_svc.TokenOutput, error) {
	return nil, errors.New("unimplemented")
}
func (s *stubDeviceSvc) Refresh(context.Context, string) (*device_svc.TokenOutput, error) {
	return nil, errors.New("unimplemented")
}
func (s *stubDeviceSvc) Revoke(_ context.Context, deviceID int64) error {
	s.revoked = append(s.revoked, deviceID)
	return nil
}
func (s *stubDeviceSvc) ListUserDevices(context.Context, int64, int64) ([]api_device.ListDevicesItem, error) {
	return s.userDevices, nil
}
func (s *stubDeviceSvc) ListRevokedJTI(context.Context, int64) ([]string, error) {
	return s.revokedJTI, nil
}

var _ device_svc.DeviceSvc = (*stubDeviceSvc)(nil)

func newDeviceTestServer(t *testing.T, stub *stubDeviceSvc) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	device_svc.SetDefault(stub)
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{},
		Signer: signer,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server, signer
}

// newSessionCookie 返回会话 cookie 及其配套的 CSRF token —— 浏览器 session 的
// 写操作必须同时出示两者（middleware.CSRF 的既有约定）。
func newSessionCookie(t *testing.T, userID int64) (*http.Cookie, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return &http.Cookie{Name: testCookieName, Value: sid}, sess.CSRFToken
}

// doRequest 的可选第 6 个参数是 X-CSRF-Token 头；不传即不带该头。
func doRequest(t *testing.T, method, url, cookie, bearer, body string, csrf ...string) *http.Response {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	require.NoError(t, err)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: testCookieName, Value: cookie})
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if len(csrf) > 0 && csrf[0] != "" {
		req.Header.Set("X-CSRF-Token", csrf[0])
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func deviceListBody() []api_device.ListDevicesItem {
	return []api_device.ListDevicesItem{
		{ID: 1, Name: "nuc-01", Kind: device_entity.KindAgentred, Platform: "linux", Version: "0.4.0", Status: 1},
		{ID: 2, Name: "laptop", Kind: device_entity.KindDesktop, Platform: "darwin", Version: "0.3.0", Status: 1},
	}
}

// 浏览器 session 登录的 web 端必须能列出账号下的设备。
func TestListDevices_WorksForBrowserSession(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: deviceListBody()}
	server, _ := newDeviceTestServer(t, stub)
	cookie, _ := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodGet, server.URL+"/v1/devices", cookie.Value, "", "")
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Devices []api_device.ListDevicesItem `json:"devices"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.Equal(t, 0, envelope.Code)
	require.Len(t, envelope.Data.Devices, 2)
	require.Equal(t, "nuc-01", envelope.Data.Devices[0].Name)
}

// 浏览器 session 可以撤销自己账号下的一台设备。
func TestRevoke_WorksForBrowserSession_OwnedDevice(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: deviceListBody()}
	server, _ := newDeviceTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/oauth/token/revoke",
		cookie.Value, "", `{"device_id":1}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, []int64{1}, stub.revoked)
}

// 浏览器 session 不能撤销不属于自己账号的设备。
func TestRevoke_ForBrowserSession_RejectsForeignDevice(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: deviceListBody()}
	server, _ := newDeviceTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/oauth/token/revoke",
		cookie.Value, "", `{"device_id":99}`, csrf)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.Empty(t, stub.revoked)
}

// 设备管理页把 /v1/oauth/token/revoke 变成了第一个「带 cookie 就能调」的写端点。
// 浏览器 session 的写操作一律要过 CSRF（router.go 的 SessionAuth()+CSRF() 组:
// logout / approve / deny 都是如此），撤销设备不能是例外 —— 否则任意站点都能
// 用用户挂着的会话把他的设备踢下线。
func TestRevoke_ForBrowserSession_RejectsMissingCSRFToken(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: deviceListBody()}
	server, _ := newDeviceTestServer(t, stub)
	cookie, _ := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/oauth/token/revoke",
		cookie.Value, "", `{"device_id":1}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.Empty(t, stub.revoked)
}

// 反过来：Bearer 设备 JWT 不带 cookie，结构上就不受 CSRF 威胁，
// 桌面端登出（server_svc/logout.go）不出示 CSRF 头也必须照常工作。
func TestRevoke_DeviceJWT_NeedsNoCSRFToken(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: deviceListBody()}
	server, signer := newDeviceTestServer(t, stub)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 1, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/oauth/token/revoke",
		"", token, `{"device_id":1}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, []int64{1}, stub.revoked)
}

// 设备 JWT 调用方仍然只能撤销自己（既有行为不变）。
func TestRevoke_DeviceJWT_StillSelfOnly(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: deviceListBody()}
	server, signer := newDeviceTestServer(t, stub)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 1, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/oauth/token/revoke",
		"", token, `{"device_id":1}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, []int64{1}, stub.revoked)

	stub.revoked = nil
	resp = doRequest(t, http.MethodPost, server.URL+"/v1/oauth/token/revoke",
		"", token, `{"device_id":2}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.Empty(t, stub.revoked)
}

// 设备 JWT 仍然能列出设备，并把自己标记出来。
func TestListDevices_DeviceJWT_StillWorks(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: deviceListBody()}
	server, signer := newDeviceTestServer(t, stub)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 2, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)

	resp := doRequest(t, http.MethodGet, server.URL+"/v1/devices", "", token, "")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, int64(2), stub.userDevices[1].ID)
}

// (a) 端点在 device JWT 鉴权下按 R4 任务 interfaces 里定死的信封形状
// 返回调用方账号下的吊销 jti 列表。
func TestRevocations_ReturnsRevokedJTIList_UnderDeviceJWT(t *testing.T) {
	stub := &stubDeviceSvc{revokedJTI: []string{"jti-revoked-1", "jti-revoked-2"}}
	server, signer := newDeviceTestServer(t, stub)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 2, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)

	before := time.Now().UnixMilli()
	resp := doRequest(t, http.MethodGet, server.URL+"/v1/devices/revocations", "", token, "")
	after := time.Now().UnixMilli()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var envelope struct {
		Code int `json:"code"`
		Data struct {
			RevokedJTI []string `json:"revoked_jti"`
			AsOf       int64    `json:"as_of"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.Equal(t, 0, envelope.Code)
	assert.Equal(t, []string{"jti-revoked-1", "jti-revoked-2"}, envelope.Data.RevokedJTI)
	assert.GreaterOrEqual(t, envelope.Data.AsOf, before)
	assert.LessOrEqual(t, envelope.Data.AsOf, after)
}

// 端点只认 device JWT：浏览器 session 单独持有时应当被拒绝（契约写明 "设备 JWT Bearer 鉴权"，不是
// SessionOrDeviceAuth）。
func TestRevocations_RejectsBrowserSessionOnly(t *testing.T) {
	stub := &stubDeviceSvc{revokedJTI: []string{"jti-revoked-1"}}
	server, _ := newDeviceTestServer(t, stub)
	cookie, _ := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodGet, server.URL+"/v1/devices/revocations", cookie.Value, "", "")
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// 已吊销设备自身拉取该端点时必须被拒绝——由既有 DeviceJWT 中间件 + jti 黑名单保证
// （device_svc.Revoke 已把该设备名下的 access jti 全部拉黑），本测试验证这条链路
// 在新端点上确实生效，而不是只在其它端点上生效。
func TestRevocations_RejectsRevokedCallerDevice(t *testing.T) {
	stub := &stubDeviceSvc{revokedJTI: []string{"jti-revoked-1"}}
	server, signer := newDeviceTestServer(t, stub)
	token, jti, err := signer.Sign(jwt.Claims{UID: 7, DID: 2, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	require.NoError(t, middleware.Blacklist(context.Background(), jti, 3600))

	resp := doRequest(t, http.MethodGet, server.URL+"/v1/devices/revocations", "", token, "")
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
