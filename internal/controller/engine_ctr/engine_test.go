package engine_ctr_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/engine_svc"
)

type stubEngineSvc struct {
	providerIn engine_svc.ProviderWriteInput
	backendIn  engine_svc.BackendWriteInput
}

func (s *stubEngineSvc) ListProviders(context.Context, int64) ([]engine_svc.ProviderView, error) {
	return []engine_svc.ProviderView{}, nil
}
func (s *stubEngineSvc) CreateProvider(_ context.Context, in engine_svc.ProviderWriteInput) (*engine_svc.ProviderView, error) {
	s.providerIn = in
	return &engine_svc.ProviderView{ProviderKey: "anthropic-main", Name: "Anthropic", MaskedTail: "cret", Models: []engine_svc.Model{}}, nil
}
func (s *stubEngineSvc) UpdateProvider(context.Context, engine_svc.ProviderWriteInput) (*engine_svc.ProviderView, error) {
	return nil, nil
}
func (s *stubEngineSvc) DeleteProvider(context.Context, int64, string) error { return nil }
func (s *stubEngineSvc) ListBackends(context.Context, int64) ([]engine_svc.BackendView, error) {
	return []engine_svc.BackendView{}, nil
}
func (s *stubEngineSvc) CreateBackend(_ context.Context, in engine_svc.BackendWriteInput) (*engine_svc.BackendView, error) {
	s.backendIn = in
	view := engine_svc.BackendView{SyncID: "backend-1"}
	if in.DeviceID != nil {
		view.DeviceID = *in.DeviceID
	}
	if in.EnvJSON != nil {
		view.EnvJSON = *in.EnvJSON
	}
	return &view, nil
}
func (s *stubEngineSvc) UpdateBackend(context.Context, engine_svc.BackendWriteInput) (*engine_svc.BackendView, error) {
	return nil, nil
}
func (s *stubEngineSvc) DeleteBackend(context.Context, int64, string) error { return nil }
func (s *stubEngineSvc) ListCLIOverlays(context.Context, int64) ([]engine_svc.CLIOverlayView, error) {
	return []engine_svc.CLIOverlayView{}, nil
}
func (s *stubEngineSvc) Snapshot(_ context.Context, _ int64, fingerprint string) (*engine_svc.SnapshotView, error) {
	if fingerprint != "fp-1" {
		return nil, assert.AnError
	}
	return &engine_svc.SnapshotView{Providers: []engine_svc.ProviderSnapshot{{ProviderKey: "anthropic-main", APIKey: "sk-secret", Models: []engine_svc.Model{}}}, CLIOverlays: []engine_svc.CLIOverlaySnapshot{{BackendSyncID: "backend-1", CLIPath: "/usr/local/bin/claude"}}}, nil
}

var _ engine_svc.EngineSvc = (*stubEngineSvc)(nil)

func newEngineServer(t *testing.T, stub *stubEngineSvc) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	engine_svc.SetDefault(stub)
	t.Cleanup(func() { engine_svc.SetDefault(engine_svc.New()) })
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), "server_session", 86400)))
	// 快照端点要先确认「这台设备归调用方且还能用」，判定归 device_svc.OwnedDevice；
	// 它只走 device_repo（下面用 mock 装配），配置与签名器都用不上。
	device_svc.SetDefault(device_svc.New(device_svc.Config{}, nil, jwtblacklist.New(redis.Default())))
	t.Cleanup(func() { device_svc.SetDefault(nil) })
	tm := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{Cfg: &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}}, Signer: signer}).Router(context.Background(), tm.Router))
	server := httptest.NewServer(tm.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server, signer
}
func postEngine(t *testing.T, url, sessionID, csrf, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: "server_session", Value: sessionID})
	req.Header.Set("X-CSRF-Token", csrf)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestBrowserProviderCreate_DoesNotReturnAPIKey(t *testing.T) {
	stub := &stubEngineSvc{}
	server, _ := newEngineServer(t, stub)
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), 7)
	require.NoError(t, err)
	resp := postEngine(t, server.URL+"/v1/engine/providers", sid, sess.CSRFToken, `{"name":"Anthropic","type":"anthropic","base_url":"https://api.anthropic.com","api_key":"sk-secret"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	assert.NotContains(t, string(envelope.Data), "api_key")
	assert.Equal(t, int64(7), stub.providerIn.UserID)
}

// device_id 是新契约字段：请求体里的它必须原样落进 engine_svc.BackendWriteInput.DeviceID，
// 且响应体把服务层回填的运行设备如实带回浏览器。
func TestBrowserBackendCreate_CarriesDeviceIDThroughToServiceAndResponse(t *testing.T) {
	stub := &stubEngineSvc{}
	server, _ := newEngineServer(t, stub)
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), 7)
	require.NoError(t, err)
	resp := postEngine(t, server.URL+"/v1/engine/backends", sid, sess.CSRFToken, `{"name":"Claude Code","type":"claude","device_id":"sha256:aaaa"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	require.NotNil(t, stub.backendIn.DeviceID)
	assert.Equal(t, "sha256:aaaa", *stub.backendIn.DeviceID)
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	assert.Contains(t, string(envelope.Data), `"device_id":"sha256:aaaa"`)
}

func TestDeviceSnapshot_ContainsCredentialAndOnlyCallersOverlay(t *testing.T) {
	stub := &stubEngineSvc{}
	server, signer := newEngineServer(t, stub)
	ctrl := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(devices)
	devices.EXPECT().Find(gomock.Any(), int64(2)).Return(&device_entity.Device{ID: 2, UserID: 7, Fingerprint: "fp-1", Status: consts.ACTIVE}, nil)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 2, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/engine/snapshot", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	assert.Contains(t, string(envelope.Data), "sk-secret")
	assert.Contains(t, string(envelope.Data), "/usr/local/bin/claude")
}

// 已撤销的设备不该再拉得到引擎快照——快照里带着明文 API key。这条判定曾在
// engine_ctr 漏掉：它只判「设备归不归你」，不判「设备还能不能用」，而
// relay_svc 与 workspace_svc 的同一条判定都判了（device_entity.UsableBy）。
func TestDeviceSnapshot_RevokedDeviceIsRejected(t *testing.T) {
	stub := &stubEngineSvc{}
	server, signer := newEngineServer(t, stub)
	ctrl := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(devices)
	devices.EXPECT().Find(gomock.Any(), int64(2)).
		Return(&device_entity.Device{ID: 2, UserID: 7, Fingerprint: "fp-1", Status: consts.DELETE}, nil)

	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 2, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/engine/snapshot", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.NotContains(t, string(body), "sk-secret", "撤销的设备不能拿到明文凭据")
}

// env 表整表往返：请求体里的 env_json 原样落进 BackendWriteInput.EnvJSON，
// 服务层回的那张表也如实带回浏览器——控制台的编辑器全靠这一条往返才编辑得动。
func TestBrowserBackendCreate_CarriesTheEnvTableBothWays(t *testing.T) {
	stub := &stubEngineSvc{}
	server, _ := newEngineServer(t, stub)
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), 7)
	require.NoError(t, err)

	resp := postEngine(t, server.URL+"/v1/engine/backends", sid, sess.CSRFToken,
		`{"name":"CC","type":"claudecode","device_id":"sha256:aaaa","env_json":"{\"HTTPS_PROXY\":\"http://127.0.0.1:7890\"}"}`)

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	require.NotNil(t, stub.backendIn.EnvJSON)
	assert.JSONEq(t, `{"HTTPS_PROXY":"http://127.0.0.1:7890"}`, *stub.backendIn.EnvJSON)
	var envelope struct {
		Data struct {
			EnvJSON string `json:"env_json"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	assert.JSONEq(t, `{"HTTPS_PROXY":"http://127.0.0.1:7890"}`, envelope.Data.EnvJSON)
}
