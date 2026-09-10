// Package web 把前端 SPA 嵌入 server 二进制。
//
// dist 目录在 build 时由 frontend/dist 拷贝填充；dev 模式由 vite 提供。
package web

import (
	"bytes"
	"compress/gzip"
	"context"
	"embed"
	"io/fs"
	"mime"
	"net/http"
	pathpkg "path"
	"strconv"
	"strings"
	"time"

	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/server/mux"
	"github.com/gin-gonic/gin"
)

//go:embed dist
var distFS embed.FS

// newNoRouteHandler 构造 SPA 的 NoRoute 处理器：命中 dist 里的真实文件就直接发，
// 未命中时 /assets/ 下返回 404、其余路径回落 index.html 交给前端路由。
func newNoRouteHandler() (gin.HandlerFunc, error) {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil, err
	}
	return newNoRouteHandlerFS(sub)
}

// newNoRouteHandlerFS 是 newNoRouteHandler 的可注入形态：dist 从外面给，用例因此
// 能拿真实形状的产物（带 hash 的 js/css、woff2）来验缓存与压缩，而不必依赖
// make prepare-web-dist 造的那份 15 字节占位。
func newNoRouteHandlerFS(sub fs.FS) (gin.HandlerFunc, error) {
	fileSrv := http.FileServer(http.FS(sub))
	gzipped, err := precompress(sub)
	if err != nil {
		return nil, err
	}

	return func(c *gin.Context) {
		path := c.Request.URL.Path
		if strings.HasPrefix(path, "/v1/") {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		if f, ferr := sub.Open(strings.TrimPrefix(path, "/")); ferr == nil {
			_ = f.Close()
			setCacheHeaders(c, path)
			if serveGzipped(c, gzipped, path) {
				return
			}
			fileSrv.ServeHTTP(c.Writer, c.Request)
			return
		}
		// /assets/ 下是 vite 带 hash 的构建产物，未命中只可能是滚动更新期间浏览器
		// 拿着新副本的 index.html 向旧副本要新文件。回落 index.html 会返回
		// 200 + text/html，浏览器把 HTML 当 JS 解析报错，而 200 不会被任何监控
		// 计成失败；直接 404 才让这次缺失可见、刷新即可自愈。
		if strings.HasPrefix(path, "/assets/") {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		// 其余未命中路径是 SPA 的前端路由（/device、/login 等），回落 index.html
		idx, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		setCacheHeaders(c, path)
		c.Writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(c.Writer, c.Request, "index.html", time.Time{}, bytes.NewReader(idx))
	}, nil
}

// immutableCacheControl 给 /assets/ 下的产物。vite 把内容 hash 写进文件名，内容一变
// 文件名就变，所以这些 URL 的内容永不改写 —— 正是 immutable 的定义。
//
// 此前一个缓存头都没有，而且不是「忘了配」那么简单：embed.FS 的 ModTime 是零值，
// http.ServeContent 因此连 Last-Modified 都不发，net/http 也不会自动生成 ETag。
// 于是每次打开页面都要把整份 bundle（真实产物 2.2MB js + 107KB css）重新下一遍，
// 连一次 304 都省不下。
const immutableCacheControl = "public, max-age=31536000, immutable"

// revalidateCacheControl 给 index.html。它是那张指向当前一组 hash 的名片，**绝不能**
// 跟着一起被永久缓存 —— 否则滚动更新之后浏览器永远拿旧名片，新版本再也上不去。
const revalidateCacheControl = "no-cache"

func setCacheHeaders(c *gin.Context, path string) {
	// 无论压没压，凡是可能有两种编码的响应都要声明 Vary，否则共享缓存会把 gzip 的
	// 副本发给不接受 gzip 的客户端。
	c.Writer.Header().Set("Vary", "Accept-Encoding")
	if strings.HasPrefix(path, "/assets/") {
		c.Writer.Header().Set("Cache-Control", immutableCacheControl)
		return
	}
	c.Writer.Header().Set("Cache-Control", revalidateCacheControl)
}

// precompress 在构造时把可压缩的产物各 gzip 一份留在内存里。
//
// dist 是编译期就固定的，压一次就够：既不用为每个请求烧 CPU，也不必引入流式压缩
// 中间件。代价是常驻内存多一份压缩副本 —— 真实产物压完是几百 KB 量级，换掉的是
// 每次页面加载几 MB 的出网流量。
func precompress(sub fs.FS) (map[string][]byte, error) {
	out := map[string][]byte{}
	err := fs.WalkDir(sub, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !compressibleExt(pathpkg.Ext(name)) {
			return nil
		}
		raw, err := fs.ReadFile(sub, name)
		if err != nil {
			return err
		}
		var buf bytes.Buffer
		zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		if err != nil {
			return err
		}
		if _, err := zw.Write(raw); err != nil {
			return err
		}
		if err := zw.Close(); err != nil {
			return err
		}
		// 压完反而更大就别要了（极小的文件会这样）。
		if buf.Len() >= len(raw) {
			return nil
		}
		out["/"+name] = buf.Bytes()
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// compressibleExt 只放行文本类产物。woff2 / png / 各类图片自带压缩，再 gzip 一遍
// 只是白烧 CPU 和常驻内存，通常还压不小。
func compressibleExt(ext string) bool {
	switch ext {
	case ".js", ".mjs", ".css", ".html", ".json", ".svg", ".map", ".txt", ".xml":
		return true
	default:
		return false
	}
}

// serveGzipped 发压缩副本；没有副本或客户端不接受 gzip 时返回 false 交回原路径。
func serveGzipped(c *gin.Context, gzipped map[string][]byte, path string) bool {
	body, ok := gzipped[path]
	if !ok || !acceptsGzip(c.Request.Header.Get("Accept-Encoding")) {
		return false
	}
	header := c.Writer.Header()
	// 自己写字节就没有 http.FileServer 的类型嗅探了，Content-Type 必须自己给 ——
	// 少了它浏览器会把 js 当成别的东西拒掉。
	if ctype := mime.TypeByExtension(pathpkg.Ext(path)); ctype != "" {
		header.Set("Content-Type", ctype)
	}
	header.Set("Content-Encoding", "gzip")
	header.Set("Content-Length", strconv.Itoa(len(body)))
	c.Writer.WriteHeader(http.StatusOK)
	_, _ = c.Writer.Write(body)
	return true
}

// acceptsGzip 判定 Accept-Encoding 里有没有 gzip，并尊重显式的 q=0（"我不要 gzip"）。
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			continue
		}
		for _, param := range fields[1:] {
			param = strings.TrimSpace(param)
			if strings.HasPrefix(param, "q=") && strings.TrimPrefix(param, "q=") == "0" {
				return false
			}
		}
		return true
	}
	return false
}

// MountSPA 把 dist 内容挂在根路径；非 /v1/* 路径 fallback 到 index.html。
// /assets/ 下不存在的文件返回 404（而非 index.html）。
func MountSPA(_ context.Context, _ *configs.Config) error {
	mux.RegisterMiddleware(func(_ *configs.Config, engine *gin.Engine) error {
		handler, err := newNoRouteHandler()
		if err != nil {
			return err
		}
		engine.NoRoute(handler)
		return nil
	})
	return nil
}
