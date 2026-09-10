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
)

// 这一批用例盯的是**改写层**：共享包 portforwardhost 把七种失败全答成纯文本，其中四种
// 共用 502，而用户此刻在一个转发地址的浏览器标签里，需要的是两张说明不同的完整页面
// （规格 2026-09-09-console-port-forward-host 决策 7/8/13）。
//
// 判据只有「状态码 + 502 之后再读一次在线状态」，**不含任何上游文案匹配**——那几句
// 中文常量在上游仓且未导出，上游改一个字这里就静默失灵，而本仓不会有任何东西红。
// 所以这里的 502 是让共享包**真的**答出来的：一条真的 protorpc.Conn，对面一个真的
// 按领域码回绝 open 的设备。给一个已经贴好类别的假失败就等于把判据本身绕过去了。
//
// 整条真实路由树（真 SessionAuth、真 SPA 兜底）那一层的用例住在
// internal/api/portforward/，本包只装到「gin 把请求交给 Forward」这一层为止：改写层
// 看得见的东西到这里就齐了，再往上是另一个包的接缝。

const (
	pageUserID      = int64(7)
	pageDeviceID    = int64(12)
	pageFingerprint = "sha256:fp-agentred-01"
	// 这三个端口是**设备那一侧**回哪个领域码的开关，见 proxyFor。
	portNoListener  = uint32(3000)
	portNotDeclared = uint32(4000)
	portDisabled    = uint32(4001)
)

// ── 替身 ────────────────────────────────────────────────────────────────

type stubDevices struct{ device *device_entity.Device }

func (s stubDevices) OwnedDevice(_ context.Context, _, _ int64) (*device_entity.Device, error) {
	return s.device, nil
}

// stubPresence 逐次交出在线判定：第 n 次读取 answers[n]，用完之后一直取最后一个。
// 「open 之前在线、502 之后已经离线」这条路要靠它表达。
type stubPresence struct {
	mu      sync.Mutex
	answers []bool
	// errFrom 是「从第几次读起就读不出来了」。0 表示每次都读得出来。
	errFrom int
	err     error
	calls   int
}

func (s *stubPresence) IsDaemonOnline(_ context.Context, _ int64, _ string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.calls
	s.calls++
	if s.err != nil && n+1 >= s.errFrom {
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
// 领域码回绝 open，于是两端都是内存里的一条 protorpc.Conn。

type memFrameConn struct {
	in   chan []byte
	out  chan []byte
	done chan struct{}
	once sync.Once
}

func newFramePipe() (client, device *memFrameConn) {
	toDevice := make(chan []byte, 64)
	toClient := make(chan []byte, 64)
	client = &memFrameConn{in: toClient, out: toDevice, done: make(chan struct{})}
	device = &memFrameConn{in: toDevice, out: toClient, done: make(chan struct{})}
	return client, device
}

func (c *memFrameConn) ReadFrame() ([]byte, error) {
	select {
	case frame := <-c.in:
		return frame, nil
	case <-c.done:
		return nil, io.EOF
	}
}

func (c *memFrameConn) WriteFrame(frame []byte) error {
	select {
	case c.out <- frame:
		return nil
	case <-c.done:
		return protorpc.ErrConnClosed
	}
}

func (c *memFrameConn) Close() error {
	c.once.Do(func() { close(c.done) })
	return nil
}

func (c *memFrameConn) Done() <-chan struct{} { return c.done }

// proxy 造一个真的代理，转到 conn 对面那台设备的 port 上。
func proxyFor(t *testing.T, port uint32) http.Handler {
	t.Helper()
	clientTransport, deviceTransport := newFramePipe()
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
	return portforwardhost.NewProxy(client, port, func(string) {})
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
		"上游那句纯文本不该被追加在页面后面\n%s", body)
	assert.Contains(t, body, ">刷新<", "缺「刷新」这个出口")
	assert.Contains(t, body, `href="/devices"`, "缺「回到设备」这个出口")
	// 不引外部资源：这一页的宿主是被转发的那个应用，拉不到控制台的静态资源也要能看。
	for _, forbidden := range []string{"http://", "https://", "<img", "<script"} {
		assert.NotContains(t, body, forbidden, "失败页不得引入外部资源")
	}
	return body
}

// ── 两张页 ──────────────────────────────────────────────────────────────

// 共享包答了 502，而二次在线判定说设备还在线 → 「端口上没有服务」。
func TestForward_Given502AndTheDeviceIsStillOnline_ThenTheNoServicePage(t *testing.T) {
	h := newHarness(t, proxyFor(t, portNoListener), true, true)

	rec := h.get(t, "/fw/12/3000/index.html")

	require.Equal(t, http.StatusBadGateway, rec.Code)
	body := assertFailurePage(t, rec)
	assert.Contains(t, body, "没有服务在监听")
	assert.Contains(t, body, "把服务起起来", "这一张要说的下一步是「去起服务」")
	assert.NotContains(t, body, "等它重新上线", "这一张不该叫用户去等机器")
	assert.Equal(t, 2, h.presence.asked(), "502 之后必须再读一次在线状态（决策 13）")
}

// 共享包答了 502，而二次在线判定说设备已经不在线 → 「设备离线」。
func TestForward_Given502AndTheDeviceWentOffline_ThenTheOfflinePage(t *testing.T) {
	h := newHarness(t, proxyFor(t, portNoListener), true, false)

	rec := h.get(t, "/fw/12/3000/index.html")

	require.Equal(t, http.StatusBadGateway, rec.Code)
	body := assertFailurePage(t, rec)
	assert.Contains(t, body, "设备离线")
	assert.Contains(t, body, "等它重新上线", "这一张要说的下一步是「等机器回来」")
	assert.NotContains(t, body, "把服务起起来", "这一张不该叫用户去起一个起不起来的服务")
	assert.Equal(t, 2, h.presence.asked())
}

// 二次在线判定自己读不出来：与「读不出来就当它不在线」同一条口径（open 之前那次也是
// 这么判的），说「等机器回来」而不是叫用户去起一个其实起着的服务。
func TestForward_Given502AndPresenceUnreadable_ThenTheOfflinePage(t *testing.T) {
	h := newHarness(t, proxyFor(t, portNoListener), true)
	h.presence.err = errors.New("redis is down")
	h.presence.errFrom = 2 // 第一次要过得去，不然根本走不到 open

	rec := h.get(t, "/fw/12/3000/")

	require.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Contains(t, rec.Body.String(), "设备离线")
	assert.Contains(t, rec.Body.String(), "等它重新上线")
}

// 两张页说的是不同的两件事：区别必须在页面上说得出来（上游规格「失败与恢复」）。
func TestForward_TheTwoPagesSayDifferentThings(t *testing.T) {
	online := newHarness(t, proxyFor(t, portNoListener), true, true).get(t, "/fw/12/3000/")
	offline := newHarness(t, proxyFor(t, portNoListener), true, false).get(t, "/fw/12/3000/")

	assert.NotEqual(t, online.Body.String(), offline.Body.String(),
		"两种失败答成同一张页，用户就没法知道该做哪件事")
}

// open 之前的在线判定不过：直接答「设备离线」那一张，且不去拨号（规格「失败的呈现」
// 里那两条来路的第一条）。
func TestForward_GivenOfflineBeforeOpen_ThenTheOfflinePageWithoutDialing(t *testing.T) {
	h := newHarness(t, proxyFor(t, portNoListener), false)

	rec := h.get(t, "/fw/12/3000/")

	require.Equal(t, http.StatusBadGateway, rec.Code)
	body := assertFailurePage(t, rec)
	assert.Contains(t, body, "设备离线")
	assert.Contains(t, body, "等它重新上线")
	assert.Equal(t, 0, h.forwarder.acquired, "在线判定不过就不该往中继上发任何东西")
	assert.Equal(t, 1, h.presence.asked(), "没开成流就没有第二次读的必要")
}

// ── 不被改写的那几种 ────────────────────────────────────────────────────

// 404（没有这个映射）与 403（映射已停用）状态码各自独立，保持共享包的纯文本答复
// （规格「失败的呈现」）。改写它们等于把两种设备侧的判定说成第三件事。
func TestForward_404And403AreNotRewritten(t *testing.T) {
	for _, c := range []struct {
		name string
		path string
		port uint32
		want int
	}{
		{"没有这个映射", "/fw/12/4000/", portNotDeclared, http.StatusNotFound},
		{"映射已停用", "/fw/12/4001/", portDisabled, http.StatusForbidden},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, proxyFor(t, c.port), true, true)

			rec := h.get(t, c.path)

			require.Equal(t, c.want, rec.Code)
			assert.Contains(t, rec.Header().Get("Content-Type"), "text/plain")
			assert.NotContains(t, rec.Body.String(), "<!DOCTYPE html>")
			assert.Equal(t, 1, h.presence.asked(), "只有 502 才触发第二次在线读")
		})
	}
}

// 500（升级失败）同样不改写。
//
// 这一条的上游站的是替身而不是真代理：共享包那个 500 只在 Hijack 失败时出现，而生产
// 上这一层交给代理的 writer 恒是可 Hijack 的（既有用例把它钉住了），造不出那个失败。
// 改写层的判据是状态码，替身写的是与共享包 writeFailure 一模一样的答复形状。
func TestForward_500IsNotRewritten(t *testing.T) {
	app := handlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "升级失败\n")
	})
	h := newHarness(t, app, true, true)

	rec := h.get(t, "/fw/12/3000/")

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "升级失败\n", rec.Body.String())
	assert.Equal(t, 1, h.presence.asked())
}

// ── 改写层不得碰成功的那一条 ─────────────────────────────────────────────

func TestForward_SuccessfulResponsesPassThroughUntouched(t *testing.T) {
	app := handlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-App", "yes")
		_, _ = io.WriteString(w, "<h1>hello from the device</h1>")
	})
	h := newHarness(t, app, true, true)

	rec := h.get(t, "/fw/12/3000/")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "<h1>hello from the device</h1>", rec.Body.String())
	assert.Equal(t, "yes", rec.Header().Get("X-App"))
	assert.Equal(t, 1, h.presence.asked(), "成功的那条不该多读一次在线状态")
	assert.Equal(t, 1, h.forwarder.released, "归还没调到，这条连接的引用就永远不归零")
}

// 分块写出去的字节一块都不能少，Flush 也不能被吞掉：改写层只缓冲到第一次 WriteHeader
// 的决策为止，此后一个字节都不再经手。
func TestForward_ChunkedWritesAndFlushesAreNotSwallowed(t *testing.T) {
	app := handlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "first\n")
		w.(http.Flusher).Flush()
		_, _ = io.WriteString(w, "second\n")
		w.(http.Flusher).Flush()
	})
	h := newHarness(t, app, true, true)

	rec := h.get(t, "/fw/12/3000/")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "first\nsecond\n", rec.Body.String())
}

// 被转发应用拿到的 writer 必须能被 http.NewResponseController 认出来：共享包的
// serveUpgraded 走的就是它（101 升级），Flush 也走它。包一层就断链的话，
// 升级会当场答 500 而不是把连接交出去。
func TestForward_TheWrappedWriterStaysResponseControllable(t *testing.T) {
	var unwrapped, flushable, hijackable bool
	app := handlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		type unwrapper interface{ Unwrap() http.ResponseWriter }
		if u, ok := w.(unwrapper); ok {
			unwrapped = u.Unwrap() != nil
		}
		_, flushable = w.(http.Flusher)
		_, hijackable = w.(http.Hijacker)
		_ = http.NewResponseController(w).Flush()
	})
	h := newHarness(t, app, true, true)

	h.get(t, "/fw/12/3000/")

	assert.True(t, unwrapped, "Unwrap 断链，ResponseController 就找不到底下那个 writer")
	assert.True(t, flushable, "拿不到 Flusher，流式当场失效")
	assert.True(t, hijackable, "拿不到 Hijacker，101 升级当场失效")
}
