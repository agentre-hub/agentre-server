package portforward_ctr_test

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 控制台的会话 cookie 是 Path=/ 的，所以浏览器会把它一起发到 /fw/<设备>/<端口>/… 上；
// 而共享代理（agentre/pkg/wire/portforwardhost）是逐格拷贝请求头的，逐跳头清单里
// 没有 Cookie 与 Authorization。不在这里剥掉，被转发设备上那个本机服务（以及它的
// access log）就直接拿到一张有效期 14 天的控制台会话票明文 —— 转发的信任边界是
// 「浏览器 ↔ server」，它不延伸到被转发的那个应用。
func TestForward_ConsoleCredentials_DoNotReachTheForwardedApp(t *testing.T) {
	seen := &headerSpy{}
	h := newHarness(t, seen, true)

	request := httptest.NewRequest(http.MethodGet, "/fw/12/3000/assets/x.js", nil)
	request.Header.Set("Cookie", "agentre_session=s3cr3t-console-ticket")
	request.Header.Set("Authorization", "Bearer console-bearer")
	request.Header.Set("Accept", "text/javascript")
	rec := httptest.NewRecorder()
	h.engine.ServeHTTP(rec, request)

	require.Equal(t, http.StatusOK, rec.Code)
	got := seen.header()
	assert.Empty(t, got.Values("Cookie"),
		"控制台的会话票不许出现在被转发设备的本机请求里")
	assert.Empty(t, got.Values("Authorization"),
		"控制台的 Authorization 同样只对 server 有意义，不该外流")
	assert.Equal(t, "text/javascript", got.Get("Accept"),
		"其余请求头照旧透传：被转发的应用要看得见真实请求")
}

// 剥头只作用在交给代理的那份请求上：控制台自己这条请求的 cookie 还在，否则同一条
// 请求上后续任何读会话的地方都会以为用户没登录。
func TestForward_StrippingCredentials_LeavesTheConsoleRequestIntact(t *testing.T) {
	seen := &headerSpy{}
	h := newHarness(t, seen, true)

	request := httptest.NewRequest(http.MethodGet, "/fw/12/3000/", nil)
	request.Header.Set("Cookie", "agentre_session=s3cr3t-console-ticket")
	rec := httptest.NewRecorder()
	h.engine.ServeHTTP(rec, request)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, seen.header().Values("Cookie"))
	assert.Equal(t, "agentre_session=s3cr3t-console-ticket", request.Header.Get("Cookie"))
}

// headerSpy 是站在转发下游的「被转发应用」：它只记下自己收到的请求头。
type headerSpy struct {
	mu  sync.Mutex
	got http.Header
}

func (s *headerSpy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.got = r.Header.Clone()
	s.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (s *headerSpy) header() http.Header {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.got == nil {
		return http.Header{}
	}
	return s.got
}
