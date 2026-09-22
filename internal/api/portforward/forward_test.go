package portforward_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/configs/memory"
	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/server/mux"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/portforward_link_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/portforward_link_repo/mock_portforward_link_repo"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
	"github.com/agentre-hub/agentre-server/internal/testutils"
	"github.com/agentre-hub/agentre-server/internal/web"
)

// 这一批用例走的是**真实的**那条路：cago 建的 gin engine（Recover + logger 全局链）、
// 真实的 internal/api/router.go 路由树、真实的会话存储（miniredis 背后）、真实的
// device_svc.OwnedDevice 与 portforward_svc 的 Links / ForwardAuth（只把两个 repo
// 换成 mockgen 的 mock），以及真实的 internal/web SPA 兜底——转发 Host 上的请求到底
// 有没有落进控制台路由或 SPA 外壳，只有它们都在场时才看得见。
//
// 只有两处是替身：连接池（Forwarder）与在线判定（Presence）。

const (
	baseDomain  = "fw.test"
	prefixA     = "abcdefghijkl"
	prefixB     = "mnopqrstuvwx"
	userID      = int64(7)
	otherUserID = int64(8)
	deviceID    = int64(12)
	mappingID   = int64(3)
	fingerprint = "sha256:fp-agentred-01"
)

type acquireCall struct {
	userID      int64
	fingerprint string
	mappingID   int64
}

type stubForwarder struct {
	mu       sync.Mutex
	calls    []acquireCall
	released int
	handler  http.Handler
}

func (s *stubForwarder) Acquire(
	_ context.Context, userID int64, fingerprint string, mappingID int64,
) (http.Handler, func(), error) {
	s.mu.Lock()
	s.calls = append(s.calls, acquireCall{userID, fingerprint, mappingID})
	s.mu.Unlock()
	return s.handler, func() {
		s.mu.Lock()
		s.released++
		s.mu.Unlock()
	}, nil
}

func (s *stubForwarder) snapshot() ([]acquireCall, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]acquireCall(nil), s.calls...), s.released
}

type stubPresence struct {
	relay_svc.RelaySvc
	online bool
}

func (s *stubPresence) IsDaemonOnline(context.Context, int64, string) (bool, error) {
	return s.online, nil
}

// seen 是被转发应用收到的那一个请求。
type seen struct {
	requestURI    string
	cookie        []string
	authorization string
}

type recordingApp struct {
	mu   sync.Mutex
	reqs []seen
}

func (a *recordingApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	a.reqs = append(a.reqs, seen{
		requestURI: r.URL.RequestURI(), cookie: r.Header.Values("Cookie"),
		authorization: r.Header.Get("Authorization"),
	})
	a.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, "hello from the device")
}

func (a *recordingApp) requests() []seen {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]seen(nil), a.reqs...)
}

type harness struct {
	engine    *gin.Engine
	mini      *miniredis.Miniredis
	auth      *portforward_svc.ForwardAuth
	devices   *mock_device_repo.MockDeviceRepo
	links     *mock_portforward_link_repo.MockPortForwardLinkRepo
	forwarder *stubForwarder
	presence  *stubPresence
	app       *recordingApp
	https     bool
}

func newHarness(t *testing.T, https bool) *harness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	mini := testutils.Redis(t)
	store := session.New(redis.Default(), 86400)
	authSvc := auth_svc.New(redis.Default(), store)
	authSvc.SetSecureCookies(https)
	auth_svc.SetDefault(authSvc)
	device_svc.SetDefault(device_svc.New(device_svc.Config{}))

	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(devices)
	linkRepo := mock_portforward_link_repo.NewMockPortForwardLinkRepo(ctrl)

	publicURL := "http://console.test:8443"
	if https {
		publicURL = "https://console.test"
	}
	app := &recordingApp{}
	h := &harness{
		mini: mini, devices: devices, links: linkRepo,
		forwarder: &stubForwarder{handler: app}, presence: &stubPresence{online: true}, app: app,
		https: https,
		auth:  portforward_svc.NewForwardAuth(redis.Default(), store, time.Hour),
	}
	deps := &api.RouterDeps{
		Cfg: &bootstrap.ServerConfig{
			PublicURL:       publicURL,
			InsecureCookies: !https,
			PortForward:     bootstrap.PortForwardConfig{BaseDomain: baseDomain},
			RateLimit:       bootstrap.RLConfig{AuthorizePerIPPerMin: 100},
		},
		Relay:       h.presence,
		Redis:       redis.Default(),
		PortForward: h.forwarder,
		PortForwardPrefixes: portforward_svc.NewLinks(
			portforward_svc.LinkConfig{BaseDomain: baseDomain, PublicURL: publicURL}, linkRepo),
		PortForwardAuth: h.auth,
	}
	h.engine = newEngine(t, deps)
	return h
}

// newEngine 让 cago 自己去建那个 engine（见 git show f0eccb1b^ 的同名函数）：
// web.MountSPA 把 SPA 兜底登记进 cago 的 mux 全局中间件表，唯一能把真实兜底装到
// engine 上的办法就是让 mux 自己走一遍它的启动路径。
var mountSPAOnce sync.Once

func newEngine(t *testing.T, deps *api.RouterDeps) *gin.Engine {
	t.Helper()
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(
		map[string]interface{}{"http": map[string]interface{}{"address": []string{"127.0.0.1:0"}}},
	)))
	require.NoError(t, err)
	mountSPAOnce.Do(func() {
		require.NoError(t, web.MountSPA(context.Background(), cfg))
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	var engine *gin.Engine
	require.NoError(t, mux.HTTP(func(ctx context.Context, r *mux.Router) error {
		engine = r.IRouter.(*gin.Engine)
		return deps.Router(ctx, r)
	}).Start(ctx, cfg))
	require.NotNil(t, engine)
	return engine
}

func (h *harness) do(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.engine.ServeHTTP(rec, req)
	return rec
}

func (h *harness) forwardCookieName() string { return session.ForwardCookieName(h.https) }

func (h *harness) consoleCookieName() string {
	if h.https {
		return session.HostCookieName
	}
	return session.CookieName
}

// linkRows 让前缀表认得 prefixA（属于 userID）；prefixB 查不到。
func (h *harness) linkRows() {
	h.links.EXPECT().FindByPrefix(gomock.Any(), prefixA).Return(&portforward_link_entity.PortForwardLink{
		Prefix: prefixA, UserID: userID, DeviceID: deviceID, MappingID: mappingID,
	}, nil).AnyTimes()
	h.links.EXPECT().FindByPrefix(gomock.Any(), gomock.Any()).Return(nil, nil).AnyTimes()
}

func (h *harness) ownedDevice() {
	h.devices.EXPECT().Find(gomock.Any(), deviceID).Return(&device_entity.Device{
		ID: deviceID, UserID: userID, Kind: device_entity.KindAgentred,
		Fingerprint: fingerprint, Status: consts.ACTIVE,
	}, nil).AnyTimes()
}

// consoleLogin 造一条真实的控制台会话。
func (h *harness) consoleLogin(t *testing.T, uid int64) string {
	t.Helper()
	sid, _, err := auth_svc.Default().StartSession(context.Background(), uid)
	require.NoError(t, err)
	return sid
}

// forwardLogin 直接向转发登录服务要一张 prefix 的票（绕过 HTTP 那两跳；那两跳自己
// 有用例）。
func (h *harness) forwardLogin(t *testing.T, uid int64, prefix, consoleSID string) string {
	t.Helper()
	code, err := h.auth.IssueCode(context.Background(), uid, prefix, consoleSID)
	require.NoError(t, err)
	token, err := h.auth.Redeem(context.Background(), code, prefix)
	require.NoError(t, err)
	return token
}

func fwReq(method, prefix, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	req.Host = prefix + "." + baseDomain
	return req
}

func navigate(req *http.Request) *http.Request {
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	return req
}

func (h *harness) withForwardCookie(req *http.Request, token string) *http.Request {
	req.AddCookie(&http.Cookie{Name: h.forwardCookieName(), Value: token})
	return req
}

func consoleReq(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	req.Host = "console.test"
	return req
}

func isSPAShell(rec *httptest.ResponseRecorder) bool {
	return rec.Code == http.StatusOK && strings.Contains(rec.Header().Get("Content-Type"), "text/html")
}

// —— Host 分发：转发 Host 上的请求整条交给转发处理器 ——

func TestHostDispatch_SignedInForwardRequestsToConsolePathsReachTheApp(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	token := h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))

	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/v1/auth/me"},
		{http.MethodGet, "/some-frontend-route"},
		{http.MethodGet, "/"},
		{http.MethodPost, "/v1/auth/logout"},
		{http.MethodGet, "/fw/12/3000"},
	} {
		rec := h.do(h.withForwardCookie(fwReq(c.method, prefixA, c.path), token))
		require.Equal(t, http.StatusOK, rec.Code, "%s %s: %s", c.method, c.path, rec.Body.String())
		assert.Equal(t, "hello from the device", rec.Body.String(), "%s %s", c.method, c.path)
	}
	var uris []string
	for _, r := range h.app.requests() {
		uris = append(uris, r.requestURI)
	}
	assert.Equal(t, []string{"/v1/auth/me", "/some-frontend-route", "/", "/v1/auth/logout", "/fw/12/3000"}, uris)
	calls, released := h.forwarder.snapshot()
	require.Len(t, calls, 5)
	assert.Equal(t, acquireCall{userID, fingerprint, mappingID}, calls[0], "按映射 id 借出")
	assert.Equal(t, 5, released)
}

func TestHostDispatch_UnauthenticatedForwardRequestsNeverReachConsoleOrSPA(t *testing.T) {
	h := newHarness(t, false)
	// 控制台的 /v1/auth/me 在这个 Host 上也不能被一张控制台会话 cookie 打开。
	sid := h.consoleLogin(t, userID)

	me := fwReq(http.MethodGet, prefixA, "/v1/auth/me")
	me.AddCookie(&http.Cookie{Name: h.consoleCookieName(), Value: sid})
	rec := h.do(me)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain", "不是控制台的 JSON 信封")
	assert.NotContains(t, rec.Body.String(), "userId")

	spa := h.do(navigate(fwReq(http.MethodGet, prefixA, "/some-frontend-route")))
	assert.False(t, isSPAShell(spa), "转发 Host 上的导航落到了 SPA 外壳")
	assert.Equal(t, http.StatusFound, spa.Code)

	assert.Empty(t, h.app.requests())
}

func TestHostDispatch_HostMatchIsCaseInsensitiveAndIgnoresPort(t *testing.T) {
	h := newHarness(t, false)
	req := navigate(fwReq(http.MethodGet, prefixA, "/"))
	req.Host = strings.ToUpper(prefixA+"."+baseDomain) + ":8443"

	rec := h.do(req)

	require.Equal(t, http.StatusFound, rec.Code)
	loc, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	assert.Equal(t, prefixA, loc.Query().Get("prefix"))
}

func TestHostDispatch_BadShapesUnderTheForwardDomainAnswerTheNotYoursFourOhFour(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	notYours := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixB, "/"),
		h.forwardLogin(t, userID, prefixB, h.consoleLogin(t, userID))))
	require.Equal(t, http.StatusNotFound, notYours.Code)

	for _, host := range []string{
		baseDomain, "a.b." + baseDomain, "short." + baseDomain, "abcdefghijk1." + baseDomain,
	} {
		req := navigate(httptest.NewRequest(http.MethodGet, "/", nil))
		req.Host = host
		rec := h.do(req)
		assert.Equal(t, http.StatusNotFound, rec.Code, host)
		assert.Equal(t, notYours.Body.String(), rec.Body.String(), host)
		assert.False(t, isSPAShell(rec), host)
	}
	assert.Empty(t, h.app.requests())
}

func TestHostDispatch_ConsoleHostStillServesConsoleAndSPA(t *testing.T) {
	h := newHarness(t, false)

	assert.True(t, isSPAShell(h.do(consoleReq(http.MethodGet, "/some-frontend-route"))))
	assert.Equal(t, http.StatusNotFound, h.do(consoleReq(http.MethodGet, "/fw/12/3000")).Code)
	me := h.do(consoleReq(http.MethodGet, "/v1/auth/me"))
	assert.Equal(t, http.StatusUnauthorized, me.Code)
	assert.Contains(t, me.Header().Get("Content-Type"), "application/json")
}

// —— 未登录：导航 302 到控制台 authorize，其余 401 ——

func TestForwardLogin_NavigationRedirectsToConsoleAuthorize(t *testing.T) {
	h := newHarness(t, true)

	rec := h.do(navigate(fwReq(http.MethodGet, prefixA, "/app/page?x=1&y=2")))

	require.Equal(t, http.StatusFound, rec.Code)
	loc, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	assert.Equal(t, "https", loc.Scheme)
	assert.Equal(t, "console.test", loc.Host)
	assert.Equal(t, "/v1/port-forwards/authorize", loc.Path)
	assert.Equal(t, prefixA, loc.Query().Get("prefix"))
	assert.Equal(t, "/app/page?x=1&y=2", loc.Query().Get("return"))
}

func TestForwardLogin_NonNavigationAnswers401PlainText(t *testing.T) {
	h := newHarness(t, true)
	for _, req := range []*http.Request{
		fwReq(http.MethodGet, prefixA, "/assets/app.js"),
		fwReq(http.MethodPost, prefixA, "/api/save"),
		func() *http.Request { // POST 即便带着 navigate 也不是顶层导航
			return navigate(fwReq(http.MethodPost, prefixA, "/form"))
		}(),
	} {
		rec := h.do(req)
		assert.Equal(t, http.StatusUnauthorized, rec.Code, req.URL.Path)
		assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain", req.URL.Path)
		assert.Empty(t, rec.Header().Get("Location"), req.URL.Path)
	}
	assert.Empty(t, h.app.requests())
}

// —— 未登录，一个 Sec-Fetch-* 头都不带：按 Accept 兜底判导航（决策 14）——

func TestForwardLogin_NoSecFetchHeadersAtAll_GetWithHTMLAcceptRedirects(t *testing.T) {
	h := newHarness(t, true)
	for _, accept := range []string{
		"text/html",
		"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"TEXT/HTML", // media-type 匹配大小写不敏感
	} {
		req := fwReq(http.MethodGet, prefixA, "/app/page")
		req.Header.Set("Accept", accept)

		rec := h.do(req)

		require.Equal(t, http.StatusFound, rec.Code, accept)
		loc, err := url.Parse(rec.Header().Get("Location"))
		require.NoError(t, err)
		assert.Equal(t, "/v1/port-forwards/authorize", loc.Path, accept)
	}
}

func TestForwardLogin_NoSecFetchHeadersAtAll_AnythingElseAnswers401(t *testing.T) {
	h := newHarness(t, true)
	htmlAndFriends := "text/html,application/xhtml+xml"
	for _, req := range []*http.Request{
		func() *http.Request { // */* 不算 text/html
			r := fwReq(http.MethodGet, prefixA, "/app/page")
			r.Header.Set("Accept", "*/*")
			return r
		}(),
		fwReq(http.MethodGet, prefixA, "/app/page"), // 缺 Accept
		func() *http.Request {
			r := fwReq(http.MethodGet, prefixA, "/app/page")
			r.Header.Set("Accept", "application/json")
			return r
		}(),
		func() *http.Request { // 非 GET 即便 Accept 含 text/html 也不算
			r := fwReq(http.MethodPost, prefixA, "/app/page")
			r.Header.Set("Accept", htmlAndFriends)
			return r
		}(),
	} {
		rec := h.do(req)
		assert.Equal(t, http.StatusUnauthorized, rec.Code, req.Method+" "+req.Header.Get("Accept"))
		assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain")
		assert.Empty(t, rec.Header().Get("Location"))
	}
	assert.Empty(t, h.app.requests())
}

func TestForwardLogin_NoSecFetchHeadersAtAll_AcceptEdgeCases(t *testing.T) {
	type tc struct {
		name string
		req  func() *http.Request
		want int
	}
	get := func(accept ...string) func() *http.Request {
		return func() *http.Request {
			r := fwReq(http.MethodGet, prefixA, "/app/page")
			for _, a := range accept {
				r.Header.Add("Accept", a)
			}
			return r
		}
	}
	for _, c := range []tc{
		// q=0 按 RFC 9110 §12.4.2 是「不可接受」，不是「要 HTML」。
		{"text/html;q=0", get("text/html;q=0,application/json"), http.StatusUnauthorized},
		{"text/html; q=0.000", get("application/json, text/html; q=0.000"), http.StatusUnauthorized},
		{"text/html;q=0.1", get("application/json,text/html;q=0.1"), http.StatusFound},
		{"Q=0 大写参数名", get("text/html;Q=0"), http.StatusUnauthorized},
		// 同名头分两行发，语义等同逗号拼接（RFC 9110 §5.3）。
		{"Accept 分两行", get("application/json", "text/html"), http.StatusFound},
		{"只有 xhtml", get("application/xhtml+xml"), http.StatusUnauthorized},
		{"HEAD", func() *http.Request {
			r := fwReq(http.MethodHead, prefixA, "/app/page")
			r.Header.Set("Accept", "text/html")
			return r
		}, http.StatusUnauthorized},
		// WebSocket 升级永远不是顶层导航，哪怕 Accept 写了 text/html。
		{"WebSocket 升级", func() *http.Request {
			r := get("text/html")()
			r.Header.Set("Connection", "Upgrade")
			r.Header.Set("Upgrade", "websocket")
			return r
		}, http.StatusUnauthorized},
		// 带了 Sec-Fetch-* 就不退回 Accept：空值的 Mode、只带 Dest 都算「带了」。
		{"空值 Sec-Fetch-Mode", func() *http.Request {
			r := get("text/html")()
			r.Header["Sec-Fetch-Mode"] = []string{""}
			return r
		}, http.StatusUnauthorized},
		{"只带 Sec-Fetch-Dest", func() *http.Request {
			r := get("text/html")()
			r.Header.Set("Sec-Fetch-Dest", "document")
			return r
		}, http.StatusUnauthorized},
	} {
		h := newHarness(t, true)
		rec := h.do(c.req())
		assert.Equal(t, c.want, rec.Code, c.name)
		assert.Empty(t, h.app.requests(), c.name)
	}
}

func TestForwardLogin_SecFetchModePresent_AcceptIsIgnored(t *testing.T) {
	h := newHarness(t, true)
	req := fwReq(http.MethodGet, prefixA, "/app/page")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	rec := h.do(req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain")
	assert.Empty(t, rec.Header().Get("Location"))
}

// —— authorize（控制台 Host）——

func TestAuthorize_WithoutConsoleSessionRedirectsToLoginWithThisURLAsNext(t *testing.T) {
	h := newHarness(t, true)
	target := "/v1/port-forwards/authorize?prefix=" + prefixA + "&return=%2Fapp%3Fx%3D1"

	rec := h.do(consoleReq(http.MethodGet, target))

	require.Equal(t, http.StatusFound, rec.Code)
	loc, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	assert.Equal(t, "/login", loc.Path)
	assert.Equal(t, target, loc.Query().Get("next"), "登录后要原路回到这条 authorize")
}

func TestAuthorize_OwnPrefixIssuesACodeAndRedirectsToTheForwardCallback(t *testing.T) {
	h := newHarness(t, true)
	h.linkRows()
	req := consoleReq(http.MethodGet, "/v1/port-forwards/authorize?prefix="+prefixA+"&return=%2Fapp%3Fx%3D1")
	req.AddCookie(&http.Cookie{Name: h.consoleCookieName(), Value: h.consoleLogin(t, userID)})

	rec := h.do(req)

	require.Equal(t, http.StatusFound, rec.Code, rec.Body.String())
	loc, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	assert.Equal(t, "https", loc.Scheme)
	assert.Equal(t, prefixA+"."+baseDomain, loc.Host)
	assert.Equal(t, "/__agentre/callback", loc.Path)
	assert.NotEmpty(t, loc.Query().Get("code"))
	assert.Equal(t, "/app?x=1", loc.Query().Get("return"))
	// 码 60 秒过期。
	keys := h.mini.Keys()
	require.Len(t, filter(keys, "pf_code:"), 1)
	assert.Equal(t, 60*time.Second, h.mini.TTL(filter(keys, "pf_code:")[0]))
}

func TestAuthorize_ForeignOrUnknownPrefixAnswers404WithoutACode(t *testing.T) {
	h := newHarness(t, true)
	h.linkRows()
	answers := map[string]*httptest.ResponseRecorder{}
	for name, c := range map[string]struct {
		uid    int64
		prefix string
	}{
		"不是你的": {otherUserID, prefixA},
		"查不到":  {userID, prefixB},
		"形状不对": {userID, "../x"},
	} {
		req := consoleReq(http.MethodGet, "/v1/port-forwards/authorize?prefix="+url.QueryEscape(c.prefix)+"&return=%2F")
		req.AddCookie(&http.Cookie{Name: h.consoleCookieName(), Value: h.consoleLogin(t, c.uid)})
		answers[name] = h.do(req)
	}
	for name, rec := range answers {
		assert.Equal(t, http.StatusNotFound, rec.Code, name)
		assert.Empty(t, rec.Header().Get("Location"), name)
		assert.Equal(t, answers["查不到"].Body.String(), rec.Body.String(), name)
	}
	assert.Empty(t, filter(h.mini.Keys(), "pf_code:"), "不签发")
}

// —— callback（转发 Host）——

func (h *harness) callback(t *testing.T, prefix, code, ret string) *httptest.ResponseRecorder {
	t.Helper()
	q := url.Values{"code": {code}, "return": {ret}}
	return h.do(navigate(fwReq(http.MethodGet, prefix, "/__agentre/callback?"+q.Encode())))
}

func (h *harness) issue(t *testing.T, prefix string) string {
	t.Helper()
	code, err := h.auth.IssueCode(context.Background(), userID, prefix, h.consoleLogin(t, userID))
	require.NoError(t, err)
	return code
}

func TestCallback_HTTPSSetsHostPrefixedSecureCookie(t *testing.T) {
	h := newHarness(t, true)

	rec := h.callback(t, prefixA, h.issue(t, prefixA), "/app?x=1")

	require.Equal(t, http.StatusFound, rec.Code, rec.Body.String())
	assert.Equal(t, "/app?x=1", rec.Header().Get("Location"))
	set := rec.Header().Get("Set-Cookie")
	assert.True(t, strings.HasPrefix(set, "__Host-agentre_fw="), set)
	for _, attr := range []string{"Path=/", "Secure", "HttpOnly", "SameSite=Lax"} {
		assert.Contains(t, set, attr)
	}
	assert.NotContains(t, strings.ToLower(set), "domain=", "host-only")
}

func TestCallback_HTTPSetsPlainCookieWithoutSecure(t *testing.T) {
	h := newHarness(t, false)

	rec := h.callback(t, prefixA, h.issue(t, prefixA), "/")

	require.Equal(t, http.StatusFound, rec.Code, rec.Body.String())
	set := rec.Header().Get("Set-Cookie")
	assert.True(t, strings.HasPrefix(set, "agentre_fw="), set)
	assert.NotContains(t, set, "Secure")
	assert.Contains(t, set, "HttpOnly")
	assert.Contains(t, set, "SameSite=Lax")
	assert.NotContains(t, strings.ToLower(set), "domain=")
}

func TestCallback_InvalidUsedExpiredOrMismatchedCodeAnswers400(t *testing.T) {
	h := newHarness(t, true)
	used := h.issue(t, prefixA)
	require.Equal(t, http.StatusFound, h.callback(t, prefixA, used, "/").Code)
	mismatched := h.issue(t, prefixB)
	expired := h.issue(t, prefixA)
	h.mini.FastForward(61 * time.Second)

	for name, code := range map[string]string{
		"没有": "never-issued", "空": "", "已用过": used, "签给别的前缀": mismatched, "过期": expired,
	} {
		rec := h.callback(t, prefixA, code, "/")
		assert.Equal(t, http.StatusBadRequest, rec.Code, name)
		assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain", name)
		assert.Equal(t, "这个登录链接已失效，请回控制台重新打开", strings.TrimSpace(rec.Body.String()), name)
		assert.Empty(t, rec.Header().Get("Set-Cookie"), name)
	}
}

func TestCallback_ReturnIsSanitizedToARelativePath(t *testing.T) {
	h := newHarness(t, false)
	for in, want := range map[string]string{
		"/app?x=1":            "/app?x=1",
		"":                    "/",
		"app":                 "/",
		"//evil.com/x":        "/",
		"https://evil.com/":   "/",
		"/\\evil.com":         "/",
		"\\\\evil.com":        "/",
		"javascript:alert(1)": "/",
		"/\t/evil.com":        "/",
	} {
		rec := h.callback(t, prefixA, h.issue(t, prefixA), in)
		require.Equal(t, http.StatusFound, rec.Code, in)
		assert.Equal(t, want, rec.Header().Get("Location"), "return=%q", in)
	}
}

// 一次完整的浏览器往返：导航 → authorize → callback → 再导航就到应用。
func TestForwardLogin_FullRoundTripLandsOnTheApp(t *testing.T) {
	h := newHarness(t, true)
	h.linkRows()
	h.ownedDevice()
	sid := h.consoleLogin(t, userID)

	first := h.do(navigate(fwReq(http.MethodGet, prefixA, "/app?x=1")))
	require.Equal(t, http.StatusFound, first.Code)
	authURL, _ := url.Parse(first.Header().Get("Location"))
	authReq := consoleReq(http.MethodGet, authURL.RequestURI())
	authReq.AddCookie(&http.Cookie{Name: h.consoleCookieName(), Value: sid})
	second := h.do(authReq)
	require.Equal(t, http.StatusFound, second.Code, second.Body.String())
	cbURL, _ := url.Parse(second.Header().Get("Location"))
	third := h.do(navigate(fwReq(http.MethodGet, prefixA, cbURL.RequestURI())))
	require.Equal(t, http.StatusFound, third.Code, third.Body.String())
	require.Equal(t, "/app?x=1", third.Header().Get("Location"))
	cookie := third.Result().Cookies()[0]

	final := fwReq(http.MethodGet, prefixA, "/app?x=1")
	final.AddCookie(cookie)
	rec := h.do(final)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "/app?x=1", h.app.requests()[0].requestURI)
}

// —— 每次请求的判定 ——

func TestForwardChain_SessionForPrefixAIsRejectedOnPrefixB(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	token := h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))

	rec := h.do(navigate(h.withForwardCookie(fwReq(http.MethodGet, prefixB, "/"), token)))

	require.Equal(t, http.StatusFound, rec.Code, "A 的票在 B 上等于没登录")
	assert.Contains(t, rec.Header().Get("Location"), "prefix="+prefixB)
	assert.Empty(t, h.app.requests())
}

func TestForwardChain_ConsoleLogoutReentersTheLoginFlow(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	sid := h.consoleLogin(t, userID)
	token := h.forwardLogin(t, userID, prefixA, sid)
	require.Equal(t, http.StatusOK, h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/"), token)).Code)

	require.NoError(t, auth_svc.Default().EndSession(context.Background(), sid))

	nav := h.do(navigate(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/"), token)))
	assert.Equal(t, http.StatusFound, nav.Code)
	assert.Contains(t, nav.Header().Get("Location"), "/v1/port-forwards/authorize")
	sub := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/x.js"), token))
	assert.Equal(t, http.StatusUnauthorized, sub.Code)
	assert.Len(t, h.app.requests(), 1)
}

func TestForwardChain_LinkOfAnotherAccountIsTheSameFourOhFourAsUnknownPrefix(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	// 一张签给别的账号、却指着 prefixA 的票：前缀属于 userID，不属于 otherUserID。
	foreign := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/"),
		h.forwardLogin(t, otherUserID, prefixA, h.consoleLogin(t, otherUserID))))
	unknown := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixB, "/"),
		h.forwardLogin(t, userID, prefixB, h.consoleLogin(t, userID))))

	assert.Equal(t, http.StatusNotFound, foreign.Code)
	assert.Equal(t, unknown.Code, foreign.Code)
	assert.Equal(t, unknown.Body.String(), foreign.Body.String())
	calls, _ := h.forwarder.snapshot()
	assert.Empty(t, calls)
}

func TestForwardChain_RevokedDeviceIsTheSameFourOhFour(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.devices.EXPECT().Find(gomock.Any(), deviceID).Return(&device_entity.Device{
		ID: deviceID, UserID: userID, Fingerprint: fingerprint, Status: consts.DELETE,
	}, nil)
	unknown := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixB, "/"),
		h.forwardLogin(t, userID, prefixB, h.consoleLogin(t, userID))))

	rec := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/"),
		h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))))

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Equal(t, unknown.Body.String(), rec.Body.String())
}

func TestForwardChain_OfflineDeviceAnswersOfflineWithoutDialing(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	h.presence.online = false

	rec := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/"),
		h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))))

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	calls, _ := h.forwarder.snapshot()
	assert.Empty(t, calls)
}

// blockingGate 是一道把 blocked 这个账号拦下的账号闸门（改库封禁之后的样子）。
type blockingGate struct{ blocked int64 }

func (g blockingGate) Check(_ context.Context, uid int64) error {
	if uid == g.blocked {
		return errors.New("account banned")
	}
	return nil
}

// 账号闸门与控制台的每一条鉴权路径同一道：控制台会话还在不等于账号还能用。封禁之后
// 手上那张转发票不能再把请求带到设备上——否则封禁只挡得住控制台，挡不住转发域。
func TestForwardChain_BlockedAccountNoLongerReachesTheApp(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	token := h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))
	user_svc.SetGate(blockingGate{blocked: userID})
	t.Cleanup(func() { user_svc.SetGate(nil) })

	sub := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/x.js"), token))

	assert.Equal(t, http.StatusUnauthorized, sub.Code)
	assert.Empty(t, h.app.requests())
	calls, _ := h.forwarder.snapshot()
	assert.Empty(t, calls, "被封的账号不该再借出一条通往设备的连接")
}

// 转发 Host 上的路径整条属于被转发的应用：控制台路由树上「差一个结尾斜杠」的那些
// 路径不能被 gin 的 RedirectTrailingSlash 抢先 301 走——那一跳发生在 Host 分发之前，
// 应用自己的 /v1/auth/me/ 就永远到不了，而 301 还会被浏览器永久缓存。
func TestHostDispatch_TrailingSlashVariantsOfConsoleRoutesStillReachTheApp(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	token := h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))

	for _, path := range []string{"/v1/auth/me/", "/fw", "/v1/devices/"} {
		rec := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, path), token))
		require.Equal(t, http.StatusOK, rec.Code, "GET %s: %s", path, rec.Header().Get("Location"))
		assert.Equal(t, "hello from the device", rec.Body.String(), path)
	}
}

// 失败页的「回到设备」是控制台的设备页。页面开在转发域上，一个相对的 /devices 会被
// 浏览器解析成被转发应用自己的 /devices——出口指错了站点。
func TestForwardChain_FailurePageLeadsBackToTheConsoleDevicesPage(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	h.presence.online = false

	rec := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/"),
		h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))))

	require.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Contains(t, rec.Body.String(), `href="http://console.test:8443/devices"`)
}

// —— 剥离：只删自家票与 Authorization ——

func TestForwardChain_StripsOnlyOurCookieAndAuthorization(t *testing.T) {
	h := newHarness(t, true)
	h.linkRows()
	h.ownedDevice()
	token := h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))
	req := fwReq(http.MethodGet, prefixA, "/api/items?a=1&b=2")
	req.Header.Add("Cookie", "app_sid=s1; __Host-agentre_fw="+token+"; theme=dark")
	req.Header.Add("Cookie", "agentre_fw=stale; other=1")
	req.Header.Set("Authorization", "Bearer app-token")

	rec := h.do(req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	got := h.app.requests()[0]
	assert.Equal(t, "/api/items?a=1&b=2", got.requestURI)
	joined := strings.Join(got.cookie, "; ")
	assert.NotContains(t, joined, token)
	assert.NotContains(t, joined, "agentre_fw")
	for _, keep := range []string{"app_sid=s1", "theme=dark", "other=1"} {
		assert.Contains(t, joined, keep)
	}
	assert.Empty(t, got.authorization)
}

func TestForwardChain_OnlyOurCookieInHeaderDropsTheHeader(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	token := h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))

	rec := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/"), token))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, h.app.requests()[0].cookie)
}

// —— 保留路径 ——

func TestReservedPath_OtherAgentrePathsAreNotForwarded(t *testing.T) {
	h := newHarness(t, false)
	h.linkRows()
	h.ownedDevice()
	token := h.forwardLogin(t, userID, prefixA, h.consoleLogin(t, userID))

	rec := h.do(h.withForwardCookie(fwReq(http.MethodGet, prefixA, "/__agentre/other"), token))

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Empty(t, h.app.requests())
}

func filter(keys []string, prefix string) []string {
	var out []string
	for _, k := range keys {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	return out
}
