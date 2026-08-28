package passkey_ctr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/passkey_svc"
)

const testCookieName = "server_session"

// stubPasskeySvc 只复刻 HTTP 接缝要看的语义：谁调的、带的是哪条会话、返回什么。
// 真正的 WebAuthn 校验由 passkey_svc 自己的单测覆盖，这里桩掉是为了让这一层只测
// 路由、鉴权分组、CSRF、错误码与限流。
type stubPasskeySvc struct {
	options    json.RawMessage
	beginCalls []struct {
		userID    int64
		sessionID string
	}
	finished []passkey_svc.FinishRegistration
	items    map[int64][]passkey_svc.Passkey
	deleted  []int64

	// 登录侧：反查出来的账号、要复现的失败码，以及收到的回应原文。
	loginUserID int64
	loginErr    int
	loginBodies [][]byte
}

func (s *stubPasskeySvc) BeginLogin(_ context.Context) (json.RawMessage, error) {
	return s.options, nil
}

func (s *stubPasskeySvc) FinishLogin(ctx context.Context, response []byte) (int64, error) {
	s.loginBodies = append(s.loginBodies, response)
	if s.loginErr != 0 {
		return 0, i18n.NewError(ctx, s.loginErr)
	}
	return s.loginUserID, nil
}

func newStubPasskeySvc() *stubPasskeySvc {
	return &stubPasskeySvc{
		options: json.RawMessage(`{"challenge":"Q0hBTExFTkdF","rp":{"id":"example.com"}}`),
		items:   map[int64][]passkey_svc.Passkey{},
	}
}

func (s *stubPasskeySvc) BeginRegistration(_ context.Context, userID int64, sessionID string) (
	json.RawMessage, error) {
	s.beginCalls = append(s.beginCalls, struct {
		userID    int64
		sessionID string
	}{userID, sessionID})
	return s.options, nil
}

func (s *stubPasskeySvc) FinishRegistration(_ context.Context, in passkey_svc.FinishRegistration) (
	*passkey_svc.Passkey, error) {
	s.finished = append(s.finished, in)
	p := passkey_svc.Passkey{ID: 11, Name: in.Name, CreatedAt: 1000, LastUsedAt: 0}
	s.items[in.UserID] = append(s.items[in.UserID], p)
	return &p, nil
}

func (s *stubPasskeySvc) List(_ context.Context, userID int64) ([]passkey_svc.Passkey, error) {
	return s.items[userID], nil
}

func (s *stubPasskeySvc) Delete(ctx context.Context, userID, id int64) error {
	for i, it := range s.items[userID] {
		if it.ID == id {
			s.items[userID] = append(s.items[userID][:i], s.items[userID][i+1:]...)
			s.deleted = append(s.deleted, id)
			return nil
		}
	}
	return i18n.NewNotFoundError(ctx, code.PasskeyNotFound)
}

func newServer(t *testing.T, stub *stubPasskeySvc, rl bootstrap.RLConfig) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	passkey_svc.SetDefault(stub)
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg: &bootstrap.ServerConfig{RateLimit: rl}, Signer: signer,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server
}

func generousLimits() bootstrap.RLConfig {
	return bootstrap.RLConfig{
		PasskeyRegisterBeginPerIPPerMin:      1000,
		PasskeyRegisterBeginPerAccountPerMin: 1000,
		PasskeyLoginBeginPerIPPerMin:         1000,
	}
}

func newSessionCookie(t *testing.T, userID int64) (string, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return sid, sess.CSRFToken
}

type request struct {
	method, path, body, cookie, csrf, ip, ua string
}

func do(t *testing.T, server *httptest.Server, r request) *http.Response {
	t.Helper()
	req, err := http.NewRequest(r.method, server.URL+r.path, strings.NewReader(r.body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	if r.cookie != "" {
		req.AddCookie(&http.Cookie{Name: testCookieName, Value: r.cookie})
	}
	if r.csrf != "" {
		req.Header.Set("X-CSRF-Token", r.csrf)
	}
	if r.ip != "" {
		req.Header.Set("X-Forwarded-For", r.ip)
	}
	if r.ua != "" {
		req.Header.Set("User-Agent", r.ua)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func decode[T any](t *testing.T, resp *http.Response) (int, T) {
	t.Helper()
	var envelope struct {
		Code int `json:"code"`
		Data T   `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	return envelope.Code, envelope.Data
}

// 四个端点全在浏览器会话分组里：没有 cookie 一律 401，不能凭 device JWT 或裸请求碰。
func TestPasskeyEndpoints_RequireBrowserSession(t *testing.T) {
	server := newServer(t, newStubPasskeySvc(), generousLimits())

	for _, r := range []request{
		{method: http.MethodPost, path: "/v1/passkeys/register/begin"},
		{method: http.MethodPost, path: "/v1/passkeys/register/finish", body: `{"name":"k","credential":{}}`},
		{method: http.MethodGet, path: "/v1/passkeys"},
		{method: http.MethodDelete, path: "/v1/passkeys/11"},
	} {
		resp := do(t, server, r)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, r.path)
	}
}

// 写操作要过 CSRF：只带 cookie 不带 token 一律 403。清单是 GET，安全方法照常放行。
func TestPasskeyWrites_RequireCSRF(t *testing.T) {
	server := newServer(t, newStubPasskeySvc(), generousLimits())
	sid, _ := newSessionCookie(t, 71)

	for _, r := range []request{
		{method: http.MethodPost, path: "/v1/passkeys/register/begin", cookie: sid},
		{method: http.MethodPost, path: "/v1/passkeys/register/finish",
			body: `{"name":"k","credential":{}}`, cookie: sid},
		{method: http.MethodDelete, path: "/v1/passkeys/11", cookie: sid},
	} {
		resp := do(t, server, r)
		assert.Equal(t, http.StatusForbidden, resp.StatusCode, r.path)
	}

	resp := do(t, server, request{method: http.MethodGet, path: "/v1/passkeys", cookie: sid})
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

// begin 把**当前这条会话**交给 service：challenge 就是按它归集的，传错了等于让另一个
// 浏览器能把这次注册接着做完。
func TestBeginRegistration_BindsTheChallengeToTheCurrentSession(t *testing.T) {
	stub := newStubPasskeySvc()
	server := newServer(t, stub, generousLimits())
	sid, csrf := newSessionCookie(t, 72)

	resp := do(t, server, request{
		method: http.MethodPost, path: "/v1/passkeys/register/begin", cookie: sid, csrf: csrf,
	})
	require.Equal(t, http.StatusOK, resp.StatusCode)

	_, data := decode[struct {
		PublicKey json.RawMessage `json:"publicKey"`
	}](t, resp)
	assert.JSONEq(t, string(stub.options), string(data.PublicKey))
	require.Len(t, stub.beginCalls, 1)
	assert.Equal(t, int64(72), stub.beginCalls[0].userID)
	assert.Equal(t, sid, stub.beginCalls[0].sessionID)
}

// finish 把用户输入的名字与认证器回应原文一起交给 service，账号取自会话而不是请求体。
func TestFinishRegistration_PassesTypedNameAndRawResponse(t *testing.T) {
	stub := newStubPasskeySvc()
	server := newServer(t, stub, generousLimits())
	sid, csrf := newSessionCookie(t, 73)

	resp := do(t, server, request{
		method: http.MethodPost, path: "/v1/passkeys/register/finish",
		body:   `{"name":"我的 MacBook","credential":{"id":"abc","type":"public-key"}}`,
		cookie: sid, csrf: csrf,
	})
	require.Equal(t, http.StatusOK, resp.StatusCode)

	_, data := decode[struct {
		Passkey struct {
			ID         int64  `json:"id"`
			Name       string `json:"name"`
			CreatedAt  int64  `json:"created_at"`
			LastUsedAt int64  `json:"last_used_at"`
		} `json:"passkey"`
	}](t, resp)
	assert.Equal(t, int64(11), data.Passkey.ID)
	assert.Equal(t, "我的 MacBook", data.Passkey.Name)

	require.Len(t, stub.finished, 1)
	assert.Equal(t, int64(73), stub.finished[0].UserID)
	assert.Equal(t, sid, stub.finished[0].SessionID)
	assert.Equal(t, "我的 MacBook", stub.finished[0].Name)
	assert.JSONEq(t, `{"id":"abc","type":"public-key"}`, string(stub.finished[0].Response))
}

// 清单给出名字、创建时间、最后使用时间；空账号是 []，不是 null。
func TestListPasskeys_ReturnsNameCreatedAndLastUsed(t *testing.T) {
	stub := newStubPasskeySvc()
	stub.items[74] = []passkey_svc.Passkey{
		{ID: 2, Name: "手机", CreatedAt: 2000, LastUsedAt: 3000},
		{ID: 1, Name: "安全钥匙", CreatedAt: 1000, LastUsedAt: 0},
	}
	server := newServer(t, stub, generousLimits())
	sid, _ := newSessionCookie(t, 74)

	resp := do(t, server, request{method: http.MethodGet, path: "/v1/passkeys", cookie: sid})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	_, data := decode[struct {
		Passkeys []struct {
			ID         int64  `json:"id"`
			Name       string `json:"name"`
			CreatedAt  int64  `json:"created_at"`
			LastUsedAt int64  `json:"last_used_at"`
		} `json:"passkeys"`
	}](t, resp)
	require.Len(t, data.Passkeys, 2)
	assert.Equal(t, "手机", data.Passkeys[0].Name)
	assert.Equal(t, int64(2000), data.Passkeys[0].CreatedAt)
	assert.Equal(t, int64(3000), data.Passkeys[0].LastUsedAt)
	assert.Equal(t, int64(0), data.Passkeys[1].LastUsedAt)

	empty, _ := newSessionCookie(t, 75)
	resp = do(t, server, request{method: http.MethodGet, path: "/v1/passkeys", cookie: empty})
	_, emptyData := decode[struct {
		Passkeys []struct{} `json:"passkeys"`
	}](t, resp)
	assert.NotNil(t, emptyData.Passkeys)
}

// 逐把删除，允许删到零把（GitHub 登录始终是回退路径）；删不着的给 404 + 明确的码。
func TestDeletePasskey_RemovesOneAndAllowsEmptying(t *testing.T) {
	stub := newStubPasskeySvc()
	stub.items[76] = []passkey_svc.Passkey{{ID: 11, Name: "唯一一把"}}
	server := newServer(t, stub, generousLimits())
	sid, csrf := newSessionCookie(t, 76)

	resp := do(t, server, request{
		method: http.MethodDelete, path: "/v1/passkeys/11", cookie: sid, csrf: csrf,
	})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, []int64{11}, stub.deleted)
	assert.Empty(t, stub.items[76])

	resp = do(t, server, request{
		method: http.MethodDelete, path: "/v1/passkeys/11", cookie: sid, csrf: csrf,
	})
	require.Equal(t, http.StatusNotFound, resp.StatusCode)
	businessCode, _ := decode[any](t, resp)
	assert.Equal(t, code.PasskeyNotFound, businessCode)
}

// begin 按 IP 限流，与设备流 / OAuth 各用各的计数前缀，超限 429 并带 Retry-After。
func TestBeginRegistration_RateLimitedPerIP(t *testing.T) {
	stub := newStubPasskeySvc()
	server := newServer(t, stub, bootstrap.RLConfig{
		PasskeyRegisterBeginPerIPPerMin: 1, PasskeyRegisterBeginPerAccountPerMin: 1000,
	})
	sid, csrf := newSessionCookie(t, 77)
	const clientIP = "192.0.2.77"

	r := request{method: http.MethodPost, path: "/v1/passkeys/register/begin",
		cookie: sid, csrf: csrf, ip: clientIP}
	require.Equal(t, http.StatusOK, do(t, server, r).StatusCode)

	resp := do(t, server, r)
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.NotEmpty(t, resp.Header.Get("Retry-After"))
}

// begin 另外按账号限流：换 IP 也挡得住，否则一个账号可以从任意多个出口无限次开注册。
func TestBeginRegistration_RateLimitedPerAccount(t *testing.T) {
	stub := newStubPasskeySvc()
	server := newServer(t, stub, bootstrap.RLConfig{
		PasskeyRegisterBeginPerIPPerMin: 1000, PasskeyRegisterBeginPerAccountPerMin: 1,
	})
	sid, csrf := newSessionCookie(t, 78)

	require.Equal(t, http.StatusOK, do(t, server, request{
		method: http.MethodPost, path: "/v1/passkeys/register/begin",
		cookie: sid, csrf: csrf, ip: "192.0.2.101",
	}).StatusCode)

	resp := do(t, server, request{
		method: http.MethodPost, path: "/v1/passkeys/register/begin",
		cookie: sid, csrf: csrf, ip: "192.0.2.102",
	})
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.NotEmpty(t, resp.Header.Get("Retry-After"))
}

// ---- 登录 ----

// 两个登录端点是公开的：此刻还没有会话，也不要求任何标识（决策 10）。
// 裸请求就该拿到 200，而不是 401/403——挂错分组的话，通行密钥登录永远走不通。
func TestPasskeyLoginEndpoints_ArePublic(t *testing.T) {
	stub := newStubPasskeySvc()
	server := newServer(t, stub, generousLimits())

	resp := do(t, server, request{method: http.MethodPost, path: "/v1/passkeys/login/begin"})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	_, data := decode[struct {
		PublicKey json.RawMessage `json:"publicKey"`
	}](t, resp)
	assert.JSONEq(t, string(stub.options), string(data.PublicKey))

	resp = do(t, server, request{method: http.MethodPost, path: "/v1/passkeys/login/finish",
		body: `{"credential":{"id":"abc","type":"public-key"}}`})
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

// finish 通过后当场建立会话并下发 cookie，会话属于**服务端反查出来的那个账号**
// （请求体里没有任何身份字段）；UA 与 IP 与 GitHub 登录一样记下来，否则这次登录
// 在 /account 的会话清单里是一条无从辨认的空行。
func TestFinishLogin_EstablishesASessionForTheLookedUpAccount(t *testing.T) {
	stub := newStubPasskeySvc()
	stub.loginUserID = 88
	server := newServer(t, stub, generousLimits())

	resp := do(t, server, request{
		method: http.MethodPost, path: "/v1/passkeys/login/finish",
		body: `{"credential":{"id":"abc","type":"public-key"}}`,
		ip:   "192.0.2.88", ua: "Mozilla/5.0 (Macintosh)",
	})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.JSONEq(t, `{"id":"abc","type":"public-key"}`, string(stub.loginBodies[0]))

	var sid string
	for _, ck := range resp.Cookies() {
		if ck.Name == testCookieName {
			sid = ck.Value
		}
	}
	require.NotEmpty(t, sid, "登录成功必须下发会话 cookie")
	sess, err := auth_svc.Default().GetSession(context.Background(), sid)
	require.NoError(t, err)
	require.NotNil(t, sess)
	assert.Equal(t, int64(88), sess.UserID)

	list, err := auth_svc.Default().ListSessions(context.Background(), 88)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, "Mozilla/5.0 (Macintosh)", list[0].UserAgent)
	assert.Equal(t, "192.0.2.88", list[0].IP)
}

// 通行密钥登录发出的会话票必须与 GitHub 回调那条路**完全同规格**。
//
// 两条登录路径各自抄一份 cookie 下发代码时，属性差一个就足以让同一个账号的两次
// 登录在别处表现不同：少了 HttpOnly 是一条 XSS 能读到的票，少了 Secure 是一张会
// 走明文的票，Max-Age 不同则是两种过期时刻。逐属性钉住，谁改动共用的那一处都会红。
func TestFinishLogin_SessionCookieCarriesTheSameAttributesAsGithubLogin(t *testing.T) {
	stub := newStubPasskeySvc()
	stub.loginUserID = 89
	server := newServer(t, stub, generousLimits())

	resp := do(t, server, request{
		method: http.MethodPost, path: "/v1/passkeys/login/finish",
		body: `{"credential":{"id":"abc","type":"public-key"}}`,
	})
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var ck *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == testCookieName {
			ck = c
		}
	}
	require.NotNil(t, ck, "登录成功必须下发会话 cookie")
	assert.Equal(t, "/", ck.Path)
	assert.Equal(t, 14*24*3600, ck.MaxAge)
	assert.True(t, ck.HttpOnly, "会话票必须 HttpOnly——否则一条 XSS 就能读走它")
	assert.True(t, ck.Secure, "insecure_cookies 未开启时必须 Secure")
	assert.Equal(t, http.SameSiteLaxMode, ck.SameSite)
}

// 登录失败时 service 给的那个码原样出去，也绝不下发 cookie：前端要靠码分辨
// 「这把密钥不认识」和「本次操作已过期」，压成一句「登录失败」就没得分了。
func TestFinishLogin_FailureKeepsItsOwnCodeAndSetsNoCookie(t *testing.T) {
	stub := newStubPasskeySvc()
	stub.loginErr = code.PasskeyCredentialUnknown
	server := newServer(t, stub, generousLimits())

	resp := do(t, server, request{method: http.MethodPost, path: "/v1/passkeys/login/finish",
		body: `{"credential":{"id":"abc","type":"public-key"}}`})
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
	businessCode, _ := decode[any](t, resp)
	assert.Equal(t, code.PasskeyCredentialUnknown, businessCode)
	assert.Empty(t, resp.Cookies())
}

// 登录 begin 也按 IP 限流，而且用自己的计数前缀：与注册 begin 共用一个计数器的话，
// 一次登录洪水会把注册一起锁死。
func TestBeginLogin_RateLimitedPerIPWithItsOwnCounter(t *testing.T) {
	stub := newStubPasskeySvc()
	server := newServer(t, stub, bootstrap.RLConfig{
		PasskeyLoginBeginPerIPPerMin:         1,
		PasskeyRegisterBeginPerIPPerMin:      1000,
		PasskeyRegisterBeginPerAccountPerMin: 1000,
	})
	const clientIP = "192.0.2.90"

	r := request{method: http.MethodPost, path: "/v1/passkeys/login/begin", ip: clientIP}
	require.Equal(t, http.StatusOK, do(t, server, r).StatusCode)

	resp := do(t, server, r)
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.NotEmpty(t, resp.Header.Get("Retry-After"))

	// 注册 begin 用的是另一个计数器：登录被限流不该把它一起带下去。
	sid, csrf := newSessionCookie(t, 90)
	assert.Equal(t, http.StatusOK, do(t, server, request{
		method: http.MethodPost, path: "/v1/passkeys/register/begin",
		cookie: sid, csrf: csrf, ip: clientIP,
	}).StatusCode)
}
