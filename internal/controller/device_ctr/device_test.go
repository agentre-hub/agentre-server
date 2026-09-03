package device_ctr_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/api"
	api_device "github.com/agentre-hub/agentre-server/internal/api/device"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
)

const testCookieName = "server_session"

// stubDeviceSvc 实现 device_svc.DeviceSvc，只覆盖本测试用到的端点。
type stubDeviceSvc struct {
	userDevices     []api_device.ListDevicesItem
	revoked         []int64
	revokedJTI      []string
	authorizeInputs []device_svc.AuthorizeInput
}

func (s *stubDeviceSvc) Authorize(_ context.Context, in device_svc.AuthorizeInput) (*device_svc.AuthorizeOutput, error) {
	s.authorizeInputs = append(s.authorizeInputs, in)
	return &device_svc.AuthorizeOutput{
		DeviceCode: "dc-1", UserCode: "A4F7Q2",
		VerificationURI: "https://example.test/device", Interval: 5, ExpiresIn: 600,
	}, nil
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

// ListUserDevices 必须真的用上 callerDeviceID：这是「把自己标记出来」的唯一入口，
// 丢掉它的桩会让 controller 停止转发 device_id 也照样测绿。
func (s *stubDeviceSvc) ListUserDevices(_ context.Context, _ int64, callerDeviceID int64) ([]api_device.ListDevicesItem, error) {
	out := make([]api_device.ListDevicesItem, len(s.userDevices))
	copy(out, s.userDevices)
	for i := range out {
		out[i].IsThisDevice = out[i].ID == callerDeviceID
	}
	return out, nil
}
func (s *stubDeviceSvc) ListRevokedJTI(context.Context, int64) ([]string, error) {
	return s.revokedJTI, nil
}

func (s *stubDeviceSvc) OwnedDevice(context.Context, int64, int64) (*device_entity.Device, error) {
	return nil, nil
}

var _ device_svc.DeviceSvc = (*stubDeviceSvc)(nil)

func newDeviceTestServer(t *testing.T, stub *stubDeviceSvc) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	device_svc.SetDefault(stub)
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		// 限流额度必须显式给：零值等于「每分钟 0 次」，/v1/oauth/device/authorize
		// 上的 AuthorizePerIPLimit 会把每一个请求都挡成 429。
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
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

	var envelope struct {
		Data struct {
			Devices []api_device.ListDevicesItem `json:"devices"`
		} `json:"data"`
	}
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(body, &envelope))
	require.Len(t, envelope.Data.Devices, 2)
	// 调用方的 DID=2 —— 只有第二行是「本设备」，controller 必须把 device_id 转发下去。
	assert.False(t, envelope.Data.Devices[0].IsThisDevice)
	assert.True(t, envelope.Data.Devices[1].IsThisDevice)
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
	require.NoError(t, jwtblacklist.Add(context.Background(), jti, 3600))

	resp := doRequest(t, http.MethodGet, server.URL+"/v1/devices/revocations", "", token, "")
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// TestAuthorize_PassesEveryInputField 锁住「请求体的每一格都真的接到了 service」。
//
// 整体比较而不是逐字段挑：AuthorizeInput 将来多出一个字段时，这里会直接失败并把
// 多出来的值摆出来，而不是默默放过一个没接上的入参。
func TestAuthorize_PassesEveryInputField(t *testing.T) {
	stub := &stubDeviceSvc{}
	server, _ := newDeviceTestServer(t, stub)

	body := `{"device_kind":"desktop","fingerprint":"fp-desktop-client","platform":"darwin/arm64",` +
		`"version":"v0.4.1","name":"studio"}`
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/oauth/device/authorize", "", "", body)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var envelope struct {
		Data api_device.DeviceAuthorizeResponse `json:"data"`
	}
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &envelope))
	assert.Equal(t, "dc-1", envelope.Data.DeviceCode)

	require.Len(t, stub.authorizeInputs, 1)
	assert.Equal(t, device_svc.AuthorizeInput{
		DeviceKind:  "desktop",
		Fingerprint: "fp-desktop-client",
		Platform:    "darwin/arm64",
		Version:     "v0.4.1",
		Name:        "studio",
	}, stub.authorizeInputs[0])
}

// 设备自报的显示名（通常是主机名）必须一路传到 service：设备流没有别的途径拿到
// 它，缺了这一段，设备列表里每台机器都只能叫指纹缩写。
func TestAuthorize_PassesReportedName(t *testing.T) {
	stub := &stubDeviceSvc{}
	server, _ := newDeviceTestServer(t, stub)

	body := `{"device_kind":"agentred","fingerprint":"fp-named-client","platform":"linux/amd64",` +
		`"version":"v0.5.0","name":"coding"}`
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/oauth/device/authorize", "", "", body)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.authorizeInputs, 1)
	assert.Equal(t, "coding", stub.authorizeInputs[0].Name)
}

// 取不到主机名的客户端不带 name（agentred 在 hostname 失败时就是这样），授权照常
// 成立：名字回退到指纹缩写，由 service 决定。
func TestAuthorize_NameIsOptional(t *testing.T) {
	stub := &stubDeviceSvc{}
	server, _ := newDeviceTestServer(t, stub)

	body := `{"device_kind":"agentred","fingerprint":"fp-unnamed-client","platform":"linux/amd64","version":"v0.5.0"}`
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/oauth/device/authorize", "", "", body)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.authorizeInputs, 1)
	assert.Empty(t, stub.authorizeInputs[0].Name)
}

// nightly 构建会在语义版本后附带提交与构建元数据，长度可能超过 32 个字符。
// version 只是展示信息，且存储列可容纳 64 个字符，授权入口不能提前拒绝它。
func TestAuthorize_AcceptsLongNightlyVersion(t *testing.T) {
	stub := &stubDeviceSvc{}
	server, _ := newDeviceTestServer(t, stub)
	version := "v0.4.1-nightly.20260814+abcdef1234567890"

	body := `{"device_kind":"agentred","fingerprint":"fp-nightly-client","platform":"linux/amd64",` +
		`"version":"` + version + `"}`
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/oauth/device/authorize", "", "", body)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.authorizeInputs, 1)
	assert.Equal(t, version, stub.authorizeInputs[0].Version)
}

// ── 控制台的一键升级（规格 2026-09-03「控制台呈现与 latest 来源」）─────────────

// stubUpgrader 顶替 mirror_svc 那一侧：控制器这一层只证明「点名的是哪台机器、
// force 有没有原样过去、daemon 说了什么就原样回什么」。
type stubUpgrader struct {
	calls  []stubUpgradeCall
	result mirror_svc.UpgradeResult
	err    error
}

type stubUpgradeCall struct {
	userID      int64
	fingerprint string
	force       bool
}

func (s *stubUpgrader) UpgradeMachine(
	_ context.Context, userID int64, fingerprint string, force bool,
) (mirror_svc.UpgradeResult, error) {
	s.calls = append(s.calls, stubUpgradeCall{userID: userID, fingerprint: fingerprint, force: force})
	return s.result, s.err
}

func newUpgradeTestServer(
	t *testing.T, stub *stubDeviceSvc, upgrader *stubUpgrader,
) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	device_svc.SetDefault(stub)
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:             &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Signer:          signer,
		MachineUpgrader: upgrader,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server
}

func upgradeDeviceList() []api_device.ListDevicesItem {
	return []api_device.ListDevicesItem{
		{
			ID: 1, Name: "nuc-01", Kind: device_entity.KindAgentred, Platform: "linux",
			Version: "0.5.2", Fingerprint: "fp-nuc-01", Status: 1,
		},
		{
			ID: 2, Name: "laptop", Kind: device_entity.KindDesktop, Platform: "darwin",
			Version: "0.6.0", Fingerprint: "fp-laptop", Status: 1,
		},
	}
}

func decodeUpgrade(t *testing.T, resp *http.Response) api_device.DeviceUpgradeResponse {
	t.Helper()
	var envelope struct {
		Code int                              `json:"code"`
		Data api_device.DeviceUpgradeResponse `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.Equal(t, 0, envelope.Code)
	return envelope.Data
}

// Given 控制台点了一台自己账号下的 agentred 的「升级 agentred」；
// Then 调用点名的是那台机器的指纹、不带 force，daemon 的受理结果原样交回浏览器。
func TestDeviceUpgrade_ForwardsToTheNamedMachine(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: upgradeDeviceList()}
	upgrader := &stubUpgrader{result: mirror_svc.UpgradeResult{Accepted: true, TargetVersion: "0.6.0"}}
	server := newUpgradeTestServer(t, stub, upgrader)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/devices/upgrade",
		cookie.Value, "", `{"device_id":1}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	body := decodeUpgrade(t, resp)
	assert.True(t, body.Accepted)
	assert.Equal(t, "0.6.0", body.TargetVersion)
	require.Len(t, upgrader.calls, 1)
	assert.Equal(t, stubUpgradeCall{userID: 7, fingerprint: "fp-nuc-01", force: false}, upgrader.calls[0])
}

// Given 那台机器上还有对话在跑；Then 拒绝原因与 daemon 那句人话逐字回到浏览器
// ——界面照抄它，不另编一套措辞（决策 22）。
func TestDeviceUpgrade_RelaysTheDaemonRefusalVerbatim(t *testing.T) {
	const daemonWording = "this machine has 2 running conversation(s); upgrading would interrupt them"
	stub := &stubDeviceSvc{userDevices: upgradeDeviceList()}
	upgrader := &stubUpgrader{result: mirror_svc.UpgradeResult{
		RejectReason: mirror_svc.UpgradeRejectActiveTurns, Message: daemonWording, ActiveTurns: 2,
	}}
	server := newUpgradeTestServer(t, stub, upgrader)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/devices/upgrade",
		cookie.Value, "", `{"device_id":1}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	body := decodeUpgrade(t, resp)
	assert.False(t, body.Accepted)
	assert.Equal(t, "active_turns", body.RejectReason)
	assert.Equal(t, daemonWording, body.Message)
	assert.Equal(t, int32(2), body.ActiveTurns)
}

// Given 用户在二次确认里点了「仍然升级」；Then force 原样过到 service 那一侧
// ——它是请求里的显式位，控制器不得自己补上，也不得吞掉。
func TestDeviceUpgrade_PassesForceThrough(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: upgradeDeviceList()}
	upgrader := &stubUpgrader{result: mirror_svc.UpgradeResult{Accepted: true}}
	server := newUpgradeTestServer(t, stub, upgrader)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/devices/upgrade",
		cookie.Value, "", `{"device_id":1,"force":true}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, upgrader.calls, 1)
	assert.True(t, upgrader.calls[0].force)
}

// 不属于本账号的设备升不了：升级借的是那台机器上的已鉴权连接，越过归属判定等于
// 拿别人的连接跑一次重启。
func TestDeviceUpgrade_RejectsForeignDevice(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: upgradeDeviceList()}
	upgrader := &stubUpgrader{}
	server := newUpgradeTestServer(t, stub, upgrader)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/devices/upgrade",
		cookie.Value, "", `{"device_id":99}`, csrf)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.Empty(t, upgrader.calls)
}

// 桌面端不是 agentred：这条端点只升 agentred，别的种类一次调用都不发。
func TestDeviceUpgrade_RejectsNonAgentredDevice(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: upgradeDeviceList()}
	upgrader := &stubUpgrader{}
	server := newUpgradeTestServer(t, stub, upgrader)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/devices/upgrade",
		cookie.Value, "", `{"device_id":2}`, csrf)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.Empty(t, upgrader.calls)
}

// 那台机器此刻联系不上：如实报「离线」（409），不折成一次「被拒绝的升级」——
// 用户该做的事不一样（等它回来 vs. 换命令行）。
func TestDeviceUpgrade_ReportsOfflineMachine(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: upgradeDeviceList()}
	upgrader := &stubUpgrader{err: mirror_svc.ErrMachineOffline}
	server := newUpgradeTestServer(t, stub, upgrader)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/devices/upgrade",
		cookie.Value, "", `{"device_id":1}`, csrf)
	assert.Equal(t, http.StatusConflict, resp.StatusCode)
}

// 浏览器 session 的写操作一律要过 CSRF：这条端点会重启用户的机器，不能是例外。
func TestDeviceUpgrade_RejectsMissingCSRFToken(t *testing.T) {
	stub := &stubDeviceSvc{userDevices: upgradeDeviceList()}
	upgrader := &stubUpgrader{}
	server := newUpgradeTestServer(t, stub, upgrader)
	cookie, _ := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/devices/upgrade",
		cookie.Value, "", `{"device_id":1}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.Empty(t, upgrader.calls)
}
