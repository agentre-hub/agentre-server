package sync_ctr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/service/sync_svc"
)

// stubSyncSvc 记下 service 实际收到的入参。
type stubSyncSvc struct {
	pushInputs []sync_svc.PushInput
	pushOut    *sync_svc.PushOutput
}

func (s *stubSyncSvc) Push(_ context.Context, in sync_svc.PushInput) (*sync_svc.PushOutput, error) {
	s.pushInputs = append(s.pushInputs, in)
	return s.pushOut, nil
}
func (s *stubSyncSvc) Pull(context.Context, sync_svc.PullInput) (*sync_svc.PullOutput, error) {
	return &sync_svc.PullOutput{}, nil
}
func (s *stubSyncSvc) ReportLocalPaths(context.Context, sync_svc.LocalPathsInput) error { return nil }
func (s *stubSyncSvc) PutAvatar(context.Context, sync_svc.AvatarInput) error            { return nil }
func (s *stubSyncSvc) GetAvatar(context.Context, int64, string) (*sync_svc.AvatarOutput, error) {
	return &sync_svc.AvatarOutput{}, nil
}
func (s *stubSyncSvc) PurgeDeviceLocalPaths(context.Context, int64) error { return nil }
func (s *stubSyncSvc) PurgeDeviceSyncObjects(context.Context, int64, string) error {
	return nil
}
func (s *stubSyncSvc) ReclaimExpired(context.Context) (*sync_svc.ReclaimOutput, error) {
	return &sync_svc.ReclaimOutput{}, nil
}

var _ sync_svc.SyncSvc = (*stubSyncSvc)(nil)

func newSyncTestServer(t *testing.T, stub *stubSyncSvc) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	// DeviceJWT 中间件要查吊销黑名单，那条链路直接读 redis.Default()。
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	sync_svc.SetDefault(stub)

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Signer: signer,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server, signer
}

func post(t *testing.T, url, bearer, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	require.NoError(t, err)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// 同步端点只认 device JWT：没有 Bearer 拿到的是 401，而不是 404
// ——404 会让「路由压根没挂上」看起来和「没授权」一样。
func TestSyncEndpoints_RequireDeviceJWT(t *testing.T) {
	server, _ := newSyncTestServer(t, &stubSyncSvc{})
	for _, path := range []string{"/v1/sync/push", "/v1/sync/local-paths", "/v1/sync/avatars"} {
		resp := post(t, server.URL+path, "", `{"items":[]}`)
		require.Equal(t, http.StatusUnauthorized, resp.StatusCode, path)
	}
}

// 账号与设备只来自 JWT claims：请求体里没有、也不该有它们的入口。
func TestPush_TakesIdentityFromJWTClaims(t *testing.T) {
	stub := &stubSyncSvc{pushOut: &sync_svc.PushOutput{Results: []sync_svc.PushItemResult{{
		SyncID: "p1", Kind: "project", Version: 8, Status: sync_svc.PushStatusConflict,
		OverwrittenVersion: 7, OverwrittenOriginFingerprint: "fp-desktop-02",
	}}}}
	server, signer := newSyncTestServer(t, stub)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 2, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)

	resp := post(t, server.URL+"/v1/sync/push", token,
		`{"items":[{"kind":"project","sync_id":"p1","base_version":5,"payload":{"name":"a"}}]}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.pushInputs, 1)
	require.Equal(t, int64(7), stub.pushInputs[0].UserID)
	require.Equal(t, int64(2), stub.pushInputs[0].DeviceID)
	require.Equal(t, int64(5), stub.pushInputs[0].Items[0].BaseVersion)
	require.JSONEq(t, `{"name":"a"}`, string(stub.pushInputs[0].Items[0].Payload))

	// 被覆盖的版本与来源设备要原样出现在应答里：上行端靠它落 R5 的「被覆盖」记录。
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Results []struct {
				Status                       string `json:"status"`
				Version                      int64  `json:"version"`
				OverwrittenVersion           int64  `json:"overwritten_version"`
				OverwrittenOriginFingerprint string `json:"overwritten_origin_fingerprint"`
			} `json:"results"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.Len(t, envelope.Data.Results, 1)
	require.Equal(t, "conflict", envelope.Data.Results[0].Status)
	require.Equal(t, int64(8), envelope.Data.Results[0].Version)
	require.Equal(t, int64(7), envelope.Data.Results[0].OverwrittenVersion)
	require.Equal(t, "fp-desktop-02", envelope.Data.Results[0].OverwrittenOriginFingerprint)
}
