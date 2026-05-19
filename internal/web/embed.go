// Package web 把前端 SPA 嵌入 hub 二进制。
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

// MountSPA 把 dist 内容挂在根路径；非 /v1/* 路径 fallback 到 index.html。
func MountSPA(_ context.Context, _ *configs.Config) error {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return err
	}
	fileSrv := http.FileServer(http.FS(sub))
	mux.RegisterMiddleware(func(_ *configs.Config, engine *gin.Engine) error {
		engine.NoRoute(func(c *gin.Context) {
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
			idx, err := fs.ReadFile(sub, "index.html")
			if err != nil {
				c.AbortWithStatus(http.StatusInternalServerError)
				return
			}
			c.Writer.Header().Set("Content-Type", "text/html; charset=utf-8")
			http.ServeContent(c.Writer, c.Request, "index.html", time.Time{}, bytes.NewReader(idx))
		})
		return nil
	})
	return nil
}
