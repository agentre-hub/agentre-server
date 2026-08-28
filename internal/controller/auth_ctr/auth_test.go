package auth_ctr_test

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
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_identity_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/repository/user_identity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_identity_repo/mock_user_identity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
)

const testCookieName = "server_session"

func newAuthTestServer(t *testing.T) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{Cfg: &bootstrap.ServerConfig{}, Signer: signer}).
		Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server, signer
}

// startSession 模拟一次浏览器登录，返回该 session 的 cookie 与配套 CSRF token。
func startSession(t *testing.T, userID int64) (string, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return sid, sess.CSRFToken
}

func postJSON(t *testing.T, url, sid, csrf string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(`{}`))
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: testCookieName, Value: sid})
	req.Header.Set("X-CSRF-Token", csrf)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func issueRelayTicket(t *testing.T, server *httptest.Server, sid, csrf string) string {
	t.Helper()
	resp := postJSON(t, server.URL+"/v1/relay/ticket", sid, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Data struct {
			AccessToken string `json:"access_token"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.NotEmpty(t, envelope.Data.AccessToken)
	return envelope.Data.AccessToken
}

// relayGuardStatus 把票据喂给真正守着 /v1/relay/client 的中间件，返回它的裁决。
// 这是「这张票还能不能读写全部 agentred 会话」的唯一判据。
func relayGuardStatus(t *testing.T, signer *jwt.Signer, token string) int {
	t.Helper()
	router := gin.New()
	router.GET("/relay", middleware.RelayClientJWT(signer), func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/relay", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w.Code
}

// 登出必须立刻掐死这次会话签发过的 relay ticket：票本身还有最长 2 分钟寿命，
// 期间它能连 /v1/relay/client 读写该账号下全部 agentred 的会话。
func TestLogoutRevokesRelayTicketsIssuedByThatSession(t *testing.T) {
	server, signer := newAuthTestServer(t)
	sid, csrf := startSession(t, 7)
	ticket := issueRelayTicket(t, server, sid, csrf)
	require.Equal(t, http.StatusOK, relayGuardStatus(t, signer, ticket), "登出前这张票本来就该可用")

	resp := postJSON(t, server.URL+"/v1/auth/logout", sid, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Equal(t, http.StatusUnauthorized, relayGuardStatus(t, signer, ticket),
		"登出后仍在有效期内的 relay ticket 必须立即失效")
}

// 登出只作废这一次会话签发的票：同账号的另一个浏览器不受影响。
func TestLogoutKeepsRelayTicketsOfOtherSessions(t *testing.T) {
	server, signer := newAuthTestServer(t)
	sidA, csrfA := startSession(t, 7)
	sidB, csrfB := startSession(t, 7)
	ticketA := issueRelayTicket(t, server, sidA, csrfA)
	ticketB := issueRelayTicket(t, server, sidB, csrfB)

	resp := postJSON(t, server.URL+"/v1/auth/logout", sidA, csrfA)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Equal(t, http.StatusUnauthorized, relayGuardStatus(t, signer, ticketA))
	require.Equal(t, http.StatusOK, relayGuardStatus(t, signer, ticketB),
		"另一个浏览器的会话没有登出，它的票不该被牵连")
}

// startSessionWithClient 模拟一次带 UA / IP 的浏览器登录（真实登录经由
// GithubCallback 从请求头取这两样）。
func startSessionWithClient(t *testing.T, userID int64, client session.Client) (string, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID, client)
	require.NoError(t, err)
	return sid, sess.CSRFToken
}

type sessionItem struct {
	UserAgent    string `json:"user_agent"`
	IP           string `json:"ip"`
	CreatedAt    int64  `json:"created_at"`
	LastActiveAt int64  `json:"last_active_at"`
	Current      bool   `json:"current"`
}

func listSessions(t *testing.T, server *httptest.Server, sid string) (*http.Response, []sessionItem, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/auth/sessions", nil)
	require.NoError(t, err)
	if sid != "" {
		req.AddCookie(&http.Cookie{Name: testCookieName, Value: sid})
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var envelope struct {
		Data struct {
			Sessions []sessionItem `json:"sessions"`
		} `json:"data"`
	}
	if resp.StatusCode == http.StatusOK {
		require.NoError(t, json.Unmarshal(body, &envelope), string(body))
	}
	return resp, envelope.Data.Sessions, string(body)
}

// 清单要把这个账号的每一次登录都列出来，并明确标出「你现在用的是哪一条」——
// 没有这个标记，用户没法安全地决定撤销谁。
func TestListSessions_ListsEveryLoginAndMarksTheCurrentOne(t *testing.T) {
	server, _ := newAuthTestServer(t)
	// 本包共用一个 miniredis，别的用例也在给 7 号建会话：各用例用自己的账号，
	// 免得清单里混进别人的登录。
	const uid = 7101
	const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0"
	sid, _ := startSessionWithClient(t, uid, session.Client{UserAgent: ua, IP: "203.0.113.9"})
	other, _ := startSessionWithClient(t, uid, session.Client{UserAgent: "curl/8.4.0", IP: "198.51.100.7"})

	resp, items, body := listSessions(t, server, sid)
	require.Equal(t, http.StatusOK, resp.StatusCode, body)
	require.Len(t, items, 2)

	byUA := map[string]sessionItem{}
	for _, item := range items {
		byUA[item.UserAgent] = item
	}
	require.Contains(t, byUA, ua)
	require.Contains(t, byUA, "curl/8.4.0")
	assert.True(t, byUA[ua].Current, "带着这条 cookie 发的请求，它就是当前会话")
	assert.False(t, byUA["curl/8.4.0"].Current)
	assert.Equal(t, "203.0.113.9", byUA[ua].IP)
	assert.Positive(t, byUA[ua].CreatedAt)
	assert.Positive(t, byUA[ua].LastActiveAt)

	// sid 就是 cookie 里那枚凭据，清单不能把它交出去：一条 XSS 就能读走全部会话。
	assert.NotContains(t, body, sid)
	assert.NotContains(t, body, other)
}

func TestListSessions_RequiresALogin(t *testing.T) {
	server, _ := newAuthTestServer(t)
	resp, _, _ := listSessions(t, server, "")
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// 「登出其它全部」结束其余会话、留下当前这一条，并如实报告撤销了几条。
func TestRevokeOtherSessions_EndsTheOthersAndKeepsTheCurrentOne(t *testing.T) {
	server, _ := newAuthTestServer(t)
	const uid = 7102 // 同上：本用例独占一个账号
	sid, csrf := startSessionWithClient(t, uid, session.Client{UserAgent: "chrome", IP: "203.0.113.9"})
	other, _ := startSessionWithClient(t, uid, session.Client{UserAgent: "curl/8.4.0", IP: "198.51.100.7"})

	// 写操作，没有 CSRF token 就该被挡在门外。
	noCSRF := postJSON(t, server.URL+"/v1/auth/sessions/revoke-others", sid, "")
	require.Equal(t, http.StatusForbidden, noCSRF.StatusCode)

	resp := postJSON(t, server.URL+"/v1/auth/sessions/revoke-others", sid, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Data struct {
			Revoked int `json:"revoked"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	assert.Equal(t, 1, envelope.Data.Revoked)

	after, items, body := listSessions(t, server, sid)
	require.Equal(t, http.StatusOK, after.StatusCode, body)
	require.Len(t, items, 1, "只该剩下当前这一条")
	assert.True(t, items[0].Current)

	dead, _, _ := listSessions(t, server, other)
	assert.Equal(t, http.StatusUnauthorized, dead.StatusCode, "被登出的浏览器不该再认得出身份")
}

// 向 Me 返回的数据里编入 github_login：从 user_identities.provider_login 读出来。
func TestMe_FillsGithubLogin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()

	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)

	// 模拟 user_repo 与 user_identity_repo：Me 会分别查用户行与账号关联的 GitHub 身份。
	userMock := mock_user_repo.NewMockUserRepo(ctrl)
	identityMock := mock_user_identity_repo.NewMockUserIdentityRepo(ctrl)

	uid := int64(7103)
	const githubLogin = "testuser"

	userMock.EXPECT().
		Find(gomock.Any(), uid).
		Return(&user_entity.User{
			ID:          uid,
			Email:       "test@example.com",
			DisplayName: "Test User",
			AvatarURL:   "https://example.com/avatar.jpg",
			Status:      1,
		}, nil)

	// 预期 Me 会按 user_id + provider 查询 user_identity，得到 provider_login。
	identityMock.EXPECT().
		FindByUserAndProvider(gomock.Any(), uid, user_identity_entity.ProviderGithub).
		Return(&user_identity_entity.UserIdentity{
			UserID:        uid,
			Provider:      user_identity_entity.ProviderGithub,
			ProviderLogin: githubLogin,
		}, nil)

	// 注册 mock 到 svc；用完摘掉——单例是包级的，留着会跨用例活下去，后面任何一个
	// 用例碰到这两个 repo 都会撞上一个已经 Finish 掉的 ctrl。
	user_repo.RegisterUser(userMock)
	user_identity_repo.RegisterUserIdentity(identityMock)
	t.Cleanup(func() {
		user_repo.RegisterUser(nil)
		user_identity_repo.RegisterUserIdentity(nil)
	})

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{Cfg: &bootstrap.ServerConfig{}, Signer: signer}).
		Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	// 建立会话。
	sid, _ := startSession(t, uid)

	// 调用 /v1/auth/me。
	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/auth/me", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: testCookieName, Value: sid})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Data struct {
			UserID      int64  `json:"user_id"`
			Email       string `json:"email"`
			DisplayName string `json:"display_name"`
			AvatarURL   string `json:"avatar_url"`
			GithubLogin string `json:"github_login"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	assert.Equal(t, uid, envelope.Data.UserID)
	// 这是 RED 测试：github_login 应该填充，但当前它是空的。
	assert.Equal(t, githubLogin, envelope.Data.GithubLogin, "github_login 应该从 user_identities.provider_login 读出来")
}

// 没有 GitHub 身份关联时，github_login 返回空字符串。
func TestMe_ReturnsEmptyGithubLoginWithoutGithubIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()

	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)

	userMock := mock_user_repo.NewMockUserRepo(ctrl)
	identityMock := mock_user_identity_repo.NewMockUserIdentityRepo(ctrl)

	uid := int64(7104)

	userMock.EXPECT().
		Find(gomock.Any(), uid).
		Return(&user_entity.User{
			ID:          uid,
			Email:       "test@example.com",
			DisplayName: "Test User",
			Status:      1,
		}, nil)

	// 没有 GitHub 身份。
	identityMock.EXPECT().
		FindByUserAndProvider(gomock.Any(), uid, user_identity_entity.ProviderGithub).
		Return(nil, nil)

	user_repo.RegisterUser(userMock)
	user_identity_repo.RegisterUserIdentity(identityMock)
	t.Cleanup(func() {
		user_repo.RegisterUser(nil)
		user_identity_repo.RegisterUserIdentity(nil)
	})

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{Cfg: &bootstrap.ServerConfig{}, Signer: signer}).
		Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	sid, _ := startSession(t, uid)

	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/auth/me", nil)
	require.NoError(t, err)
	req.AddCookie(&http.Cookie{Name: testCookieName, Value: sid})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Data struct {
			GithubLogin string `json:"github_login"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	assert.Equal(t, "", envelope.Data.GithubLogin)
}

// GithubAuthorize 端点按 IP 限流，超限返回 429 并带 Retry-After。
func TestGithubAuthorize_RateLimitByIP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	testMux := muxtest.NewTestMux()
	const limit = 1 // 只允许 1 次，这样第二次直接超限
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{GithubAuthorizePerIPPerMin: limit}},
		Signer: signer,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	const clientIP = "192.0.2.1"

	// 第一次请求通过（允许）。
	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/auth/oauth/github/authorize", nil)
	require.NoError(t, err)
	req.Header.Set("X-Forwarded-For", clientIP)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.NotEqual(t, http.StatusTooManyRequests, resp.StatusCode)

	// 第二次请求超过限额，返回 429。
	req, err = http.NewRequest(http.MethodGet, server.URL+"/v1/auth/oauth/github/authorize", nil)
	require.NoError(t, err)
	req.Header.Set("X-Forwarded-For", clientIP)
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.NotEmpty(t, resp.Header.Get("Retry-After"), "应该带 Retry-After 头")
}

// GithubCallback 端点按 IP 限流，超限返回 429 并带 Retry-After。
func TestGithubCallback_RateLimitByIP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	testMux := muxtest.NewTestMux()
	const limit = 1 // 只允许 1 次，这样第二次直接超限
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{GithubCallbackPerIPPerMin: limit}},
		Signer: signer,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	const clientIP = "192.0.2.2"

	// 第一次请求通过（允许）。
	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/auth/oauth/github/callback?code=test&state=test", nil)
	require.NoError(t, err)
	req.Header.Set("X-Forwarded-For", clientIP)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.NotEqual(t, http.StatusTooManyRequests, resp.StatusCode)

	// 第二次请求超过限额，返回 429。
	req, err = http.NewRequest(http.MethodGet, server.URL+"/v1/auth/oauth/github/callback?code=test&state=test", nil)
	require.NoError(t, err)
	req.Header.Set("X-Forwarded-For", clientIP)
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	assert.NotEmpty(t, resp.Header.Get("Retry-After"), "应该带 Retry-After 头")
}
