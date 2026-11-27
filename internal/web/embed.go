// Package web 把前端 SPA 嵌入 server 二进制。
//
// dist 目录在 build 时由 frontend/dist 拷贝填充；dev 模式由 vite 提供。
package web

import (
	"bytes"
	"compress/gzip"
	"context"
	"embed"
	"io"
	"io/fs"
	"mime"
	"net/http"
	pathpkg "path"
	"strconv"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
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
	compressedCopies, err := precompress(sub)
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
			// 显式给出类型再交给 FileServer：http.ServeContent 尊重 writer 上
			// 已经设好的 Content-Type，不再自己嗅探。mime.TypeByExtension 认不出
			// .webmanifest（本机返回空串），不先设就会被嗅探成 text/plain。
			if ctype := contentTypeFor(path); ctype != "" {
				c.Writer.Header().Set("Content-Type", ctype)
			}
			if serveCompressed(c, compressedCopies, path) {
				return
			}
			fileSrv.ServeHTTP(c.Writer, c.Request)
			return
		}
		// /assets/ 与 /icons/ 下是构建/静态产物，未命中只可能是滚动更新期间浏览器
		// 拿着新副本的 index.html 向旧副本要新文件，或者浏览器试探性地要一枚并不
		// 存在的图标。回落 index.html 会返回 200 + text/html：浏览器把 HTML 当 JS
		// 解析报错，或者把 HTML 当图片静默丢弃，而 200 不会被任何监控计成失败；
		// 直接 404 才让这次缺失可见、刷新即可自愈。
		if strings.HasPrefix(path, "/assets/") || strings.HasPrefix(path, "/icons/") {
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
// 不能靠 net/http 的默认行为：embed.FS 的 ModTime 是零值，http.ServeContent 因此连
// Last-Modified 都不发，net/http 也不会自动生成 ETag。不显式给缓存头，每次打开页面
// 都要把整份 bundle（真实产物 2.2MB js + 107KB css）重新下一遍，连一次 304 都省不下。
const immutableCacheControl = "public, max-age=31536000, immutable"

// revalidateCacheControl 给 index.html。它是那张指向当前一组 hash 的名片，**绝不能**
// 跟着一起被永久缓存 —— 否则滚动更新之后浏览器永远拿旧名片，新版本再也上不去。
const revalidateCacheControl = "no-cache"

// contentTypeFor 决定静态产物的 Content-Type。
//
// 绝大多数扩展名交给 mime.TypeByExtension；.webmanifest 是个例外：Go 的类型表里
// 没有它（本机 mime.TypeByExtension(".webmanifest") == ""），而浏览器要求 PWA
// manifest 必须带 application/manifest+json，否则整份 manifest 被拒收、安装入口消失。
func contentTypeFor(path string) string {
	switch pathpkg.Ext(path) {
	case ".webmanifest":
		return "application/manifest+json; charset=utf-8"
	default:
		return mime.TypeByExtension(pathpkg.Ext(path))
	}
}

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

// brotliLevel 取 6：启动时一次性压整个 bundle，11（最大）对 2MB 级 JS 要几秒到十几秒，
// 而 6 的体积已明显小于 gzip -9，耗时在百毫秒量级。
const brotliLevel = 6

// compressed 是同一份产物的预压缩副本；某一种压完不比原文小就留空。
type compressed struct {
	gzip, br []byte
}

// precompress 在构造时把可压缩的产物各压一份 gzip 与 brotli 留在内存里。
//
// dist 是编译期就固定的，压一次就够：既不用为每个请求烧 CPU，也不必引入流式压缩
// 中间件。代价是常驻内存多两份压缩副本 —— 真实产物压完是几百 KB 量级，换掉的是
// 每次页面加载几 MB 的出网流量。
func precompress(sub fs.FS) (map[string]compressed, error) {
	out := map[string]compressed{}
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
		var gz, br bytes.Buffer
		zw, err := gzip.NewWriterLevel(&gz, gzip.BestCompression)
		if err != nil {
			return err
		}
		bw := brotli.NewWriterLevel(&br, brotliLevel)
		for _, w := range []io.WriteCloser{zw, bw} {
			if _, err := w.Write(raw); err != nil {
				return err
			}
			if err := w.Close(); err != nil {
				return err
			}
		}
		// 压完反而更大就别要了（极小的文件会这样）。
		var c compressed
		if gz.Len() < len(raw) {
			c.gzip = gz.Bytes()
		}
		if br.Len() < len(raw) {
			c.br = br.Bytes()
		}
		if c.gzip != nil || c.br != nil {
			out["/"+name] = c
		}
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
	case ".js", ".mjs", ".css", ".html", ".json", ".webmanifest", ".svg", ".map", ".txt", ".xml":
		return true
	default:
		return false
	}
}

// serveCompressed 按 Accept-Encoding 发 brotli 或 gzip 副本；没有副本或客户端都不接受时
// 返回 false 交回原路径。
func serveCompressed(c *gin.Context, copies map[string]compressed, path string) bool {
	cp, ok := copies[path]
	if !ok {
		return false
	}
	encoding, body := pickEncoding(c.Request.Header.Get("Accept-Encoding"), cp)
	if body == nil {
		return false
	}
	header := c.Writer.Header()
	// 自己写字节就没有 http.FileServer 的类型嗅探了，Content-Type 必须自己给 ——
	// 少了它浏览器会把 js 当成别的东西拒掉。
	if ctype := contentTypeFor(path); ctype != "" {
		header.Set("Content-Type", ctype)
	}
	header.Set("Content-Encoding", encoding)
	header.Set("Content-Length", strconv.Itoa(len(body)))
	c.Writer.WriteHeader(http.StatusOK)
	_, _ = c.Writer.Write(body)
	return true
}

// pickEncoding 在客户端接受且有副本的编码里挑一个：q 值高者优先，同 q 取 br。
func pickEncoding(header string, cp compressed) (string, []byte) {
	brQ, gzQ := 0.0, 0.0
	if cp.br != nil {
		brQ = encodingQ(header, "br")
	}
	if cp.gzip != nil {
		gzQ = encodingQ(header, "gzip")
	}
	switch {
	case brQ > 0 && brQ >= gzQ:
		return "br", cp.br
	case gzQ > 0:
		return "gzip", cp.gzip
	default:
		return "", nil
	}
}

// encodingQ 取 Accept-Encoding 里某个编码的 q 值：没列出是 0，列出但没写 q 是 1，
// 显式 q=0 表示「我不要」。q 写坏了按 1 处理，不因对端的小瑕疵丢掉压缩。
func encodingQ(header, name string) float64 {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), name) {
			continue
		}
		for _, param := range fields[1:] {
			k, v, _ := strings.Cut(strings.TrimSpace(param), "=")
			if !strings.EqualFold(strings.TrimSpace(k), "q") {
				continue
			}
			if q, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && q >= 0 && q <= 1 {
				return q
			}
		}
		return 1
	}
	return 0
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
