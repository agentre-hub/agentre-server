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

	"agentre-server/internal/middleware"
	"agentre-server/internal/pkg/code"
	hubjwt "agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/pkg/jwtblacklist"
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
	})
}
