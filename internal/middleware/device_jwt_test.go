package middleware_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/gin-gonic/gin"
	. "github.com/smartystreets/goconvey/convey"

	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	hubjwt "github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
)

func TestDeviceJWT_Blacklist(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	if err != nil {
		t.Fatal(err)
	}

	makeHandler := func() *gin.Engine {
		r := gin.New()
		r.GET("/protected", middleware.DeviceJWT(signer), func(c *gin.Context) {
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
			So(jwtblacklist.Add(t.Context(), jti, 3600), ShouldBeNil)

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
	testutils.Redis()
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
				if addErr := jwtblacklist.Add(t.Context(), jti, 60); addErr != nil {
					t.Fatal(addErr)
				}
			}

			router := gin.New()
			router.GET("/relay", middleware.RelayClientJWT(signer), func(c *gin.Context) {
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
