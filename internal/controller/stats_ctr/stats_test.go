package stats_ctr_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/api"
	deviceapi "github.com/agentre-hub/agentre-server/internal/api/device"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/activity_svc"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

const testCookieName = "server_session"

// stubActivity 记下控制器**转下去了什么**，并交回一份钉死的视图。控制器这一层要证明
// 的就是这两件事：入参原样落到服务上、服务的视图逐字段落进 JSON。
type stubActivity struct {
	activity_svc.ActivitySvc

	overview      activity_svc.OverviewView
	overviewRange string

	settings     activity_svc.SettingsView
	settingsCall int

	setEnabled  []bool
	setBackfill []bool

	reported     map[string]string
	reportedFPs  []string
	reportedCall int
}

func (s *stubActivity) Overview(
	_ context.Context, _ int64, rangeKey string,
) (activity_svc.OverviewView, error) {
	s.overviewRange = rangeKey
	return s.overview, nil
}

func (s *stubActivity) Settings(_ context.Context, _ int64) (activity_svc.SettingsView, error) {
	s.settingsCall++
	return s.settings, nil
}

func (s *stubActivity) SetActivityStats(_ context.Context, _ int64, enabled, backfill bool) error {
	s.setEnabled = append(s.setEnabled, enabled)
	s.setBackfill = append(s.setBackfill, backfill)
	// 写完之后再读到的是**新的**设置：PUT 的回执必须来自这一份，而不是请求体。
	s.settings.ActivityStatsEnabled = enabled
	return nil
}

func (s *stubActivity) ReportedThrough(
	_ context.Context, _ int64, fingerprints []string,
) (map[string]string, error) {
	s.reportedCall++
	s.reportedFPs = fingerprints
	return s.reported, nil
}

// stubDevices 只顶替 ListUserDevices 这一个方法：设备域其余的活（授权、吊销、在线态）
// 与这三条端点无关，内嵌接口让它们保持「没实现就是没实现」，被误调时当场炸而不是
// 悄悄返回零值。
type stubDevices struct {
	device_svc.DeviceSvc

	items    []deviceapi.ListDevicesItem
	callerID int64
}

func (s *stubDevices) ListUserDevices(
	_ context.Context, _, callerDeviceID int64,
) ([]deviceapi.ListDevicesItem, error) {
	s.callerID = callerDeviceID
	return s.items, nil
}

// serve 起一份真实路由树：真中间件（SessionAuth + CSRF）、真绑定校验、真信封，
// 只把两个服务换成桩。三条端点归哪一组鉴权，只有走这里才证明得了。
func serve(t *testing.T, act *stubActivity, dev *stubDevices) (*httptest.Server, string, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	activity_svc.SetDefault(act)
	t.Cleanup(func() { activity_svc.SetDefault(activity_svc.New()) })
	device_svc.SetDefault(dev)
	t.Cleanup(func() { device_svc.SetDefault(nil) })
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	tm := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Signer: signer,
	}).Router(context.Background(), tm.Router))
	server := httptest.NewServer(tm.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	sid, sess, err := auth_svc.Default().StartSession(context.Background(), testUserID)
	require.NoError(t, err)
	return server, sid, sess.CSRFToken
}

const testUserID int64 = 7

func do(t *testing.T, method, url, sessionID, csrf, body string) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, url, reader)
	require.NoError(t, err)
	if sessionID != "" {
		req.AddCookie(&http.Cookie{Name: testCookieName, Value: sessionID})
	}
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// data 取出信封里的 data 原文。序列化后的字节本身就是契约：空切片是 `[]` 还是 `null`
// 在 Go 侧看不出来，只有这里看得出来。
func data(t *testing.T, resp *http.Response) string {
	t.Helper()
	body, code, raw := envelope(t, resp)
	require.Equal(t, http.StatusOK, resp.StatusCode, raw)
	require.Equal(t, 0, code, raw)
	return body
}

func envelope(t *testing.T, resp *http.Response) (string, int, string) {
	t.Helper()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var env struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(raw, &env), string(raw))
	return string(env.Data), env.Code, string(raw)
}

// requireRejected 断言这次请求没有被当成一次成功的读写：要么 HTTP 不是 200，
// 要么信封里的业务码不是 0。
func requireRejected(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.StatusCode == http.StatusOK {
		_, code, raw := envelope(t, resp)
		require.NotEqual(t, 0, code, raw)
	}
}

func device(id int64, name, fingerprint string, online bool) deviceapi.ListDevicesItem {
	return deviceapi.ListDevicesItem{ID: id, Name: name, Fingerprint: fingerprint, Online: online, Status: 1}
}

// 在线台数与总台数是**设备域**的事实，服务层刻意不给；控制器从设备清单上数出来。
func TestOverview_DeviceCountsComeFromTheDeviceList(t *testing.T) {
	act := &stubActivity{overview: activity_svc.OverviewView{
		ActivityStatsEnabled: true,
		Scope:                activity_svc.ScopeFull,
		TimeZone:             "Asia/Shanghai",
		Summary: activity_svc.SummaryView{
			Conversations: 143, ConversationsTotal: 486, WindowDays: 30,
		},
		Heatmap: activity_svc.HeatmapView{
			From: "2025-09-01", To: "2026-08-28", Days: []activity_svc.DayCount{},
		},
		Agents:   []activity_svc.AgentCount{},
		Backends: []activity_svc.BackendCount{},
		Models:   []activity_svc.ModelCount{},
		Projects: []activity_svc.ProjectCount{},
	}}
	dev := &stubDevices{items: []deviceapi.ListDevicesItem{
		device(1, "mac-mini", "fp-a", true),
		device(2, "MacBook-Pro", "fp-b", false),
		device(3, "linux-box", "fp-c", true),
	}}
	server, sid, csrf := serve(t, act, dev)

	body := data(t, do(t, http.MethodGet, server.URL+"/v1/stats/overview?range=30d", sid, csrf, ""))

	assert.Contains(t, body, `"devices_online":2`)
	assert.Contains(t, body, `"devices_total":3`)
	assert.Contains(t, body, `"conversations":143`)
	assert.Contains(t, body, `"conversations_total":486`)
	assert.Equal(t, "30d", act.overviewRange)
}

// 空账号是最常见的输入，也是最容易白屏的那一种：四张分布与热力图的日期列表在 JSON 里
// 必须是 []，不能是 null——前端对它们是直接 map 的。
func TestOverview_EmptyAccountSerializesEmptyArraysNotNull(t *testing.T) {
	act := &stubActivity{overview: activity_svc.OverviewView{
		Scope:   activity_svc.ScopeSaved,
		Heatmap: activity_svc.HeatmapView{From: "2025-09-01", To: "2026-08-28"},
	}}
	server, sid, csrf := serve(t, act, &stubDevices{})

	body := data(t, do(t, http.MethodGet, server.URL+"/v1/stats/overview", sid, csrf, ""))

	for _, key := range []string{"agents", "backends", "models", "projects"} {
		assert.Contains(t, body, `"`+key+`":[]`, "%s 必须是空数组", key)
		assert.NotContains(t, body, `"`+key+`":null`)
	}
	assert.Contains(t, body, `"days":[]`)
	assert.NotContains(t, body, `"days":null`)
	assert.Contains(t, body, `"devices_online":0`)
	assert.Contains(t, body, `"devices_total":0`)
}

// 没有任何活动时 busiest_day 是 null，而不是一个 count 为 0 的假日期——后者是画得出来的。
func TestOverview_BusiestDayIsNullWhenThereIsNoActivity(t *testing.T) {
	act := &stubActivity{overview: activity_svc.OverviewView{
		Heatmap: activity_svc.HeatmapView{From: "2025-09-01", To: "2026-08-28"},
	}}
	server, sid, csrf := serve(t, act, &stubDevices{})

	body := data(t, do(t, http.MethodGet, server.URL+"/v1/stats/overview", sid, csrf, ""))
	assert.Contains(t, body, `"busiest_day":null`)
}

func TestOverview_KeepsBusiestDayWhenThereIsOne(t *testing.T) {
	act := &stubActivity{overview: activity_svc.OverviewView{Heatmap: activity_svc.HeatmapView{
		From:            "2025-09-01",
		To:              "2026-08-28",
		Days:            []activity_svc.DayCount{{Day: "2026-08-28", Count: 11}},
		BusiestDay:      &activity_svc.DayCount{Day: "2026-05-14", Count: 11},
		AvgPerActiveDay: 5.4,
	}}}
	server, sid, csrf := serve(t, act, &stubDevices{})

	body := data(t, do(t, http.MethodGet, server.URL+"/v1/stats/overview", sid, csrf, ""))
	assert.Contains(t, body, `"busiest_day":{"day":"2026-05-14","count":11}`)
	assert.Contains(t, body, `"avg_per_active_day":5.4`)
}

// range 认不出来的值在绑定层就被挡住：服务层从不会看见它，也就不必为它编一个默认。
func TestOverview_RejectsUnknownRange(t *testing.T) {
	act := &stubActivity{}
	server, sid, csrf := serve(t, act, &stubDevices{})

	requireRejected(t, do(t, http.MethodGet, server.URL+"/v1/stats/overview?range=90d", sid, csrf, ""))
	assert.Empty(t, act.overviewRange, "非法 range 不该走到服务层")
}

// 不带 range 时按 30d 算：默认档由控制器补上，服务层拿到的永远是一个认得出的键。
//
// 30 天而不是 7 天，是为了与控制台首屏落在同一档（Overview.tsx 的初始 range）：前端
// 每次都显式带参，所以这个默认在线上不会被触发 —— 正因为如此，它一旦与前端不同，
// 就是一个没有任何测试会发现、也没有任何人会察觉的分歧。
func TestOverview_DefaultsToThirtyDays(t *testing.T) {
	act := &stubActivity{}
	server, sid, csrf := serve(t, act, &stubDevices{})

	data(t, do(t, http.MethodGet, server.URL+"/v1/stats/overview", sid, csrf, ""))
	assert.Equal(t, "30d", act.overviewRange)
}

// 三条端点只认浏览器会话：没有 cookie 的调用方拿到的是 401，不是 404。
func TestStats_RequiresBrowserSession(t *testing.T) {
	server, _, _ := serve(t, &stubActivity{}, &stubDevices{})

	for _, path := range []string{"/v1/stats/overview", "/v1/stats/settings"} {
		resp := do(t, http.MethodGet, server.URL+path, "", "", "")
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, path)
	}
}

// 写那一条按 cookie 鉴权，因此必须清 CSRF。
func TestSaveSettings_RequiresCSRF(t *testing.T) {
	act := &stubActivity{}
	server, sid, _ := serve(t, act, &stubDevices{})

	resp := do(t, http.MethodPut, server.URL+"/v1/stats/settings", sid, "", `{"activity_stats_enabled":true}`)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.Empty(t, act.setEnabled)
}

func settingsStub() *stubActivity {
	return &stubActivity{
		settings: activity_svc.SettingsView{
			ActivityStatsEnabled: true,
			LastReportAt:         1756368000000,
			SavedConversations:   128,
			Today:                "2026-08-28",
		},
		reported: map[string]string{"fp-a": "2026-08-28"},
	}
}

// 逐台机器的「已上报到哪一天」来自 ReportedThrough，键是指纹；没上报过的机器该字段
// **缺席**，而不是一个空串——空串在前端是一个画得出来的「已上报到 ”」。
func TestSettings_DeviceReportedThroughOmittedWhenNeverReported(t *testing.T) {
	act := settingsStub()
	dev := &stubDevices{items: []deviceapi.ListDevicesItem{
		device(2, "mac-mini", "fp-a", true),
		device(3, "MacBook-Pro", "fp-b", false),
	}}
	server, sid, csrf := serve(t, act, dev)

	body := data(t, do(t, http.MethodGet, server.URL+"/v1/stats/settings", sid, csrf, ""))

	assert.Contains(t, body, `{"device_id":2,"name":"mac-mini","online":true,"reported_through":"2026-08-28"}`)
	assert.Contains(t, body, `{"device_id":3,"name":"MacBook-Pro","online":false}`)
	assert.NotContains(t, body, `"reported_through":""`)
	assert.Equal(t, []string{"fp-a", "fp-b"}, act.reportedFPs)
	assert.Contains(t, body, `"last_report_at":1756368000000`)
	assert.Contains(t, body, `"saved_conversations":128`)
}

// 一台设备都没有时 devices 整段缺席：前端据此**不画**这一段，而不是摆一排「未知」。
func TestSettings_OmitsDevicesSectionWhenThereAreNone(t *testing.T) {
	act := settingsStub()
	server, sid, csrf := serve(t, act, &stubDevices{})

	body := data(t, do(t, http.MethodGet, server.URL+"/v1/stats/settings", sid, csrf, ""))
	assert.NotContains(t, body, `"devices"`)
	assert.Equal(t, 0, act.reportedCall, "没有设备就不必去问上报进度")
}

// pending_backfill_days 服务端眼下没有真实进度可交，因此这个字段一个字都不写。
func TestSettings_NeverInventsPendingBackfillDays(t *testing.T) {
	act := settingsStub()
	dev := &stubDevices{items: []deviceapi.ListDevicesItem{device(2, "mac-mini", "fp-a", true)}}
	server, sid, csrf := serve(t, act, dev)

	body := data(t, do(t, http.MethodGet, server.URL+"/v1/stats/settings", sid, csrf, ""))
	assert.NotContains(t, body, "pending_backfill_days")
}

// 开启那一次带回填：两个布尔都要原样落到服务上。
func TestSaveSettings_PassesBackfillThroughWhenEnabling(t *testing.T) {
	act := settingsStub()
	act.settings.ActivityStatsEnabled = false
	server, sid, csrf := serve(t, act, &stubDevices{})

	body := `{"activity_stats_enabled":true,"backfill":true}`
	data(t, do(t, http.MethodPut, server.URL+"/v1/stats/settings", sid, csrf, body))

	assert.Equal(t, []bool{true}, act.setEnabled)
	assert.Equal(t, []bool{true}, act.setBackfill)
}

// 关闭时前端不发 backfill——关闭没有回填这回事，服务上收到的是 false。
func TestSaveSettings_DisablesWithoutBackfill(t *testing.T) {
	act := settingsStub()
	server, sid, csrf := serve(t, act, &stubDevices{})

	data(t, do(t, http.MethodPut, server.URL+"/v1/stats/settings", sid, csrf, `{"activity_stats_enabled":false}`))

	assert.Equal(t, []bool{false}, act.setEnabled)
	assert.Equal(t, []bool{false}, act.setBackfill)
}

// PUT 的回执是**重新读出来的**设置，而不是拿请求体拼的一份「我以为的」结果。
func TestSaveSettings_ReturnsRereadSettings(t *testing.T) {
	act := settingsStub()
	act.settings.ActivityStatsEnabled = false
	server, sid, csrf := serve(t, act, &stubDevices{})

	req := `{"activity_stats_enabled":true,"backfill":false}`
	body := data(t, do(t, http.MethodPut, server.URL+"/v1/stats/settings", sid, csrf, req))

	assert.Contains(t, body, `"activity_stats_enabled":true`)
	assert.Contains(t, body, `"saved_conversations":128`)
	assert.Equal(t, 1, act.settingsCall, "写完必须重读一次")
}

// 缺了开关本身就是一次说不清的写：绑定层挡掉，服务上不留痕迹。
func TestSaveSettings_RejectsBodyWithoutTheSwitch(t *testing.T) {
	act := settingsStub()
	server, sid, csrf := serve(t, act, &stubDevices{})

	requireRejected(t, do(t, http.MethodPut, server.URL+"/v1/stats/settings", sid, csrf, `{"backfill":true}`))
	assert.Empty(t, act.setEnabled)
}

// TestSettings_ZeroSavedConversationsIsStillSaid 守「0 条」说得出来。
//
// saved_conversations 上不能有 omitempty：前端判的是 `!== undefined`，而一个还没保存过
// 任何对话的账号算出来正是 0 —— 被 omitempty 吃掉之后，它与「服务端给不出这个数」在
// 线上长得一模一样，界面上「已保存的对话」标题旁边什么都不显示。而那是最常见的新账号。
func TestSettings_ZeroSavedConversationsIsStillSaid(t *testing.T) {
	act := settingsStub()
	act.settings.SavedConversations = 0
	server, sid, csrf := serve(t, act, &stubDevices{})

	body := data(t, do(t, http.MethodGet, server.URL+"/v1/stats/settings", sid, csrf, ""))

	assert.Contains(t, body, `"saved_conversations":0`)
}

// TestSettings_CarriesTheServerDay 守服务端把自己的「今天」一起交出去。
//
// 逐台机器那行「已上报到今天」要拿 reported_through 与今天比，而 reported_through 是按
// **服务端**时区切的。少了这个字段，前端只能拿浏览器的今天去比：服务端在 UTC+8 的早上
// 07:00，浏览器算出来的今天还是昨天，于是一台刚上报完的机器被显示成「已上报到 2026-08-28」
// —— 一个在用户看来像是未来的日期。
func TestSettings_CarriesTheServerDay(t *testing.T) {
	act := settingsStub()
	server, sid, csrf := serve(t, act, &stubDevices{})

	body := data(t, do(t, http.MethodGet, server.URL+"/v1/stats/settings", sid, csrf, ""))

	assert.Contains(t, body, `"today":"2026-08-28"`)
}
