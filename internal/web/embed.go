// Package web 把前端 SPA 嵌入 server 二进制。
//
// dist 目录在 build 时由 frontend/dist 拷贝填充；dev 模式由 vite 提供。
package web

import (
	"bytes"
	"context"
	"embed"
	"io/fs"
	"net/http"
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
	fileSrv := http.FileServer(http.FS(sub))

	return func(c *gin.Context) {
		path := c.Request.URL.Path
		if strings.HasPrefix(path, "/v1/") {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		if f, ferr := sub.Open(strings.TrimPrefix(path, "/")); ferr == nil {
			_ = f.Close()
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
		c.Writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(c.Writer, c.Request, "index.html", time.Time{}, bytes.NewReader(idx))
	}, nil
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
