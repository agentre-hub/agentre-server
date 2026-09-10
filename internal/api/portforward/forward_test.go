package portforward_test

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

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
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
	"github.com/agentre-hub/agentre-server/internal/testutils"
	"github.com/agentre-hub/agentre-server/internal/web"
)

// 这一批用例走的是**真实的**那条路：cago 建的 gin engine（Recover + logger 全局链）、
// 真实的 internal/api/router.go 路由树、真实的 middleware.SessionAuth、真实的
// device_svc.OwnedDevice（只把 device_repo 换成 mockgen 的 mock）、以及真实的
// internal/web SPA 兜底。
//
// 兜底必须是真的：形状不对的 /fw/… 会拿到 200 + index.html 这个缺陷（规格决策 10）
// 只有在它在场时才看得见——换成一个自己写的 NoRoute，测的就是另一件事了。
//
// 只有两处是替身：连接池（Forwarder，它那一侧由 portforward_svc 自己的用例覆盖）与
// 在线判定（Presence，它要一台真设备和一条中继）。

const (
	fwUserID      = int64(7)
	fwDeviceID    = int64(12)
	fwFingerprint = "sha256:fp-agentred-01"
	fwPort        = uint32(3000)
	fwCookieName  = "server_session"
)

// acquireCall 记一次借用：控制器把地址里的设备翻成指纹之后到底问了谁的哪个端口。
type acquireCall struct {
	userID      int64
	fingerprint string
	port        uint32
}

// stubForwarder 站在 portforward_svc.Pool 的位置上。它交出的是一个普通的
// http.Handler——正是 Acquire 的契约（动态类型是共享包的 *portforwardhost.Proxy，
// 而这一层只认接口）。
type stubForwarder struct {
	mu       sync.Mutex
	calls    []acquireCall
	released int

	// errs 逐次交出：第一次 Acquire 取 errs[0]，第二次取 errs[1]，用完为止。
	// 「刚拿到的连接就断了、重试一次即可」那条路要靠它表达。
	errs    []error
	handler http.Handler
}

func (s *stubForwarder) Acquire(
	_ context.Context, userID int64, fingerprint string, port uint32,
) (http.Handler, func(), error) {
	s.mu.Lock()
	n := len(s.calls)
	s.calls = append(s.calls, acquireCall{userID: userID, fingerprint: fingerprint, port: port})
	s.mu.Unlock()
	if n < len(s.errs) && s.errs[n] != nil {
		return nil, nil, s.errs[n]
	}
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

// stubPresence 只答「这台机器此刻在不在线」。内嵌 RelaySvc 是为了满足 RouterDeps
// 那个字段的完整接口——其余方法这条路径上一个都不会被调到，真被调到就是 nil 解引用，
// 那正是该红的。
type stubPresence struct {
	relay_svc.RelaySvc
	mu      sync.Mutex
	online  bool
	err     error
	asked   []string
	askedID []int64
}

func (s *stubPresence) IsDaemonOnline(_ context.Context, accountID int64, fingerprint string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.asked = append(s.asked, fingerprint)
	s.askedID = append(s.askedID, accountID)
	return s.online, s.err
}

func (s *stubPresence) asks() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.asked...)
}

// recordingHandler 是被转发的那个应用。它记下自己收到的请求行，于是「前缀剥掉没有」
// 是它说了算，而不是靠读实现。
type recordingHandler struct {
	mu          sync.Mutex
	requestURIs []string
	flusher     bool
	hijacker    bool
	body        string
	onServe     func(w http.ResponseWriter, r *http.Request)
}

func (h *recordingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	h.requestURIs = append(h.requestURIs, r.URL.RequestURI())
	_, h.flusher = w.(http.Flusher)
	_, h.hijacker = w.(http.Hijacker)
	h.mu.Unlock()
	if h.onServe != nil {
		h.onServe(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, h.body)
}

func (h *recordingHandler) uris() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.requestURIs...)
}

type harness struct {
	engine    *gin.Engine
	devices   *mock_device_repo.MockDeviceRepo
	forwarder *stubForwarder
	presence  *stubPresence
	app       *recordingHandler
}

// newHarness 装起整条真实链路。pool 传 nil 表示「这个部署没有装配端口转发池」。
func newHarness(t *testing.T, withPool bool) *harness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(),
		session.New(redis.Default(), fwCookieName, 86400)))
	// OwnedDevice 只走 device_repo，签名器与配置都用不上（与 http_golden_test 同）。
	device_svc.SetDefault(device_svc.New(device_svc.Config{}, nil, jwtblacklist.New(redis.Default())))

	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(devices)

	app := &recordingHandler{body: "hello from the device"}
	h := &harness{
		devices:   devices,
		forwarder: &stubForwarder{handler: app},
		presence:  &stubPresence{online: true},
		app:       app,
	}

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	deps := &api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Signer: signer,
		Relay:  h.presence,
		Redis:  redis.Default(),
	}
	if withPool {
		deps.PortForward = h.forwarder
	}
	h.engine = newEngine(t, deps)
	return h
}

// newEngine 让 cago 自己去建那个 engine，而不是 muxtest 的 gin.Default()。
//
// 理由只有一条：web.MountSPA 把 SPA 兜底登记进 cago 的 mux 全局中间件表，那张表没有
// 读口，唯一能把真实兜底装到 engine 上的办法就是让 mux 自己走一遍它的启动路径。顺带
// 拿到的是生产上真正跑着的那条中间件链（Recover + cago 的 logger，都不包 writer）。
//
// 监听地址给 127.0.0.1:0：这条路径会真的起一个监听，用例本身不经过它（请求直接喂给
// engine），ctx 取消时随之关掉。
var mountSPAOnce sync.Once

func newEngine(t *testing.T, deps *api.RouterDeps) *gin.Engine {
	t.Helper()
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(
		map[string]interface{}{"http": map[string]interface{}{"address": []string{"127.0.0.1:0"}}},
	)))
	require.NoError(t, err)
	// 只登记一次。MountSPA 往 cago 的 mux 全局中间件表里 append，那张表在每次建
	// engine 时被整个跑一遍——每登记一次，后面每一个 engine 就多压一遍整份 dist
	// 的预压缩，用例数一多就成了平方级。登记的是同一个 NoRoute 处理器，一次就够。
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

// device 造一台账号 fwUserID 名下、还没被撤销的设备。
func device() *device_entity.Device {
	return &device_entity.Device{
		ID: fwDeviceID, UserID: fwUserID, Kind: device_entity.KindAgentred,
		Fingerprint: fwFingerprint, Status: consts.ACTIVE,
	}
}

// signedIn 造一条真实的浏览器会话并把 cookie 挂到请求上。
func signedIn(t *testing.T, req *http.Request) *http.Request {
	t.Helper()
	sid, _, err := auth_svc.Default().StartSession(context.Background(), fwUserID)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: fwCookieName, Value: sid})
	return req
}

func (h *harness) do(t *testing.T, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.engine.ServeHTTP(rec, req)
	return rec
}

// —— goal 1：登录用户打到设备并流式回来 ——

func TestForward_GivenSignedInOwnerThenReachesThatDevicesPort(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)

	rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/index.html", nil)))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "hello from the device", rec.Body.String())
	calls, released := h.forwarder.snapshot()
	// 地址里的 device_id 必须被翻成中继寻址用的指纹（决策 4 的那一步代价）。
	assert.Equal(t, []acquireCall{{userID: fwUserID, fingerprint: fwFingerprint, port: fwPort}}, calls)
	// 归还没调到的话这条连接的引用永远不归零，也就永远不会被回收。
	assert.Equal(t, 1, released)
}

// 流式：被转发应用刷出去的字节必须在它这次请求还没结束时就到客户端手里。这一条只有
// 走真 socket 才成立，所以这里把同一个 engine 挂到一个真实的 http.Server 上。
func TestForward_StreamsBeforeTheUpstreamResponseEnds(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)

	release := make(chan struct{})
	h.app.onServe = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "first chunk\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, "second chunk\n")
	}

	srv := httptest.NewServer(h.engine)
	t.Cleanup(srv.Close)
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/fw/12/3000/stream", nil)
	require.NoError(t, err)
	signedIn(t, req)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusOK, resp.StatusCode)

	reader := bufio.NewReader(resp.Body)
	line, err := reader.ReadString('\n')
	require.NoError(t, err, "第一块必须在上游还没写完时就读得到")
	assert.Equal(t, "first chunk\n", line)

	close(release)
	rest, err := io.ReadAll(reader)
	require.NoError(t, err)
	assert.Equal(t, "second chunk\n", string(rest))
}

// 101 升级与流式都要求这一层**不包**任何缓冲 ResponseWriter：共享包的 Proxy 要
// Hijacker（serveUpgraded）和 Flusher。这条用例把它钉在被转发应用拿到的那个 writer 上。
func TestForward_HandsTheProxyAHijackableFlushableWriter(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)

	h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/", nil)))

	assert.True(t, h.app.flusher, "被转发应用必须拿得到 Flusher，否则流式当场失效")
	assert.True(t, h.app.hijacker, "被转发应用必须拿得到 Hijacker，否则 101 升级当场失效")
}

// —— goal 2：三道拒绝，且设备那三种互相不可区分 ——

func TestForward_GivenNoSessionThenRejectedWithoutTouchingTheDevice(t *testing.T) {
	h := newHarness(t, true)

	rec := h.do(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/", nil))

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	calls, _ := h.forwarder.snapshot()
	assert.Empty(t, calls, "没有登录态就不该向中继上发任何东西")
	assert.Empty(t, h.presence.asks(), "也不该去问这台机器在不在线")
}

// 「查不到」「不是你的」「已经撤销」三种必须答得一模一样：只要能分开，这条地址就是
// 一台跨账号的设备存在性探测器。
func TestForward_UnknownForeignAndRevokedDevicesAreIndistinguishable(t *testing.T) {
	foreign := device()
	foreign.UserID = fwUserID + 1
	revoked := device()
	revoked.Status = consts.DELETE

	answers := map[string]*httptest.ResponseRecorder{}
	for _, c := range []struct {
		name   string
		device *device_entity.Device
	}{
		{"查不到", nil},
		{"不是你的", foreign},
		{"已经撤销", revoked},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, true)
			h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(c.device, nil)

			rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/", nil)))

			answers[c.name] = rec
			calls, _ := h.forwarder.snapshot()
			assert.Empty(t, calls, "拒绝掉的请求不该向中继上发任何东西")
			assert.Empty(t, h.presence.asks(), "也不该去问这台机器在不在线")
		})
	}

	require.Len(t, answers, 3)
	first := answers["查不到"]
	for name, got := range answers {
		assert.Equal(t, first.Code, got.Code, "%s 的状态码与「查不到」不同，可区分即是探测器", name)
		assert.Equal(t, first.Body.String(), got.Body.String(), "%s 的响应体与「查不到」不同", name)
		assert.Equal(t, first.Header().Get("Content-Type"), got.Header().Get("Content-Type"),
			"%s 的 Content-Type 与「查不到」不同", name)
	}
}

// —— goal 3：设备离线 ——

func TestForward_GivenOfflineDeviceThenAnswersOfflineWithoutDialing(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)
	h.presence.online = false

	rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/", nil)))

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Equal(t, []string{fwFingerprint}, h.presence.asks())
	calls, _ := h.forwarder.snapshot()
	assert.Empty(t, calls, "在线判定不过就不再往中继上发任何东西")
}

// 在线判定与拨号之间机器走掉了：拨号面原样上交 ErrMachineOffline，答的是同一张。
func TestForward_GivenDialSaysOfflineThenAnswersTheSameAsTheOnlineCheck(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)
	h.forwarder.errs = []error{mirror_svc.ErrMachineOffline}

	rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/", nil)))

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}

// 刚拿到的连接在借出前就断了：重试一次即可（ErrConnectionGone 的语义）。
func TestForward_RetriesOnceWhenTheConnectionWasGone(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)
	h.forwarder.errs = []error{portforward_svc.ErrConnectionGone}

	rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/", nil)))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	calls, _ := h.forwarder.snapshot()
	assert.Len(t, calls, 2, "断掉的那条应该重试一次")
}

// 这个部署没有装配连接池：说「这里没有这条能力」，而不是去拨一个不存在的中继。
func TestForward_GivenNoPoolAssembledThenAnswersUnavailable(t *testing.T) {
	h := newHarness(t, false)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil).AnyTimes()

	rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/", nil)))

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

// 池已经收工（进程正在退出）：同样是「此刻这里没有这条能力」。
func TestForward_GivenStoppedPoolThenAnswersUnavailable(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)
	h.forwarder.errs = []error{portforward_svc.ErrStopped}

	rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/", nil)))

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

// —— goal 4：前缀只剥一次 ——

func TestForward_StripsExactlyThePortPrefix(t *testing.T) {
	cases := []struct {
		name string
		path string
		want string
	}{
		{"根路径不带尾斜杠变成 /", "/fw/12/3000", "/"},
		{"根路径带尾斜杠", "/fw/12/3000/", "/"},
		{"子路径只剥一层", "/fw/12/3000/assets/x.js", "/assets/x.js"},
		{"查询串原样带过去", "/fw/12/3000/api?a=1&b=2", "/api?a=1&b=2"},
		{"与前缀同名的子路径不受影响", "/fw/12/3000/fw/12/3000/x", "/fw/12/3000/x"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, true)
			h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)

			rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, c.path, nil)))

			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			assert.Equal(t, []string{c.want}, h.app.uris())
		})
	}
}

// —— goal 5：形状不对的不回落 SPA 外壳 ——

// 这条用例挂着真实的 web.MountSPA 兜底。没有 /fw 路由时它必然给出 200 + text/html：
// 浏览器里是一张白屏而状态码正常，没有任何东西会红（规格决策 10）。
func TestForward_MalformedAddressesNeverFallBackToTheSPAShell(t *testing.T) {
	for _, path := range []string{
		"/fw", "/fw/", "/fw/12", "/fw/12/", "/fw/12/http", "/fw/abc/3000", "/fw/12/3000x",
	} {
		t.Run(path, func(t *testing.T) {
			h := newHarness(t, true)
			h.devices.EXPECT().Find(gomock.Any(), gomock.Any()).Return(device(), nil).AnyTimes()

			rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, path, nil)))

			t.Logf("GET %s → %d %s", path, rec.Code, rec.Header().Get("Content-Type"))
			isSPAShell := rec.Code == http.StatusOK &&
				strings.Contains(rec.Header().Get("Content-Type"), "text/html")
			assert.False(t, isSPAShell,
				"%s 落到了 SPA 外壳上：%d %s", path, rec.Code, rec.Header().Get("Content-Type"))
			calls, _ := h.forwarder.snapshot()
			assert.Empty(t, calls, "形状都不对，不该向中继上发任何东西")
		})
	}
}

// 这一条钉的是「本仓的 SPA 兜底此刻确实会吞掉 /fw/…」——上面那条用例的前提。它挂的
// 是同一个真实兜底，只是路径不在 /fw 之下，于是照旧回外壳。前提哪天变了（比如兜底
// 改成对未知前缀 404），这里会红，上面那条就该重新想一遍还测不测得到东西。
func TestForward_SPAShellStillSwallowsUnknownPathsOutsideFW(t *testing.T) {
	h := newHarness(t, true)

	rec := h.do(t, httptest.NewRequest(http.MethodGet, "/some-frontend-route", nil))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/html")
}

// 写方法必须过得去：/fw/ 不挂 CSRF（决策 5），被转发应用自己的 POST 不可能带控制台
// 的 CSRF token，挂上就等于禁掉转发下的一切写请求。
func TestForward_WriteMethodsPassWithoutAConsoleCSRFToken(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)
	var gotMethod, gotBody string
	h.app.onServe = func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.WriteHeader(http.StatusCreated)
	}

	req := httptest.NewRequest(http.MethodPost, "/fw/12/3000/api/save", strings.NewReader(`{"a":1}`))
	rec := h.do(t, signedIn(t, req))

	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Equal(t, http.MethodPost, gotMethod)
	assert.Equal(t, `{"a":1}`, gotBody, "请求体必须原样交给被转发应用")
}

// 剩余路径原样交给被转发应用，包括点段：那一段是**它的**路径，不是我们的。这里替它
// 规范化会改掉它看到的东西，而这条服务端上没有任何东西按它去读文件。
func TestForward_PassesDotSegmentsInTheRemainderThrough(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)

	rec := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000/../../etc", nil)))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, []string{"/../../etc"}, h.app.uris())
}

// gin 默认开着 RedirectTrailingSlash，而本轮**不动**那个全局开关（它管着本仓全部既有
// 路由）。所以这里把它对 /fw 之下的实际影响钉住，免得下一个人凭直觉猜：
//
//   - /fw/12/3000 直接进处理器，**不吃**尾斜杠重定向——通配尾段自己就匹配上了，
//     它是「/fw/ 之后还有东西」的形状。地址栏里那条不带尾斜杠的地址因此是一跳到位的。
//   - /fw 本身会先吃一个 301 到 /fw/，因为整条路由是 /fw/*forward，/fw 只差那个斜杠。
//     那一跳之后落到 404，与其余形状不对的一样，不会落到 SPA 外壳上。
func TestForward_TrailingSlashBehaviourIsPinned(t *testing.T) {
	h := newHarness(t, true)
	h.devices.EXPECT().Find(gomock.Any(), fwDeviceID).Return(device(), nil)

	direct := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw/12/3000", nil)))
	bare := h.do(t, signedIn(t, httptest.NewRequest(http.MethodGet, "/fw", nil)))

	assert.Equal(t, http.StatusOK, direct.Code, "不该先吃一个尾斜杠重定向")
	assert.Equal(t, http.StatusMovedPermanently, bare.Code)
	assert.Equal(t, "/fw/", bare.Header().Get("Location"))
}
