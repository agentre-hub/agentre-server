package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/service/ctl_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
)

// scopedPATs 按明文里「agr_pat_」之后的部分认范围：agr_pat_read+chat = 带 read、chat 两个范围。
type scopedPATs struct{ fakePersonalTokens }

func (*scopedPATs) ResolveBearer(_ context.Context, token string) (*device_svc.Principal, error) {
	rest, ok := strings.CutPrefix(token, "agr_pat_scoped:")
	if !ok {
		return nil, device_svc.ErrBearerInvalid
	}
	return &device_svc.Principal{
		AccountID: 7, Kind: device_svc.KindPersonalToken, PeerFingerprint: "pat:own", Handle: "pat:11",
		Scopes: strings.Split(rest, "+"), TokenName: "ci",
	}, nil
}

type scopeDevices struct{ device_svc.DeviceSvc }

func (scopeDevices) ListUserDevices(context.Context, int64, int64) ([]device_svc.DeviceView, error) {
	return nil, nil
}
func (scopeDevices) Rename(_ context.Context, _, _ int64, name string) (string, error) {
	return name, nil
}
func (scopeDevices) Revoke(context.Context, int64) error { return nil }
func (scopeDevices) OwnedDevice(_ context.Context, _, id int64) (*device_entity.Device, error) {
	return &device_entity.Device{ID: id, Kind: device_entity.KindAgentred, Fingerprint: "fp"}, nil
}

type scopeUpgrader struct{}

func (scopeUpgrader) UpgradeMachine(context.Context, int64, string, bool) (mirror_svc.UpgradeResult, error) {
	return mirror_svc.UpgradeResult{Accepted: true}, nil
}

type recordingCtl struct{ caller ctl_svc.Caller }

func (r *recordingCtl) Handle(_ context.Context, c ctl_svc.Caller, _ *agentrewire.CtlRequest, _ bool) (*agentrewire.CtlResponse, error) {
	r.caller = c
	return &agentrewire.CtlResponse{}, nil
}

func newScopeRouter(t *testing.T) *gin.Engine { return newScopeRouterWithCtl(t, nil) }

func newScopeRouterWithCtl(t *testing.T, ctl ctl_svc.CtlSvc) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	prev := device_svc.Default()
	device_svc.SetDefault(scopeDevices{})
	t.Cleanup(func() { device_svc.SetDefault(prev) })
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&RouterDeps{
		Cfg:             &bootstrap.ServerConfig{},
		Bearer:          bearertest.Resolver{},
		PersonalTokens:  &scopedPATs{},
		MachineUpgrader: scopeUpgrader{},
		Ctl:             ctl,
	}).Router(context.Background(), testMux.Router))
	return testMux.IRouter.(*gin.Engine)
}

// serveRecovering 把「请求越过鉴权闸门、进了没装配依赖的处理器而 panic」记成状态 0：
// 这里要判的是闸门，不是处理器。
func serveRecovering(engine *gin.Engine, method, path, token, body string) (status int, text string) {
	defer func() {
		if recover() != nil {
			status, text = 0, ""
		}
	}()
	w := serveWithBearer(engine, method, path, token, body)
	return w.Code, w.Body.String()
}

func patToken(scopes ...string) string { return "agr_pat_scoped:" + strings.Join(scopes, "+") }

type scopeRoute struct {
	name, method, path, body string
	need                     string   // 缺它时报的范围
	allow                    []string // 带其中任一个就放行
}

var scopedRoutes = []scopeRoute{
	{"devices list", http.MethodGet, "/v1/devices", ``, "read", []string{"read"}},
	{"device rename", http.MethodPatch, "/v1/devices/5", `{"display_name":"x"}`, "devices:write", []string{"devices:write"}},
	{"device revoke", http.MethodPost, "/v1/oauth/token/revoke", `{"device_id":5}`, "devices:write", []string{"devices:write"}},
	{"device upgrade", http.MethodPost, "/v1/devices/upgrade", `{"device_id":5}`, "devices:write", []string{"devices:write"}},
	{"dispatch target", http.MethodGet, "/v1/workspace/dispatch-target", ``, "read", []string{"read", "chat"}},
	{"agent sessions", http.MethodGet, "/v1/agent-sessions", ``, "read", []string{"read", "chat"}},
	{"agent transcript", http.MethodGet, "/v1/agent-sessions/transcript", ``, "read", []string{"read", "chat"}},
	{"attention count", http.MethodGet, "/v1/agent-sessions/attention-count", ``, "read", []string{"read", "chat"}},
	{"saved session save", http.MethodPost, "/v1/saved-sessions", `{}`, "chat", []string{"chat"}},
}

func TestRouter_PATIsGatedByScopeOnEachRoute(t *testing.T) {
	engine := newScopeRouter(t)
	for _, rt := range scopedRoutes {
		t.Run(rt.name+"/missing scope is refused naming the scope", func(t *testing.T) {
			// approve 不在任何一条的放行名单里。
			status, text := serveRecovering(engine, rt.method, rt.path, patToken("approve"), rt.body)
			assert.Equal(t, http.StatusForbidden, status)
			assert.Contains(t, text, "token lacks scope "+rt.need)
		})
		for _, scope := range rt.allow {
			t.Run(rt.name+"/scope "+scope+" reaches the handler", func(t *testing.T) {
				status, _ := serveRecovering(engine, rt.method, rt.path, patToken(scope), rt.body)
				assert.NotEqual(t, http.StatusUnauthorized, status)
				assert.NotEqual(t, http.StatusForbidden, status)
			})
		}
	}
}

func TestRouter_PATDoesNotReachRoutesOutsideTheScopeTable(t *testing.T) {
	engine := newScopeRouter(t)
	all := patToken("read", "chat", "approve", "resources:write", "devices:write")
	for _, rt := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/saved-sessions/delete", `{}`},
		{http.MethodGet, "/v1/workspace/agents", ``},
		{http.MethodPost, "/v1/agent-sessions/read", `{}`},
		{http.MethodGet, "/v1/auth/me", ``},
	} {
		status, _ := serveRecovering(engine, rt.method, rt.path, all, rt.body)
		assert.Equal(t, http.StatusUnauthorized, status, rt.path)
	}
}

func TestRouter_CLIDeviceHasFullAccountAccessExceptSnapshotAndSync(t *testing.T) {
	engine := newScopeRouter(t)
	cli := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 3, Kind: device_entity.KindCLI})
	for _, rt := range scopedRoutes {
		status, _ := serveRecovering(engine, rt.method, rt.path, cli, rt.body)
		assert.NotEqual(t, http.StatusUnauthorized, status, rt.name)
		assert.NotEqual(t, http.StatusForbidden, status, rt.name)
	}
	// 即使请求体不合法，也先被拒：闸门在路由组上，不在处理器里。
	for _, path := range []string{"/v1/engine/snapshot", "/v1/sync/pull", "/v1/sync/push"} {
		method := http.MethodGet
		if path == "/v1/sync/push" {
			method = http.MethodPost
		}
		status, _ := serveRecovering(engine, method, path, cli, `{bad`)
		assert.Equal(t, http.StatusForbidden, status, path)
	}
}

func TestRouter_PATIsRefusedOnSnapshotAndSync(t *testing.T) {
	engine := newScopeRouter(t)
	all := patToken("read", "chat", "approve", "resources:write", "devices:write")
	for _, path := range []string{"/v1/engine/snapshot", "/v1/sync/pull", "/v1/sync/avatars"} {
		status, _ := serveRecovering(engine, http.MethodGet, path, all, ``)
		assert.Equal(t, http.StatusForbidden, status, path)
	}
	status, _ := serveRecovering(engine, http.MethodPost, "/v1/sync/push", all, `{bad`)
	assert.Equal(t, http.StatusForbidden, status)
}

func TestRouter_UpgradeRefusesNonCLIDevices(t *testing.T) {
	engine := newScopeRouter(t)
	desktop := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 4, Kind: device_entity.KindDesktop})
	w := serveWithBearer(engine, http.MethodPost, "/v1/devices/upgrade", desktop, `{"device_id":5}`)
	assert.Equal(t, http.StatusForbidden, w.Code)
	cli := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 3, Kind: device_entity.KindCLI})
	w = serveWithBearer(engine, http.MethodPost, "/v1/devices/upgrade", cli, `{"device_id":5}`)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestRouter_CLIDeviceMayRevokeAnotherDevice(t *testing.T) {
	engine := newScopeRouter(t)
	cli := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 3, Kind: device_entity.KindCLI})
	assert.Equal(t, http.StatusOK, serveWithBearer(engine, http.MethodPost, "/v1/oauth/token/revoke", cli, `{"device_id":5}`).Code)
	desktop := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 4, Kind: device_entity.KindDesktop})
	assert.Equal(t, http.StatusForbidden, serveWithBearer(engine, http.MethodPost, "/v1/oauth/token/revoke", desktop, `{"device_id":5}`).Code)
}

func TestRouter_CtlResourcesAdmitsPATAndPassesKindAndScopesToTheExecutor(t *testing.T) {
	rec := &recordingCtl{}
	engine := newScopeRouterWithCtl(t, rec)
	w := serveWithBearer(engine, http.MethodPost, "/v1/ctl/resources", patToken("read", "resources:write"), `{}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, ctl_svc.Caller{
		UserID: 7, Kind: device_svc.KindPersonalToken, Scopes: []string{"read", "resources:write"},
	}, rec.caller)

	// 浏览器票据之类不属于账号调用方：照旧 401。
	assert.Equal(t, http.StatusUnauthorized, serveWithBearer(engine, http.MethodPost, "/v1/ctl/resources", "garbage", `{}`).Code)
}
