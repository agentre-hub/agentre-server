package portforward_ctr_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/portforwardhost"
	"github.com/agentre-hub/agentre/pkg/wire/protorpc"
	"github.com/agentre-hub/agentre/pkg/wire/rpcerror"

	"github.com/agentre-hub/agentre-server/internal/controller/portforward_ctr"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// 这一批用例盯的是**失败的措辞**：共享代理判出「是哪一件事」（九种），控制台按种类
// 决定说什么——六种各一张完整的页，三种一句话（规格
// 2026-09-09-console-forward-failure-pages 决策 5/6，三张「目标连不上」见
// 2026-09-21-port-forward-subdomain「失败的呈现」）。
//
// 判据是**种类**，不是状态码：上一轮那层按纯状态码嗅探的改写 writer 分不开「谁答的」，
// 把被转发应用自己的 502 也改写掉了（Problem 1，有运行期截图）。所以这里的失败是让
// 共享包**真的**判出来的：一条真的 protorpc.Conn，对面一个真的按领域码回绝 open 的
// 设备，钩子按生产上那样装在 NewProxy 上。给一个已经贴好类别的假失败就等于把判据本身
// 绕过去了。
//
// 上一轮这个包还兼着 /fw/ 那条路由的控制器（Forward），整条真实路由树的用例因此住在
// internal/api/portforward/。规格 2026-09-21-port-forward-subdomain 决策 13 把 /fw/
// 整条路径删掉，本包不再挂路由（见 portforward.go 的包注释）：这里因此改成直接把
// portforwardhost.Proxy 当 http.Handler 调，不再经过任何 gin 路由树——钩子本身与路由
// 无关，这样测反而更直接。

// consoleURL 是这批用例里控制台的地址；renderFailure 是生产装配同一个构造出来的钩子。
const consoleURL = "https://console.test"

var renderFailure = portforward_ctr.NewFailureRenderer(consoleURL)

const (
	// 这几个映射 id 是**设备那一侧**回哪个领域码的开关，见 proxyFor。
	mappingNoListener      = int64(3000)
	mappingNotDeclared     = int64(4000)
	mappingDisabled        = int64(4001)
	mappingUnreachable     = int64(4002)
	mappingNameResolution  = int64(4003)
	mappingTLSVerification = int64(4004)
	// mappingNamedTarget 回「连接被拒」，并按 rpcerror 的约定在 Details 里带回这条
	// 声明的目标——生产上的设备就是这么回的（agentre 仓 daemon/portforward）。
	mappingNamedTarget = int64(4005)
)

// ── 内存帧管道：一条真的 protorpc 连接，底下换成 channel ──────────────────
//
// 生产上这一对是「协议引擎 ← relayFrameConn → 中继 → daemon」。这里只需要对面能按
// 领域码回绝 open，于是两端都是内存里的一条 protorpc.Conn。那对管道与
// portforward_svc 的用例共用（internal/testutils.NewFramePipe），不在这里再抄一份。

// proxyFor 造一个真的代理，转到 conn 对面那台设备的 mappingID 上，并按**生产上那样**
// 把控制台的渲染钩子装在构造处（生产上这一步在 portforward_svc.Pool 里，钩子由
// internal/bootstrap 交进去）。
func proxyFor(t *testing.T, mappingID int64) http.Handler {
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
			switch request.GetMappingId() {
			case mappingNotDeclared:
				return nil, &rpcerror.Error{
					Code: rpcerror.CodePortForwardNotDeclared, Message: "no such declaration",
				}
			case mappingDisabled:
				return nil, &rpcerror.Error{
					Code: rpcerror.CodePortForwardDisabled, Message: "declaration disabled",
				}
			case mappingNameResolution:
				return nil, &rpcerror.Error{
					Code: rpcerror.CodePortForwardNameResolution, Message: "no such host",
				}
			case mappingTLSVerification:
				return nil, &rpcerror.Error{
					Code: rpcerror.CodePortForwardTLSVerification, Message: "x509: certificate signed by unknown authority",
				}
			case mappingNamedTarget:
				details, err := proto.Marshal(&agentrewire.PortForwardMapping{
					Id: mappingNamedTarget, Target: "http://127.0.0.1:5173",
				})
				if err != nil {
					return nil, err
				}
				return nil, &rpcerror.Error{
					Code: rpcerror.CodePortForwardNoListener, Message: "connection refused", Details: details,
				}
			case mappingUnreachable:
				// 不是这几个领域码里的任何一个：共享包把它归成「够不着设备」。
				return nil, errors.New("something else entirely")
			default:
				return nil, &rpcerror.Error{
					Code: rpcerror.CodePortForwardNoListener, Message: "connection refused",
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
	return portforwardhost.NewProxy(client, mappingID, func(string) {},
		portforwardhost.WithFailureRenderer(renderFailure))
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
	// 「回到设备」是控制台设备页的绝对地址：页面开在转发域上，相对的 /devices 会落到
	// 被转发应用自己那里。
	assert.Contains(t, body, `href="`+consoleURL+`/devices"`, "缺「回到设备」这个出口")
	// 不引外部资源：这一页的宿主是被转发的那个应用，拉不到控制台的静态资源也要能看。
	// 判的是「加载」的形状——正文会点名映射的目标（规格「失败的呈现」），「回到设备」
	// 是一次导航，它们都不是加载。
	for _, forbidden := range []string{`src=`, "<link", "url(", "<img", "<script"} {
		assert.NotContains(t, body, forbidden, "失败页不得引入外部资源")
	}
	return body
}

// ── 六种出页，三种出一句话 ──────────────────────────────────────────────

// 这一条钉的是**种类到答复**那张表本身：九种一个不落，外加共享包将来长出的第十种。
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
			name: "映射不存在", kind: portforwardhost.FailureNotDeclared,
			status: http.StatusNotFound, page: true,
			contains: []string{"这条映射不存在", "控制台的设备页"},
		},
		{
			name: "映射已停用", kind: portforwardhost.FailureDisabled,
			status: http.StatusForbidden, page: true,
			// 指向控制台而不是桌面端：用户刚刚就是在控制台里停用的（Problem 2）。
			contains: []string{"已停用", "控制台的设备页", "启用"},
		},
		{
			name: "目标拒绝连接", kind: portforwardhost.FailureNoListener,
			status: http.StatusBadGateway, page: true,
			contains: []string{"目标连不上", "没有服务在监听", "把服务起起来"},
		},
		{
			name: "目标解析不出主机名", kind: portforwardhost.FailureNameResolution,
			status: http.StatusBadGateway, page: true,
			contains: []string{"目标连不上", "解析不了", "主机名"},
		},
		{
			name: "目标证书没通过校验", kind: portforwardhost.FailureTLSVerification,
			status: http.StatusBadGateway, page: true,
			contains: []string{"目标连不上", "证书没有通过校验", "忽略证书错误"},
		},
		{
			name: "够不着设备", kind: portforwardhost.FailureDeviceUnreachable,
			status: http.StatusBadGateway, page: true,
			contains: []string{"设备离线", "没有连着 Agentre", "等它重新上线"},
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
			// 共享包将来长出第十种：不能沉默地套上面某一张页，那等于替一件我们
			// 还不认识的事编一个下一步。
			name: "还不认识的第十种", kind: portforwardhost.FailureKind(99),
			status: http.StatusBadGateway, page: false,
			contains: []string{"没有完成"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()

			renderFailure(rec, httptest.NewRequest(http.MethodGet, "/", nil),
				portforwardhost.Failure{Kind: c.kind, MappingID: 3000, Status: c.status})

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

// 六张页说的是六件不同的事：区别必须在页面上说得出来，不然用户不知道该做哪一件。
// 三张「目标连不上」共用同一个标题（规格「失败的呈现」：同一类，三种原因），但正文
// 必须彼此不同——这条钉的正是「共用标题不等于说的是同一件事」。
func TestRenderFailure_TheSixPagesSayDifferentThings(t *testing.T) {
	seen := map[string]portforwardhost.FailureKind{}
	for _, kind := range []portforwardhost.FailureKind{
		portforwardhost.FailureNotDeclared,
		portforwardhost.FailureDisabled,
		portforwardhost.FailureNoListener,
		portforwardhost.FailureNameResolution,
		portforwardhost.FailureTLSVerification,
		portforwardhost.FailureDeviceUnreachable,
	} {
		rec := httptest.NewRecorder()
		renderFailure(rec, httptest.NewRequest(http.MethodGet, "/", nil),
			portforwardhost.Failure{Kind: kind, MappingID: 3000, Status: http.StatusBadGateway})
		body := rec.Body.String()
		if other, ok := seen[body]; ok {
			t.Fatalf("第 %d 种与第 %d 种答成了同一张页", kind, other)
		}
		seen[body] = kind
	}
}

// 「目标连不上」三张页把话说到具体的目标上（规格「失败的呈现」）：连接被拒说
// 「<目标> 上没有服务在监听」，名字解析失败说「设备解析不了 <主机>」，证书校验失败说
// 「<目标> 的证书没有通过校验」并提示勾选「忽略证书错误」。目标是设备在回绝里说出的
// 那一条（Failure.Target）；它来自用户自己的声明，写进 HTML 之前要转义。
func TestRenderFailure_GivenTheDeviceNamedTheTarget_ThenThePageNamesIt(t *testing.T) {
	for _, c := range []struct {
		name     string
		kind     portforwardhost.FailureKind
		target   string
		contains []string
	}{
		{
			name: "连接被拒", kind: portforwardhost.FailureNoListener, target: "http://127.0.0.1:3000",
			contains: []string{"http://127.0.0.1:3000 上没有服务在监听"},
		},
		{
			name: "名字解析失败", kind: portforwardhost.FailureNameResolution, target: "https://nas.lan:8443",
			contains: []string{"设备解析不了 nas.lan"},
		},
		{
			name: "证书校验失败", kind: portforwardhost.FailureTLSVerification, target: "https://nas.lan:8443",
			contains: []string{"https://nas.lan:8443 的证书没有通过校验", "忽略证书错误"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()

			renderFailure(rec, httptest.NewRequest(http.MethodGet, "/", nil),
				portforwardhost.Failure{Kind: c.kind, MappingID: 3000, Status: http.StatusBadGateway, Target: c.target})

			body := assertFailurePage(t, rec)
			for _, want := range c.contains {
				assert.Contains(t, body, want)
			}
		})
	}

	t.Run("目标里的标记被转义", func(t *testing.T) {
		rec := httptest.NewRecorder()

		renderFailure(rec, httptest.NewRequest(http.MethodGet, "/", nil),
			portforwardhost.Failure{
				Kind: portforwardhost.FailureNoListener, MappingID: 3000, Status: http.StatusBadGateway,
				Target: `http://a<script>x:80`,
			})

		body := assertFailurePage(t, rec)
		assert.Contains(t, body, "http://a&lt;script&gt;x:80 上没有服务在监听")
	})
}

// ── 种类真的从共享代理走过来 ────────────────────────────────────────────

// 上面那张表钉的是「种类 → 答复」，这一批钉的是「设备回的领域码 → 种类」这一段真的
// 接得上：一条真的连接、一个真的按码回绝 open 的设备、生产上那样装的钩子。
func TestProxy_GivenTheDeviceRejectsOpen_ThenTheConsolePageForThatKind(t *testing.T) {
	for _, c := range []struct {
		name      string
		mappingID int64
		status    int
		heading   string
	}{
		{"映射不存在", mappingNotDeclared, http.StatusNotFound, "这条映射不存在"},
		{"映射已停用", mappingDisabled, http.StatusForbidden, "已停用"},
		{"目标拒绝连接", mappingNoListener, http.StatusBadGateway, "目标连不上"},
		{"目标解析不出主机名", mappingNameResolution, http.StatusBadGateway, "目标连不上"},
		{"目标证书没通过校验", mappingTLSVerification, http.StatusBadGateway, "目标连不上"},
		{"够不着设备", mappingUnreachable, http.StatusBadGateway, "设备离线"},
		// 设备在回绝里说出了目标：页面点名它，这一段真的从设备一路走到了页面上。
		{"目标拒绝连接且点名目标", mappingNamedTarget, http.StatusBadGateway, "http://127.0.0.1:5173 上没有服务在监听"},
	} {
		t.Run(c.name, func(t *testing.T) {
			proxy := proxyFor(t, c.mappingID)

			rec := httptest.NewRecorder()
			proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

			require.Equal(t, c.status, rec.Code)
			body := assertFailurePage(t, rec)
			assert.Contains(t, body, c.heading)
		})
	}
}
