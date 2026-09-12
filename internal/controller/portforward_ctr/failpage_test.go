package portforward_ctr_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/portforwardhost"
	"github.com/agentre-hub/agentre/pkg/wire/protorpc"
	"github.com/agentre-hub/agentre/pkg/wire/rpcerror"

	"github.com/agentre-hub/agentre-server/internal/api/portforward"
	"github.com/agentre-hub/agentre-server/internal/controller/portforward_ctr"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// 这一批用例盯的是**失败的措辞**：共享代理判出「是哪一件事」（七种），控制台按种类
// 决定说什么——四种各一张完整的页，三种一句话（规格
// 2026-09-09-console-forward-failure-pages 决策 5/6）。
//
// 判据是**种类**，不是状态码：上一轮那层按纯状态码嗅探的改写 writer 分不开「谁答的」，
// 把被转发应用自己的 502 也改写掉了（Problem 1，有运行期截图）。所以这里的失败是让
// 共享包**真的**判出来的：一条真的 protorpc.Conn，对面一个真的按领域码回绝 open 的
// 设备，钩子按生产上那样装在 NewProxy 上。给一个已经贴好类别的假失败就等于把判据本身
// 绕过去了。
//
// 整条真实路由树（真 SessionAuth、真 SPA 兜底）那一层的用例住在
// internal/api/portforward/，本包只装到「gin 把请求交给 Forward」这一层为止。

const (
	pageUserID      = int64(7)
	pageDeviceID    = int64(12)
	pageFingerprint = "sha256:fp-agentred-01"
	// 这四个端口是**设备那一侧**回哪个领域码的开关，见 proxyFor。
	portNoListener  = uint32(3000)
	portNotDeclared = uint32(4000)
	portDisabled    = uint32(4001)
	portUnreachable = uint32(4002)
)

// ── 替身 ────────────────────────────────────────────────────────────────

type stubDevices struct{ device *device_entity.Device }

func (s stubDevices) OwnedDevice(_ context.Context, _, _ int64) (*device_entity.Device, error) {
	return s.device, nil
}

// stubPresence 逐次交出在线判定：第 n 次读取 answers[n]，用完之后一直取最后一个。
// 它同时是「这条路上一共读了几次在线状态」的计数器——本轮把那个数从 2 压回 1
// （规格决策 4）。
type stubPresence struct {
	mu      sync.Mutex
	answers []bool
	err     error
	calls   int
}

func (s *stubPresence) IsDaemonOnline(_ context.Context, _ int64, _ string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.calls
	s.calls++
	if s.err != nil {
		return false, s.err
	}
	if n >= len(s.answers) {
		return s.answers[len(s.answers)-1], nil
	}
	return s.answers[n], nil
}

func (s *stubPresence) asked() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

type stubForwarder struct {
	handler  http.Handler
	acquired int
	released int
}

func (s *stubForwarder) Acquire(
	_ context.Context, _ int64, _ string, _ uint32,
) (http.Handler, func(), error) {
	s.acquired++
	return s.handler, func() { s.released++ }, nil
}

// handlerFunc 让「被转发应用」用一个函数就能站上去。
type handlerFunc func(http.ResponseWriter, *http.Request)

func (f handlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) { f(w, r) }

// ── 内存帧管道：一条真的 protorpc 连接，底下换成 channel ──────────────────
//
// 生产上这一对是「协议引擎 ← relayFrameConn → 中继 → daemon」。这里只需要对面能按
// 领域码回绝 open，于是两端都是内存里的一条 protorpc.Conn。那对管道与
// portforward_svc 的用例共用（internal/testutils.NewFramePipe），不在这里再抄一份。

// proxyFor 造一个真的代理，转到 conn 对面那台设备的 port 上，并按**生产上那样**把
// 控制台的渲染钩子装在构造处（生产上这一步在 portforward_svc.Pool 里，钩子由
// internal/bootstrap 交进去）。
func proxyFor(t *testing.T, port uint32) http.Handler {
	t.Helper()
	clientTransport, deviceTransport := testutils.NewFramePipe()
	client := protorpc.NewConn(clientTransport, protorpc.NewRegistry(),
		protorpc.WithCallTimeout(5*time.Second))
	device := protorpc.NewConn(deviceTransport, protorpc.NewRegistry())
	protorpc.RegisterMethod(device.Registry(),
		uint32(agentrewire.RpcMethod_RPC_METHOD_PORT_FORWARD_OPEN),
		func() *agentrewire.PortForwardOpenRequest { return &agentrewire.PortForwardOpenRequest{} },
		func(_ context.Context, request *agentrewire.PortForwardOpenRequest,
		) (*agentrewire.PortForwardOpenResponse, error) {
			switch request.GetPort() {
			case portNotDeclared:
				return nil, &rpcerror.Error{
					Code: rpcerror.CodePortForwardNotDeclared, Message: "no such declaration",
				}
			case portDisabled:
				return nil, &rpcerror.Error{
					Code: rpcerror.CodePortForwardDisabled, Message: "declaration disabled",
				}
			case portUnreachable:
				// 不是这三个领域码里的任何一个：共享包把它归成「够不着设备」。
				return nil, errors.New("something else entirely")
			default:
				return nil, &rpcerror.Error{
					Code: rpcerror.CodePortForwardNoListener, Message: "nothing listening",
				}
			}
		})
	ctx, cancel := context.WithCancel(context.Background())
	go client.Serve(ctx)
	go device.Serve(ctx)
	t.Cleanup(func() {
		cancel()
		_ = client.Close()
		_ = device.Close()
	})
	return portforwardhost.NewProxy(client, port, func(string) {},
		portforwardhost.WithFailureRenderer(portforward_ctr.RenderFailure))
}

// ── 装配 ────────────────────────────────────────────────────────────────

type harness struct {
	engine    *gin.Engine
	presence  *stubPresence
	forwarder *stubForwarder
}

// newHarness 把控制器挂在它生产上那条路由形状上。登录态由 middleware.SessionAuth
// 判掉（那一层的用例在 internal/api/portforward），这里只补它落下的那把键。
func newHarness(t *testing.T, app http.Handler, online ...bool) *harness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := &harness{
		presence:  &stubPresence{answers: online},
		forwarder: &stubForwarder{handler: app},
	}
	device := &device_entity.Device{ID: pageDeviceID, UserID: pageUserID, Fingerprint: pageFingerprint}
	ctr := portforward_ctr.New(stubDevices{device: device}, h.presence, h.forwarder)
	engine := gin.New()
	engine.Any(portforward.RoutePattern, func(c *gin.Context) {
		ginctx.SetUserID(c, pageUserID)
	}, ctr.Forward)
	h.engine = engine
	return h
}

func (h *harness) get(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.engine.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// assertFailurePage 断言这是一张完整的失败页，且两个出口都在：刷新与回到设备。
func assertFailurePage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	body := rec.Body.String()
	assert.Contains(t, rec.Header().Get("Content-Type"), "text/html",
		"失败页必须是 HTML，纯文本在浏览器标签里给不出出口")
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	assert.True(t, strings.HasPrefix(strings.TrimSpace(body), "<!DOCTYPE html>"),
		"必须是一张完整的页：四周没有控制台的外壳\n%s", body)
	assert.True(t, strings.HasSuffix(strings.TrimSpace(body), "</html>"),
		"页面后面不该再跟着别的正文\n%s", body)
	assert.Contains(t, body, ">刷新<", "缺「刷新」这个出口")
	assert.Contains(t, body, `href="/devices"`, "缺「回到设备」这个出口")
	// 不引外部资源：这一页的宿主是被转发的那个应用，拉不到控制台的静态资源也要能看。
	for _, forbidden := range []string{"http://", "https://", "<img", "<script"} {
		assert.NotContains(t, body, forbidden, "失败页不得引入外部资源")
	}
	return body
}

// ── 四种出页，三种出一句话 ──────────────────────────────────────────────

// 这一条钉的是**种类到答复**那张表本身：七种一个不落，外加共享包将来长出的第八种。
// 状态码原样照用共享包为该种类定的那一个（本轮不改任何一种失败的状态码）。
func TestRenderFailure_GivenEachKind_ThenTheAnswerItsUserCanActOn(t *testing.T) {
	for _, c := range []struct {
		name     string
		kind     portforwardhost.FailureKind
		status   int
		page     bool
		contains []string
	}{
		{
			name: "端口没有映射", kind: portforwardhost.FailureNotDeclared,
			status: http.StatusNotFound, page: true,
			contains: []string{"没有转发映射", "127.0.0.1:3000", "控制台的设备页"},
		},
		{
			name: "映射已停用", kind: portforwardhost.FailureDisabled,
			status: http.StatusForbidden, page: true,
			// 指向控制台而不是桌面端：用户刚刚就是在控制台里停用的（Problem 2）。
			contains: []string{"已停用", "控制台的设备页", "启用"},
		},
		{
			name: "端口上没有服务", kind: portforwardhost.FailureNoListener,
			status: http.StatusBadGateway, page: true,
			contains: []string{"没有服务在监听", "把服务起起来"},
		},
		{
			name: "够不着设备", kind: portforwardhost.FailureDeviceUnreachable,
			status: http.StatusBadGateway, page: true,
			contains: []string{"设备离线", "等它重新上线"},
		},
		{
			name: "上游把请求断了", kind: portforwardhost.FailureUpstreamGone,
			status: http.StatusBadGateway, page: false,
			contains: []string{"断开"},
		},
		{
			name: "转发没有完成", kind: portforwardhost.FailureForwardIncomplete,
			status: http.StatusBadGateway, page: false,
			contains: []string{"没有完成"},
		},
		{
			name: "升级做不了", kind: portforwardhost.FailureUpgradeUnavailable,
			status: http.StatusInternalServerError, page: false,
			contains: []string{"WebSocket"},
		},
		{
			// 共享包将来长出第八种：不能沉默地套上四张页里的某一张，那等于替一件我们
			// 还不认识的事编一个下一步。
			name: "还不认识的第八种", kind: portforwardhost.FailureKind(99),
			status: http.StatusBadGateway, page: false,
			contains: []string{"没有完成"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()

			portforward_ctr.RenderFailure(rec, httptest.NewRequest(http.MethodGet, "/", nil),
				portforwardhost.Failure{Kind: c.kind, Port: 3000, Status: c.status})

			require.Equal(t, c.status, rec.Code, "状态码照用共享包定的那一个")
			assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
			if c.page {
				assertFailurePage(t, rec)
			} else {
				assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain")
				assert.NotContains(t, rec.Body.String(), "<!DOCTYPE html>",
					"这一种给一句话：一整张页给不出比它更多的东西")
			}
			for _, want := range c.contains {
				assert.Contains(t, rec.Body.String(), want)
			}
		})
	}
}

// 四张页说的是四件不同的事：区别必须在页面上说得出来，不然用户不知道该做哪一件。
func TestRenderFailure_TheFourPagesSayFourDifferentThings(t *testing.T) {
	seen := map[string]portforwardhost.FailureKind{}
	for _, kind := range []portforwardhost.FailureKind{
		portforwardhost.FailureNotDeclared,
		portforwardhost.FailureDisabled,
		portforwardhost.FailureNoListener,
		portforwardhost.FailureDeviceUnreachable,
	} {
		rec := httptest.NewRecorder()
		portforward_ctr.RenderFailure(rec, httptest.NewRequest(http.MethodGet, "/", nil),
			portforwardhost.Failure{Kind: kind, Port: 3000, Status: http.StatusBadGateway})
		body := rec.Body.String()
		if other, ok := seen[body]; ok {
			t.Fatalf("第 %d 种与第 %d 种答成了同一张页", kind, other)
		}
		seen[body] = kind
	}
}

// ── 种类真的从共享代理走过来 ────────────────────────────────────────────

// 上面那张表钉的是「种类 → 答复」，这一批钉的是「设备回的领域码 → 种类」这一段真的
// 接得上：一条真的连接、一个真的按码回绝 open 的设备、生产上那样装的钩子。
func TestForward_GivenTheDeviceRejectsOpen_ThenTheConsolePageForThatKind(t *testing.T) {
	for _, c := range []struct {
		name    string
		path    string
		port    uint32
		status  int
		heading string
	}{
		{"端口没有映射", "/fw/12/4000/", portNotDeclared, http.StatusNotFound, "没有转发映射"},
		{"映射已停用", "/fw/12/4001/", portDisabled, http.StatusForbidden, "已停用"},
		{"端口上没有服务", "/fw/12/3000/", portNoListener, http.StatusBadGateway, "没有服务在监听"},
		{"够不着设备", "/fw/12/4002/", portUnreachable, http.StatusBadGateway, "设备离线"},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, proxyFor(t, c.port), true)

			rec := h.get(t, c.path)

			require.Equal(t, c.status, rec.Code)
			body := assertFailurePage(t, rec)
			assert.Contains(t, body, c.heading)
			// 规格决策 4：种类自己就分开了「够不着」与「没有服务」，不必再读一次在线
			// 状态去猜。open 之前那一次是唯一的一次。
			assert.Equal(t, 1, h.presence.asked(),
				"为了分类别多读一次在线状态，本轮已经删掉了")
			assert.Equal(t, 1, h.forwarder.released, "归还没调到，这条连接的引用就永远不归零")
		})
	}
}

// open 之前的在线判定不过：这一类**不经过**共享代理（连都没拨），由控制器自己答，
// 规格决策 7 要它维持原样——仍是「设备离线」那一张。
func TestForward_GivenOfflineBeforeOpen_ThenTheOfflinePageWithoutDialing(t *testing.T) {
	h := newHarness(t, proxyFor(t, portNoListener), false)

	rec := h.get(t, "/fw/12/3000/")

	require.Equal(t, http.StatusBadGateway, rec.Code)
	body := assertFailurePage(t, rec)
	assert.Contains(t, body, "设备离线")
	assert.Contains(t, body, "等它重新上线")
	assert.Equal(t, 0, h.forwarder.acquired, "在线判定不过就不该往中继上发任何东西")
	assert.Equal(t, 1, h.presence.asked())
}

// 在线判定自己读不出来：与「读不出来就当它不在线」同一条口径，也不拨号。
func TestForward_GivenPresenceUnreadable_ThenTheOfflinePageWithoutDialing(t *testing.T) {
	h := newHarness(t, proxyFor(t, portNoListener), true)
	h.presence.err = errors.New("redis is down")

	rec := h.get(t, "/fw/12/3000/")

	require.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Contains(t, rec.Body.String(), "设备离线")
	assert.Equal(t, 0, h.forwarder.acquired)
}

// ── 被转发应用自己的答复：一个字节都不许动 ──────────────────────────────

// 这一条是 Problem 1 的回归守卫。旧的改写层按纯状态码嗅探，把应用自己答的 502 也换成
// 了「端口上没有服务」那张页——服务在跑，页面却叫用户去起它（运行期证据
// 07-upstream-502-rewritten.png）。控制台此刻在 c.Writer 外面**不包任何一层**，钩子
// 只挂在共享代理自己的失败上，所以这里不可能再误伤。
func TestForward_TheForwardedAppsOwnAnswersPassThroughByteForByte(t *testing.T) {
	for _, c := range []struct {
		name   string
		status int
		body   string
	}{
		{"应用自己的 502", http.StatusBadGateway, "upstream says 502"},
		{"应用自己的 404", http.StatusNotFound, "no such page in my app"},
		{"应用自己的 403", http.StatusForbidden, "my app says no"},
		{"应用自己的 500", http.StatusInternalServerError, "my app blew up"},
	} {
		t.Run(c.name, func(t *testing.T) {
			app := handlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				w.Header().Set("X-App", "yes")
				w.WriteHeader(c.status)
				_, _ = io.WriteString(w, c.body)
			})
			h := newHarness(t, app, true)

			rec := h.get(t, "/fw/12/3000/")

			require.Equal(t, c.status, rec.Code)
			assert.Equal(t, c.body, rec.Body.String(), "应用自己的正文被控制台换掉了")
			assert.Equal(t, "yes", rec.Header().Get("X-App"))
			assert.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"))
			assert.Equal(t, 1, h.presence.asked(), "应用自己的答复不该引出任何额外的判定")
		})
	}
}

func TestForward_SuccessfulResponsesPassThroughUntouched(t *testing.T) {
	app := handlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-App", "yes")
		_, _ = io.WriteString(w, "<h1>hello from the device</h1>")
	})
	h := newHarness(t, app, true)

	rec := h.get(t, "/fw/12/3000/")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "<h1>hello from the device</h1>", rec.Body.String())
	assert.Equal(t, "yes", rec.Header().Get("X-App"))
	assert.Equal(t, 1, h.presence.asked(), "成功的那条不该多读一次在线状态")
	assert.Equal(t, 1, h.forwarder.released, "归还没调到，这条连接的引用就永远不归零")
}

// 分块写出去的字节一块都不能少，Flush 也不能被吞掉。
func TestForward_ChunkedWritesAndFlushesAreNotSwallowed(t *testing.T) {
	app := handlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "first\n")
		w.(http.Flusher).Flush()
		_, _ = io.WriteString(w, "second\n")
		w.(http.Flusher).Flush()
	})
	h := newHarness(t, app, true)

	rec := h.get(t, "/fw/12/3000/")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "first\nsecond\n", rec.Body.String())
}

// 被转发应用拿到的 writer 必须能被 http.NewResponseController 认出来：共享包的
// serveUpgraded 走的就是它（101 升级），Flush 也走它。包一层就断链的话，升级会当场
// 答 500 而不是把连接交出去。
func TestForward_TheProxyGetsAResponseControllableWriter(t *testing.T) {
	var flushable, hijackable bool
	var flushErr error
	app := handlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, flushable = w.(http.Flusher)
		_, hijackable = w.(http.Hijacker)
		flushErr = http.NewResponseController(w).Flush()
	})
	h := newHarness(t, app, true)

	rec := h.get(t, "/fw/12/3000/")

	assert.True(t, flushable, "拿不到 Flusher，流式当场失效")
	assert.True(t, hijackable, "拿不到 Hijacker，101 升级当场失效")
	require.NoError(t, flushErr, "共享包走的是 ResponseController，它找不到 Flusher 就流不起来")
	// 「有一个 Flush 方法」与「Flush 真的一路走到底」是两件事：上一轮那层改写 writer
	// 在换页之后就把 Flush 吞掉了，而它的类型断言照样过。
	assert.True(t, rec.Flushed, "Flush 没有走到底下那个 writer，流式当场失效")
}
