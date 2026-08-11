package device_ctr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/api"
	"agentre-server/internal/bootstrap"
	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/pkg/session"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
	"agentre-server/internal/repository/device_token_repo"
	"agentre-server/internal/repository/device_token_repo/mock_device_token_repo"
	"agentre-server/internal/service/auth_svc"
	"agentre-server/internal/service/device_svc"
	"agentre-server/internal/service/relay_svc"
	hubtest "agentre-server/internal/testutils"
)

// registerWebServer 是「设备注册端点（server 单测）」的既有栈：muxtest +
// sqlmock + miniredis。device_svc / relay_svc 都跑真实实现，仓储是 mockgen，
// 数据库是 sqlmock，Redis（session 存储 + jwt 黑名单 + 中继在线态）是 miniredis。
type registerWebServer struct {
	server *httptest.Server
	signer *jwt.Signer
	mD     *mock_device_repo.MockDeviceRepo
	mT     *mock_device_token_repo.MockDeviceTokenRepo
	mock   sqlmock.Sqlmock
}

func newRegisterWebServer(t *testing.T) *registerWebServer {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis() // miniredis → cago redis.Default()

	_, gormDB, mock := hubtest.DatabasePG(t)
	db.SetDefault(gormDB)

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	mD := mock_device_repo.NewMockDeviceRepo(ctrl)
	mT := mock_device_token_repo.NewMockDeviceTokenRepo(ctrl)
	device_repo.RegisterDevice(mD)
	device_token_repo.RegisterDeviceToken(mT)

	device_svc.SetDefault(device_svc.New(device_svc.Config{
		UserCodeTTL: 10 * time.Minute, PollInterval: 5 * time.Second,
		AccessTTL: time.Hour, RefreshTTL: 90 * 24 * time.Hour,
		VerificationURI: "https://server/device",
	}, signer))
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	relayCfg := relay_svc.Config{InstanceID: "server-a", OnlineTTL: time.Second}
	relay := relay_svc.New(relayCfg, mD, redis.Default(), relay_svc.NewRedisForwarder(relayCfg, redis.Default()))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Signer: signer,
		Relay:  relay,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return &registerWebServer{server: server, signer: signer, mD: mD, mT: mT, mock: mock}
}

// expectRegister 为一次注册请求装配全部期望（事务 + upsert + 落 token）。
// 该次签发的 access token jti 从响应里取（响应带 jti 字段）。
func (s *registerWebServer) expectRegister(t *testing.T, deviceID int64) {
	t.Helper()
	// R2 的前置检查：同指纹的行还在不在、是不是活的（被解除授权的不得复活）。
	s.mD.EXPECT().FindByFingerprint(gomock.Any(), int64(7), gomock.Any()).Return(nil, nil)
	s.mock.ExpectBegin()
	s.mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, d *device_entity.Device) error {
			require.Equal(t, device_entity.KindWeb, d.Kind)
			require.Equal(t, int64(7), d.UserID)
			d.ID = deviceID
			return nil
		},
	)
	s.mT.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
	s.mock.ExpectCommit()
}

// R1：未登录请求被 SessionAuth 拒绝（401），且不产生任何设备行。
func TestRegisterWebDevice_UnauthenticatedRejected_NoDeviceRow(t *testing.T) {
	s := newRegisterWebServer(t)

	resp := doRequest(t, http.MethodPost, s.server.URL+"/v1/oauth/device/register",
		"", "", `{"fingerprint":"fp-web-abc"}`)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	// 请求被中间件挡下，根本到不了 service / 数据库：没有任何期望被消费。
	require.NoError(t, s.mock.ExpectationsWereMet())
}

// R1：session 写操作必须同时出示 CSRF，否则 403（与 logout / approve / deny 同组约定）。
func TestRegisterWebDevice_MissingCSRFRejected(t *testing.T) {
	s := newRegisterWebServer(t)
	cookie, _ := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, s.server.URL+"/v1/oauth/device/register",
		cookie.Value, "", `{"fingerprint":"fp-web-abc"}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.NoError(t, s.mock.ExpectationsWereMet())
}

// R1：已登录浏览器按指纹换取 kind=web 设备与设备 JWT；同一指纹重复请求得到同一台
// 设备（按指纹幂等，不新增设备行）。
func TestRegisterWebDevice_RegisterIsIdempotentByFingerprint(t *testing.T) {
	s := newRegisterWebServer(t)
	cookie, csrf := newSessionCookie(t, 7)

	s.expectRegister(t, 101)
	resp := doRequest(t, http.MethodPost, s.server.URL+"/v1/oauth/device/register",
		cookie.Value, "",
		`{"fingerprint":"fp-web-abc","platform":"macos","name":"Chrome · macOS"}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			AccessToken      string `json:"access_token"`
			TokenType        string `json:"token_type"`
			ExpiresIn        int    `json:"expires_in"`
			RefreshToken     string `json:"refresh_token"`
			RefreshExpiresIn int    `json:"refresh_expires_in"`
			DeviceID         int64  `json:"device_id"`
			JTI              string `json:"jti"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.Equal(t, 0, envelope.Code)
	require.NotEmpty(t, envelope.Data.AccessToken)
	require.Equal(t, "Bearer", envelope.Data.TokenType)
	require.Positive(t, envelope.Data.ExpiresIn)
	require.NotEmpty(t, envelope.Data.RefreshToken)
	require.Positive(t, envelope.Data.RefreshExpiresIn)
	require.Equal(t, int64(101), envelope.Data.DeviceID)
	// 响应回传的 jti 就是设备 JWT 的 jti（撤销侧靠它拉黑）。
	require.NotEmpty(t, envelope.Data.JTI)

	// 同一指纹再次注册：命中既有行，返回同一台设备（不新增行）。
	s.expectRegister(t, 101)
	resp = doRequest(t, http.MethodPost, s.server.URL+"/v1/oauth/device/register",
		cookie.Value, "", `{"fingerprint":"fp-web-abc"}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var second struct {
		Code int `json:"code"`
		Data struct {
			DeviceID int64 `json:"device_id"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&second))
	require.Equal(t, 0, second.Code)
	require.Equal(t, int64(101), second.Data.DeviceID)
}

// R2 + R3：解除授权后该浏览器的设备 JWT 在中继上被拒（401），其余设备不受影响；
// 解除前它能以纯出站调用方身份到达 /v1/relay/client。
func TestRegisterWebDevice_RevokeRejectsRelayAndSparesOthers(t *testing.T) {
	s := newRegisterWebServer(t)
	cookie, csrf := newSessionCookie(t, 7)

	s.expectRegister(t, 101)
	resp := doRequest(t, http.MethodPost, s.server.URL+"/v1/oauth/device/register",
		cookie.Value, "", `{"fingerprint":"fp-web-abc"}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			AccessToken string `json:"access_token"`
			DeviceID    int64  `json:"device_id"`
			JTI         string `json:"jti"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	webToken := envelope.Data.AccessToken
	webJTI := envelope.Data.JTI
	require.Equal(t, int64(101), envelope.Data.DeviceID)

	// R3：浏览器持有效设备 JWT 能连 /v1/relay/client（纯出站调用方）。目标 daemon
	// 在此不存在，返回 404 而非 401——鉴权已通过，只是找不到目标。
	s.mD.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(nil, nil)
	resp = doRequest(t, http.MethodGet,
		s.server.URL+"/v1/relay/client?daemon_fingerprint=fp-daemon", "", webToken, "")
	require.Equal(t, http.StatusNotFound, resp.StatusCode)

	// 解除该浏览器的授权（既有 /v1/oauth/token/revoke，session 可撤账号下设备；
	// 归属校验走 ListUserDevices）。
	s.mD.EXPECT().ListByUser(gomock.Any(), int64(7)).Return(
		[]*device_entity.Device{{ID: 101, UserID: 7, Kind: device_entity.KindWeb}}, nil,
	)
	s.mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(101)).Return([]string{webJTI}, nil)
	s.mT.EXPECT().RevokeChain(gomock.Any(), int64(101), gomock.Any()).Return(nil)
	s.mD.EXPECT().Revoke(gomock.Any(), int64(101), gomock.Any()).Return(nil)
	resp = doRequest(t, http.MethodPost, s.server.URL+"/v1/oauth/token/revoke",
		cookie.Value, "", `{"device_id":101}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// 该浏览器再连中继：jti 已入黑名单，DeviceJWT 中间件逐请求拒绝 → 401。
	resp = doRequest(t, http.MethodGet,
		s.server.URL+"/v1/relay/client?daemon_fingerprint=fp-daemon", "", webToken, "")
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	// 其余设备不受影响：另一台未被撤销的桌面端设备 JWT 照常通过鉴权（404 是
	// 目标不存在，不是鉴权被拒）。
	desktopToken, _, err := s.signer.Sign(jwt.Claims{UID: 7, DID: 9, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)
	s.mD.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(nil, nil)
	resp = doRequest(t, http.MethodGet,
		s.server.URL+"/v1/relay/client?daemon_fingerprint=fp-daemon", "", desktopToken, "")
	require.Equal(t, http.StatusNotFound, resp.StatusCode)

	// 被解除授权的浏览器**不能**靠重新注册把自己救回来：同一指纹再来一次注册被拒，
	// 既不复活那一行，也不签发新的（不在黑名单里的）设备 JWT。否则刷新一次页面就
	// 绕过了解除授权，用户故事 5 白做。
	s.mD.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-web-abc").Return(
		&device_entity.Device{ID: 101, UserID: 7, Fingerprint: "fp-web-abc",
			Kind: device_entity.KindWeb, Status: consts.DELETE}, nil)
	resp = doRequest(t, http.MethodPost, s.server.URL+"/v1/oauth/device/register",
		cookie.Value, "", `{"fingerprint":"fp-web-abc"}`, csrf)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
}
