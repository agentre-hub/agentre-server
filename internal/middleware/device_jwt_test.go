package middleware_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/gin-gonic/gin"
	. "github.com/smartystreets/goconvey/convey"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	hubjwt "github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/relayticket"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

func TestDeviceJWT(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	if err != nil {
		t.Fatal(err)
	}

	makeHandler := func() *gin.Engine {
		r := gin.New()
		r.GET("/protected", middleware.DeviceJWT(bearertest.Resolver{}), func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"ok": true})
		})
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
			tok, _, err := signer.Sign(hubjwt.Claims{UID: 7, Kind: "relay_client"}, time.Minute)
			So(err, ShouldBeNil)
			So(call("Bearer "+tok).Code, ShouldEqual, http.StatusUnauthorized)
		})
	})
}

func TestRelayClientJWTBoundary(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	if err != nil {
		t.Fatal(err)
	}
	ticket := func(claims hubjwt.Claims, blacklist bool) string {
		token, jti, signErr := signer.Sign(claims, time.Minute)
		if signErr != nil {
			t.Fatal(signErr)
		}
		if blacklist {
			if addErr := jwtblacklist.New(redis.Default()).Add(t.Context(), jti, 60); addErr != nil {
				t.Fatal(addErr)
			}
		}
		return token
	}

	tests := []struct {
		name       string
		token      string
		want       hubjwt.Claims
		wantStatus int
	}{
		{name: "browser relay ticket", token: ticket(hubjwt.Claims{UID: 7, Kind: "relay_client"}, false),
			want: hubjwt.Claims{UID: 7, Kind: "relay_client"}, wantStatus: http.StatusOK},
		{name: "desktop device access token",
			token: bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 41, Kind: "desktop"}),
			want:  hubjwt.Claims{UID: 7, DID: 41, Kind: "desktop"}, wantStatus: http.StatusOK},
		{name: "agentred device access token",
			token: bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 42, Kind: "agentred"}),
			want:  hubjwt.Claims{UID: 7, DID: 42, Kind: "agentred"}, wantStatus: http.StatusOK},
		{name: "relay ticket cannot impersonate a device",
			token: ticket(hubjwt.Claims{UID: 7, DID: 42, Kind: "relay_client"}, false), wantStatus: http.StatusUnauthorized},
		{name: "a signed legacy device JWT is no longer a device credential",
			token: ticket(hubjwt.Claims{UID: 7, DID: 42, Kind: "agentred"}, false), wantStatus: http.StatusUnauthorized},
		{name: "unknown device access token", token: "unknown-token", wantStatus: http.StatusUnauthorized},
		{name: "blacklisted relay ticket",
			token: ticket(hubjwt.Claims{UID: 7, Kind: "relay_client"}, true), wantStatus: http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			router := gin.New()
			router.GET("/relay", middleware.RelayClientJWT(bearertest.Resolver{}, signer,
				jwtblacklist.New(redis.Default()), relayticket.New(redis.Default())), func(c *gin.Context) {
				if got := c.GetInt64("user_id"); got != tt.want.UID {
					t.Errorf("user_id = %d, want %d", got, tt.want.UID)
				}
				if got := c.GetInt64("device_id"); got != tt.want.DID {
					t.Errorf("device_id = %d, want %d", got, tt.want.DID)
				}
				if got := c.GetString("device_kind"); got != tt.want.Kind {
					t.Errorf("device_kind = %q, want %q", got, tt.want.Kind)
				}
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
浏览器票据是**一次性**的。

浏览器原生 WebSocket 设不了请求头，票只能走子协议（relayTokenBridge），于是它仍可能
落进反代日志与抓包。TTL 短、登出时按 sid 批量拉黑都已经有了，但那些都拦不住「泄漏之后、
有效期之内」这一段。

用后即焚把那一段压到零：一张票只换得到一条连接，日志里那份是废票。浏览器每建一条
连接本来就现取一张（relayClientPool 与 accountChannel 都是每次现取），所以这条限制
不改变任何正常用法。

原生端的设备 access token 不在此列：它是长期凭据，本来就要反复使用。
*/
func TestRelayClientJWT_BrowserTicketIsSingleUse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	if err != nil {
		t.Fatal(err)
	}
	handler := gin.New()
	handler.GET("/relay", middleware.RelayClientJWT(bearertest.Resolver{}, signer,
		jwtblacklist.New(redis.Default()), relayticket.New(redis.Default())), func(c *gin.Context) {
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
		Convey("browser ticket works once and only once", func() {
			tok, _, err := signer.Sign(hubjwt.Claims{UID: 7, Kind: "relay_client"}, time.Hour)
			So(err, ShouldBeNil)
			So(call(tok), ShouldEqual, http.StatusOK)
			So(call(tok), ShouldEqual, http.StatusUnauthorized)
		})

		Convey("two different tickets are independent", func() {
			first, _, err := signer.Sign(hubjwt.Claims{UID: 7, Kind: "relay_client"}, time.Hour)
			So(err, ShouldBeNil)
			second, _, err := signer.Sign(hubjwt.Claims{UID: 7, Kind: "relay_client"}, time.Hour)
			So(err, ShouldBeNil)
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
