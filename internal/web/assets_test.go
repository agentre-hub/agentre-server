package web

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"
	"github.com/smartystreets/goconvey/convey"
)

// bundleJS 大到值得压:真实产物里 index-*.js 是 2.2MB。这里只要够触发压缩判断,
// 同时具备可压缩文本的特征。
var bundleJS = []byte(strings.Repeat("export const answer = 42;\n", 400))

func testDist() fstest.MapFS {
	return fstest.MapFS{
		"index.html":               &fstest.MapFile{Data: []byte("<!doctype html><title>t</title>")},
		"assets/index-abc123.js":   &fstest.MapFile{Data: bundleJS},
		"assets/index-abc123.css":  &fstest.MapFile{Data: []byte(strings.Repeat(".a{color:red}\n", 200))},
		"assets/font-abc123.woff2": &fstest.MapFile{Data: bytes.Repeat([]byte{0x77, 0x4f, 0x46, 0x32}, 200)},
	}
}

func serve(t *testing.T, path string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	handler, err := newNoRouteHandlerFS(testDist())
	convey.So(err, convey.ShouldBeNil)
	engine := gin.New()
	engine.NoRoute(handler)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range header {
		req.Header[k] = v
	}
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, req)
	return w
}

// TestAssets_HashedAssetsAreCachedImmutably
//
// /assets/ 下是 vite 带内容 hash 的产物,内容一变文件名就变 —— 它们可以、也应该被
// 永久缓存。此前一个缓存头都没有:embed.FS 的 ModTime 是零值,http.ServeContent
// 因此连 Last-Modified 都不发,Go 也不会自动生成 ETag。结果是**每次打开页面都把
// 整个 2.2MB 的 bundle 重新下一遍**。
func TestAssets_HashedAssetsAreCachedImmutably(t *testing.T) {
	convey.Convey("带 hash 的资源必须可永久缓存", t, func() {
		w := serve(t, "/assets/index-abc123.js", nil)
		convey.So(w.Code, convey.ShouldEqual, http.StatusOK)
		convey.So(w.Header().Get("Cache-Control"), convey.ShouldContainSubstring, "immutable")
		convey.So(w.Header().Get("Cache-Control"), convey.ShouldContainSubstring, "max-age=31536000")
	})
}

// TestAssets_IndexHTMLMustRevalidate
//
// index.html 是那张指向当前一组 hash 的名片,**绝不能**跟着一起被永久缓存 ——
// 否则滚动更新之后浏览器永远拿旧名片,新版本再也上不去。
func TestAssets_IndexHTMLMustRevalidate(t *testing.T) {
	convey.Convey("index.html 必须每次回源校验", t, func() {
		for _, path := range []string{"/", "/device"} {
			w := serve(t, path, nil)
			convey.So(w.Code, convey.ShouldEqual, http.StatusOK)
			cc := w.Header().Get("Cache-Control")
			convey.So(cc, convey.ShouldContainSubstring, "no-cache")
			convey.So(cc, convey.ShouldNotContainSubstring, "immutable")
		}
	})
}

// TestAssets_CompressibleAssetsAreGzipped 压缩是这里最大的一笔:2.2MB 的 JS
// gzip 之后是几百 KB 量级,而此前一个字节都没压过。
func TestAssets_CompressibleAssetsAreGzipped(t *testing.T) {
	convey.Convey("接受 gzip 的客户端拿到压缩过的 JS/CSS", t, func() {
		w := serve(t, "/assets/index-abc123.js", http.Header{"Accept-Encoding": []string{"gzip"}})
		convey.So(w.Code, convey.ShouldEqual, http.StatusOK)
		convey.So(w.Header().Get("Content-Encoding"), convey.ShouldEqual, "gzip")
		convey.So(w.Header().Get("Vary"), convey.ShouldContainSubstring, "Accept-Encoding")
		convey.So(w.Header().Get("Content-Type"), convey.ShouldContainSubstring, "javascript")
		convey.So(w.Body.Len(), convey.ShouldBeLessThan, len(bundleJS))

		zr, err := gzip.NewReader(bytes.NewReader(w.Body.Bytes()))
		convey.So(err, convey.ShouldBeNil)
		got, err := io.ReadAll(zr)
		convey.So(err, convey.ShouldBeNil)
		convey.So(bytes.Equal(got, bundleJS), convey.ShouldBeTrue)
	})
}

// TestAssets_ClientsWithoutGzipStillGetExactBytes 不接受 gzip 的客户端必须原样拿到
// 未压缩的字节 —— 压缩是可选的传输优化,不能改变资源本身。
func TestAssets_ClientsWithoutGzipStillGetExactBytes(t *testing.T) {
	convey.Convey("不接受 gzip 时原样返回", t, func() {
		w := serve(t, "/assets/index-abc123.js", nil)
		convey.So(w.Code, convey.ShouldEqual, http.StatusOK)
		convey.So(w.Header().Get("Content-Encoding"), convey.ShouldBeEmpty)
		convey.So(bytes.Equal(w.Body.Bytes(), bundleJS), convey.ShouldBeTrue)
	})
}

// TestAssets_AlreadyCompressedFormatsAreNotRecompressed woff2 自带压缩,再 gzip
// 一遍只是白烧 CPU 和内存。
func TestAssets_AlreadyCompressedFormatsAreNotRecompressed(t *testing.T) {
	convey.Convey("woff2 不重复压缩", t, func() {
		w := serve(t, "/assets/font-abc123.woff2", http.Header{"Accept-Encoding": []string{"gzip"}})
		convey.So(w.Code, convey.ShouldEqual, http.StatusOK)
		convey.So(w.Header().Get("Content-Encoding"), convey.ShouldBeEmpty)
	})
}

// TestAssets_MissingAssetStill404s 既有行为不能被压缩/缓存这层改掉:滚动更新期间
// 向旧副本要新 hash 的文件必须是 404,不能回落 index.html。
func TestAssets_MissingAssetStill404s(t *testing.T) {
	convey.Convey("缺失的 /assets/ 仍是 404", t, func() {
		w := serve(t, "/assets/does-not-exist.js", nil)
		convey.So(w.Code, convey.ShouldEqual, http.StatusNotFound)
		convey.So(w.Header().Get("Cache-Control"), convey.ShouldNotContainSubstring, "immutable")
	})
}
