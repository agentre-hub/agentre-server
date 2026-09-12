package middleware_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/gin-gonic/gin"
	. "github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// shortLivedCredentials 装起生产那一份短效凭据：auth_svc 与凭据存储都落在本用例的 miniredis 上。
func shortLivedCredentials(t *testing.T) auth_svc.AuthSvc {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	auth := auth_svc.New(redis.Default(), session.New(redis.Default(), "server_session", 14*24*3600))
	auth_svc.SetDefault(auth)
	return auth
}

// relayClientGuard 是 /v1/relay/client 上的那道入口，装配与 router.go 相同：设备令牌由
// bearertest 解析，短效凭据由真实的 auth_svc 与凭据存储解析与认领。
func relayClientGuard(auth auth_svc.AuthSvc) gin.HandlerFunc {
	return middleware.RelayClientJWT(auth_svc.NewCredentialResolver(bearertest.Resolver{}, auth),
		credstore.New(redis.Default()))
}

// issueTicket 用一次真实登录会话换一张浏览器中继票据，交回票据与会话。
func issueTicket(t *testing.T, auth auth_svc.AuthSvc, userID int64) (string, string) {
	t.Helper()
	sid, _, err := auth.StartSession(context.Background(), userID)
	require.NoError(t, err)
	ticket, err := auth.IssueRelayTicket(context.Background(), sid, userID)
	require.NoError(t, err)
	return ticket.Token, sid
}

func TestDeviceJWT(t *testing.T) {
	auth := shortLivedCredentials(t)

	makeHandler := func() *gin.Engine {
		r := gin.New()
		// 即便装的是全部凭据的组合解析方，设备入口也只认属于某台设备的身份。
		r.GET("/protected", middleware.DeviceJWT(auth_svc.NewCredentialResolver(bearertest.Resolver{}, auth)),
			func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
		return r
	}
	call := func(authorization string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/protected", nil)
		if authorization != "" {
			req.Header.Set("Authorization", authorization)
		}
		w := httptest.NewRecorder()
		makeHandler().ServeHTTP(w, req)
		return w
	}
	Convey("DeviceJWT", t, func() {
		Convey("valid device access token passes", func() {
			tok := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 42, Kind: "agentred"})
			So(call("Bearer "+tok).Code, ShouldEqual, http.StatusOK)
		})

		Convey("unknown, expired or revoked token is rejected with Unauthorized", func() {
			w := call("Bearer unknown-token")
			So(w.Code, ShouldEqual, http.StatusUnauthorized)
			So(w.Body.String(), ShouldContainSubstring, fmt.Sprintf(`"code":%d`, code.Unauthorized))
		})

		Convey("missing Authorization is rejected", func() {
			So(call("").Code, ShouldEqual, http.StatusUnauthorized)
		})

		Convey("relay ticket cannot enter ordinary device endpoints", func() {
			ticket, _ := issueTicket(t, auth, 7)
			So(call("Bearer "+ticket).Code, ShouldEqual, http.StatusUnauthorized)
		})

		Convey("server credential cannot enter ordinary device endpoints", func() {
			tok, err := credstore.New(redis.Default()).IssueServerMirror(context.Background(), 7, "server-mirror:a")
			So(err, ShouldBeNil)
			So(call("Bearer "+tok).Code, ShouldEqual, http.StatusUnauthorized)
		})
	})
}

func TestRelayClientJWTBoundary(t *testing.T) {
	auth := shortLivedCredentials(t)
	ticket, _ := issueTicket(t, auth, 7)
	endedTicket, endedSID := issueTicket(t, auth, 7)
	require.NoError(t, auth.EndSession(context.Background(), endedSID))
	serverCredential, err := credstore.New(redis.Default()).IssueServerMirror(context.Background(), 7, "server-mirror:a")
	require.NoError(t, err)

	type identity struct {
		UID  int64
		DID  int64
		Kind string
	}
	tests := []struct {
		name       string
		token      string
		want       identity
		wantStatus int
	}{
		{name: "browser relay ticket", token: ticket,
			want: identity{UID: 7, Kind: credstore.KindRelayClient}, wantStatus: http.StatusOK},
		{name: "desktop device access token",
			token: bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 41, Kind: "desktop", Handle: "41"}),
			want:  identity{UID: 7, DID: 41, Kind: "desktop"}, wantStatus: http.StatusOK},
		{name: "agentred device access token",
			token: bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 42, Kind: "agentred", Handle: "42"}),
			want:  identity{UID: 7, DID: 42, Kind: "agentred"}, wantStatus: http.StatusOK},
		{name: "server credential cannot pose as a browser ticket", token: serverCredential,
			wantStatus: http.StatusUnauthorized},
		{name: "ticket of an ended session", token: endedTicket, wantStatus: http.StatusUnauthorized},
		{name: "unknown token", token: "unknown-token", wantStatus: http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			router := gin.New()
			router.GET("/relay", relayClientGuard(auth), func(c *gin.Context) {
				assert.Equal(t, tt.want, identity{
					UID: ginctx.UserID(c), DID: ginctx.DeviceID(c), Kind: ginctx.DeviceKind(c),
				})
				assert.NotEmpty(t, ginctx.CredentialHandle(c), "长连接要靠句柄复查自己背后的凭据")
				c.Status(http.StatusOK)
			})
			req := httptest.NewRequest(http.MethodGet, "/relay", nil)
			req.Header.Set("Authorization", "Bearer "+tt.token)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", w.Code, tt.wantStatus, w.Body.String())
			}
		})
	}
}

/*
浏览器票据连接中继是**一次性**的。

浏览器原生 WebSocket 设不了请求头，票只能走子协议（relayTokenBridge），于是它仍可能
落进反代日志与抓包。TTL 短、登出即失效都已经有了，但那些都拦不住「泄漏之后、有效期之内」
这一段。

一次性连接把那一段压到零：一张票只换得到一条连接，日志里那份是废票。浏览器每建一条
连接本来就现取一张（relayClientPool 与 accountChannel 都是每次现取），所以这条限制
不改变任何正常用法。它只管「连中继」：有效期内这张票照样可以被对端反复拿去核验。

原生端的设备 access token 不在此列：它是长期凭据，本来就要反复使用。
*/
func TestRelayClientJWT_BrowserTicketIsSingleUse(t *testing.T) {
	auth := shortLivedCredentials(t)
	handler := gin.New()
	handler.GET("/relay", relayClientGuard(auth), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	call := func(token string) int {
		req := httptest.NewRequest(http.MethodGet, "/relay", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w.Code
	}

	Convey("RelayClientJWT", t, func() {
		Convey("browser ticket connects once and only once, yet stays resolvable", func() {
			tok, _ := issueTicket(t, auth, 7)
			So(call(tok), ShouldEqual, http.StatusOK)
			So(call(tok), ShouldEqual, http.StatusUnauthorized)
			for range 2 {
				p, err := auth.ResolveCredential(context.Background(), tok)
				So(err, ShouldBeNil)
				So(p.AccountID, ShouldEqual, 7)
			}
		})

		Convey("two different tickets are independent", func() {
			first, _ := issueTicket(t, auth, 7)
			second, _ := issueTicket(t, auth, 7)
			So(call(first), ShouldEqual, http.StatusOK)
			So(call(second), ShouldEqual, http.StatusOK)
		})

		Convey("a native device access token stays reusable", func() {
			tok := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 42, Kind: "agentred"})
			So(call(tok), ShouldEqual, http.StatusOK)
			So(call(tok), ShouldEqual, http.StatusOK)
		})
	})
}

// Redis 不可用时票据既解析不了也认领不了，一律拒绝（fail-closed），不放行也不答 500。
func TestRelayClientJWT_TicketFailsClosedWhenRedisIsUnavailable(t *testing.T) {
	mini := testutils.Redis(t)
	auth := auth_svc.New(redis.Default(), session.New(redis.Default(), "server_session", 86400))
	auth_svc.SetDefault(auth)
	ticket, _ := issueTicket(t, auth, 7)
	guard := relayClientGuard(auth)

	mini.Close()

	assert.Equal(t, http.StatusUnauthorized, serveBearer(guard, ticket).Code)
}
