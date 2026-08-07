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

// newNoRouteHandler 创建 SPA 的 NoRoute 处理器。
// 返回处理器函数和任何错误。
// 调用者不应缓存返回的函数，因为其闭包持有 fileSrv。
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
		// /assets/ 下不存在的文件返回 404，不回落到 index.html
		if strings.HasPrefix(path, "/assets/") {
			if f, ferr := sub.Open(strings.TrimPrefix(path, "/")); ferr == nil {
				_ = f.Close()
				fileSrv.ServeHTTP(c.Writer, c.Request)
				return
			}
			// 文件不存在，返回 404
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		// 对其他路径，尝试从 dist 提供文件
		if f, ferr := sub.Open(strings.TrimPrefix(path, "/")); ferr == nil {
			_ = f.Close()
			fileSrv.ServeHTTP(c.Writer, c.Request)
			return
		}
		// 文件不存在，回落到 index.html（SPA 路由）
		idx, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		c.Writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(c.Writer, c.Request, "index.html", time.Time{}, bytes.NewReader(idx))
	}, nil
}

// GetNoRouteHandler 返回 SPA 的 NoRoute 处理器函数。
// 仅供测试使用；生产环境通过 MountSPA 使用。
func GetNoRouteHandler() (gin.HandlerFunc, error) {
	return newNoRouteHandler()
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
