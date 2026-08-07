package web

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/smartystreets/goconvey/convey"
)

// TestNoRouteHandler_AssetsReturn404 是本项修复的决定性用例：滚动更新期间，
// 浏览器拿着新副本的 index.html 向旧副本要新 hash 的 /assets/*，旧副本没有
// 这个文件时必须回 404；回落 index.html 会返回 200 + text/html，浏览器把
// HTML 当 JS 解析报错，而 200 既不触发重试也不会被监控计成失败。
func TestNoRouteHandler_AssetsReturn404(t *testing.T) {
	gin.SetMode(gin.TestMode)

	convey.Convey("/assets/ 下不存在的文件返回 404", t, func() {
		handler, err := newNoRouteHandler()
		convey.So(err, convey.ShouldBeNil)

		engine := gin.New()
		engine.NoRoute(handler)

		req := httptest.NewRequest(http.MethodGet, "/assets/does-not-exist.js", nil)
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, req)

		convey.So(w.Code, convey.ShouldEqual, http.StatusNotFound)
		// body 是 gin 默认的空 404，而不是 index.html 的内容
		convey.So(w.Body.Len(), convey.ShouldBeLessThan, 100)
	})
}

// TestNoRouteHandler_SPAFallback 验证无扩展名的前端路由回落行为不变。
func TestNoRouteHandler_SPAFallback(t *testing.T) {
	gin.SetMode(gin.TestMode)

	convey.Convey("无扩展名的 SPA 路由仍回落 index.html", t, func() {
		handler, err := newNoRouteHandler()
		convey.So(err, convey.ShouldBeNil)

		engine := gin.New()
		engine.NoRoute(handler)

		req := httptest.NewRequest(http.MethodGet, "/device", nil)
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, req)

		convey.So(w.Code, convey.ShouldEqual, http.StatusOK)
		convey.So(w.Header().Get("Content-Type"), convey.ShouldContainSubstring, "text/html")
	})
}

// TestNoRouteHandler_V1Returns404 验证 /v1/ 未命中仍是 404，不被 SPA 回落吞掉。
func TestNoRouteHandler_V1Returns404(t *testing.T) {
	gin.SetMode(gin.TestMode)

	convey.Convey("/v1/ 未命中返回 404", t, func() {
		handler, err := newNoRouteHandler()
		convey.So(err, convey.ShouldBeNil)

		engine := gin.New()
		engine.NoRoute(handler)

		req := httptest.NewRequest(http.MethodGet, "/v1/nonexistent", nil)
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, req)

		convey.So(w.Code, convey.ShouldEqual, http.StatusNotFound)
	})
}

// TestNoRouteHandler_RootServesIndex 验证根路径仍然拿得到 index.html。
func TestNoRouteHandler_RootServesIndex(t *testing.T) {
	gin.SetMode(gin.TestMode)

	convey.Convey("根路径返回 index.html", t, func() {
		handler, err := newNoRouteHandler()
		convey.So(err, convey.ShouldBeNil)

		engine := gin.New()
		engine.NoRoute(handler)

		req := httptest.NewRequest(http.MethodGet, "/", nil)
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, req)

		convey.So(w.Code, convey.ShouldEqual, http.StatusOK)
		convey.So(w.Header().Get("Content-Type"), convey.ShouldContainSubstring, "text/html")
		convey.So(w.Body.Len(), convey.ShouldBeGreaterThan, 0)
	})
}
