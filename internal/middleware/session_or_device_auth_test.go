package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/gin-gonic/gin"
	. "github.com/smartystreets/goconvey/convey"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/middleware"
	hubjwt "github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
)

func TestSessionOrDeviceAuth(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), "server_session", 14*24*3600)))
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	if err != nil {
		t.Fatal(err)
	}

	makeHandler := func() *gin.Engine {
		r := gin.New()
		r.GET("/me", middleware.SessionOrDeviceAuth(signer, jwtblacklist.New(redis.Default())), func(c *gin.Context) {
			uid, _ := c.Get("user_id")
			did, _ := c.Get("device_id")
			c.JSON(http.StatusOK, gin.H{"uid": uid, "did": did})
		})
		return r
	}

	Convey("SessionOrDeviceAuth", t, func() {
		Convey("device JWT in Authorization header → user+device populated", func() {
			tok, _, signErr := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "desktop"}, time.Hour)
			So(signErr, ShouldBeNil)
			req := httptest.NewRequest(http.MethodGet, "/me", nil)
			req.Header.Set("Authorization", "Bearer "+tok)
			w := httptest.NewRecorder()
			makeHandler().ServeHTTP(w, req)

			So(w.Code, ShouldEqual, http.StatusOK)
			So(w.Body.String(), ShouldContainSubstring, `"uid":7`)
			So(w.Body.String(), ShouldContainSubstring, `"did":42`)
		})

		Convey("no auth → 401", func() {
			req := httptest.NewRequest(http.MethodGet, "/me", nil)
			w := httptest.NewRecorder()
			makeHandler().ServeHTTP(w, req)
			So(w.Code, ShouldEqual, http.StatusUnauthorized)
		})

		Convey("malformed Bearer token → 401", func() {
			req := httptest.NewRequest(http.MethodGet, "/me", nil)
			req.Header.Set("Authorization", "Bearer garbage")
			w := httptest.NewRecorder()
			makeHandler().ServeHTTP(w, req)
			So(w.Code, ShouldEqual, http.StatusUnauthorized)
		})
	})
}
