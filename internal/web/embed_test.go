package web_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	. "github.com/smartystreets/goconvey/convey"

	"agentre-server/internal/web"
)

// TestNoRouteHandler_AssetsReturn404 tests that missing /assets/* paths return 404.
// This is critical during rolling updates: when browsers request hashed assets
// from old replicas, they should get 404 (not 200 + HTML), so they retry.
func TestNoRouteHandler_AssetsReturn404(t *testing.T) {
	gin.SetMode(gin.TestMode)

	Convey("missing /assets/* returns 404", t, func() {
		handler, err := web.GetNoRouteHandler()
		So(err, ShouldBeNil)

		engine := gin.New()
		engine.NoRoute(handler)

		req := httptest.NewRequest(http.MethodGet, "/assets/does-not-exist.js", nil)
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, req)

		// Must return 404, not 200 + text/html
		// This ensures browsers detect the real failure and retry
		So(w.Code, ShouldEqual, http.StatusNotFound)
		// Body should be empty (gin default 404), not HTML content
		So(w.Body.Len(), ShouldBeLessThan, 100)
	})
}

// TestNoRouteHandler_SPAFallback tests that extension-less routes still fall back to index.html.
func TestNoRouteHandler_SPAFallback(t *testing.T) {
	gin.SetMode(gin.TestMode)

	Convey("extension-less SPA routes fall back to index.html", t, func() {
		handler, err := web.GetNoRouteHandler()
		So(err, ShouldBeNil)

		engine := gin.New()
		engine.NoRoute(handler)

		req := httptest.NewRequest(http.MethodGet, "/device", nil)
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, req)

		So(w.Code, ShouldEqual, http.StatusOK)
		So(w.Header().Get("Content-Type"), ShouldContainSubstring, "text/html")
	})
}

// TestNoRouteHandler_V1Returns404 tests that /v1/* misses still return 404.
func TestNoRouteHandler_V1Returns404(t *testing.T) {
	gin.SetMode(gin.TestMode)

	Convey("/v1/ misses return 404", t, func() {
		handler, err := web.GetNoRouteHandler()
		So(err, ShouldBeNil)

		engine := gin.New()
		engine.NoRoute(handler)

		req := httptest.NewRequest(http.MethodGet, "/v1/nonexistent", nil)
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, req)

		So(w.Code, ShouldEqual, http.StatusNotFound)
	})
}

// TestNoRouteHandler_RealFilesServed tests that real embedded files are served.
func TestNoRouteHandler_RealFilesServed(t *testing.T) {
	gin.SetMode(gin.TestMode)

	Convey("real embedded files are served", t, func() {
		handler, err := web.GetNoRouteHandler()
		So(err, ShouldBeNil)

		engine := gin.New()
		engine.NoRoute(handler)

		// Request the root path which http.FileServer will serve as index.html
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, req)

		// Should serve the file (200 or 301 redirect is both acceptable)
		So(w.Code, ShouldBeIn, http.StatusOK, http.StatusMovedPermanently)
		// If it's HTML content, verify the content type
		if w.Code == http.StatusOK {
			So(w.Header().Get("Content-Type"), ShouldContainSubstring, "text/html")
			So(w.Body.Len(), ShouldBeGreaterThan, 0)
		}
	})
}
