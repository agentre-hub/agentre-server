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
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	hubjwt "github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/relayticket"
)

func TestDeviceJWT_Blacklist(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	if err != nil {
		t.Fatal(err)
	}

	makeHandler := func() *gin.Engine {
		r := gin.New()
		r.GET("/protected", middleware.DeviceJWT(signer, jwtblacklist.New(redis.Default())), func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"ok": true})
		})
		return r
	}
	Convey("DeviceJWT", t, func() {
		Convey("valid token passes", func() {
			tok, _, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "agentred"}, time.Hour)
			So(err, ShouldBeNil)
			req := httptest.NewRequest(http.MethodGet, "/protected", nil)
			req.Header.Set("Authorization", "Bearer "+tok)
			w := httptest.NewRecorder()
			makeHandler().ServeHTTP(w, req)
			So(w.Code, ShouldEqual, http.StatusOK)
		})

		Convey("blacklisted jti is rejected with JWTBlacklisted", func() {
			tok, jti, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "agentred"}, time.Hour)
			So(err, ShouldBeNil)
			So(jwtblacklist.New(redis.Default()).Add(t.Context(), jti, 3600), ShouldBeNil)

			req := httptest.NewRequest(http.MethodGet, "/protected", nil)
			req.Header.Set("Authorization", "Bearer "+tok)
			w := httptest.NewRecorder()
			makeHandler().ServeHTTP(w, req)
			So(w.Code, ShouldEqual, http.StatusUnauthorized)
			So(w.Body.String(), ShouldContainSubstring, fmt.Sprintf(`"code":%d`, code.JWTBlacklisted))
		})

		Convey("relay ticket cannot enter ordinary device endpoints", func() {
			tok, _, err := signer.Sign(hubjwt.Claims{UID: 7, Kind: "relay_client"}, time.Minute)
			So(err, ShouldBeNil)
			req := httptest.NewRequest(http.MethodGet, "/protected", nil)
			req.Header.Set("Authorization", "Bearer "+tok)
			w := httptest.NewRecorder()
			makeHandler().ServeHTTP(w, req)
			So(w.Code, ShouldEqual, http.StatusUnauthorized)
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

	tests := []struct {
		name       string
		claims     hubjwt.Claims
		blacklist  bool
		wantStatus int
	}{
		{name: "browser relay ticket", claims: hubjwt.Claims{UID: 7, Kind: "relay_client"}, wantStatus: http.StatusOK},
		{name: "desktop device JWT", claims: hubjwt.Claims{UID: 7, DID: 41, Kind: "desktop"}, wantStatus: http.StatusOK},
		{name: "agentred device JWT", claims: hubjwt.Claims{UID: 7, DID: 42, Kind: "agentred"}, wantStatus: http.StatusOK},
		{name: "relay ticket cannot impersonate a device", claims: hubjwt.Claims{UID: 7, DID: 42, Kind: "relay_client"}, wantStatus: http.StatusUnauthorized},
		{name: "device kind requires a device id", claims: hubjwt.Claims{UID: 7, Kind: "desktop"}, wantStatus: http.StatusUnauthorized},
		{name: "blacklisted device JWT", claims: hubjwt.Claims{UID: 7, DID: 42, Kind: "agentred"}, blacklist: true, wantStatus: http.StatusUnauthorized},
		{name: "blacklisted relay ticket", claims: hubjwt.Claims{UID: 7, Kind: "relay_client"}, blacklist: true, wantStatus: http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			token, jti, signErr := signer.Sign(tt.claims, time.Minute)
			if signErr != nil {
				t.Fatal(signErr)
			}
			if tt.blacklist {
				if addErr := jwtblacklist.New(redis.Default()).Add(t.Context(), jti, 60); addErr != nil {
					t.Fatal(addErr)
				}
			}

			router := gin.New()
			router.GET("/relay", middleware.RelayClientJWT(signer, jwtblacklist.New(redis.Default()), relayticket.New(redis.Default())), func(c *gin.Context) {
				if got := c.GetInt64("user_id"); got != tt.claims.UID {
					t.Errorf("user_id = %d, want %d", got, tt.claims.UID)
				}
				if got := c.GetInt64("device_id"); got != tt.claims.DID {
					t.Errorf("device_id = %d, want %d", got, tt.claims.DID)
				}
				if got := c.GetString("device_kind"); got != tt.claims.Kind {
					t.Errorf("device_kind = %q, want %q", got, tt.claims.Kind)
				}
				c.Status(http.StatusOK)
			})
			req := httptest.NewRequest(http.MethodGet, "/relay", nil)
			req.Header.Set("Authorization", "Bearer "+token)
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

浏览器原生 WebSocket 设不了请求头，票只能走 query（relayUrl.ts → queryTokenBridge），
于是它会落进 ingress access log、反代日志、浏览器 history 与 Referer。TTL 短、登出
时按 sid 批量拉黑都已经有了，但那些都拦不住「泄漏之后、有效期之内」这一段。

用后即焚把那一段压到零：一张票只换得到一条连接，日志里那份是废票。浏览器每建一条
连接本来就现取一张（relayClientPool 与 accountChannel 都是每次现取），所以这条限制
不改变任何正常用法。

原生端的设备 JWT 不在此列：它是长期凭据，本来就要反复使用。
*/
func TestRelayClientJWT_BrowserTicketIsSingleUse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	if err != nil {
		t.Fatal(err)
	}
	handler := gin.New()
	handler.GET("/relay", middleware.RelayClientJWT(signer, jwtblacklist.New(redis.Default()), relayticket.New(redis.Default())), func(c *gin.Context) {
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

		Convey("a native device JWT stays reusable", func() {
			tok, _, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "agentred"}, time.Hour)
			So(err, ShouldBeNil)
			So(call(tok), ShouldEqual, http.StatusOK)
			So(call(tok), ShouldEqual, http.StatusOK)
		})
	})
}
