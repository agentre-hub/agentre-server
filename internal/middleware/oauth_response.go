// Package middleware 提供 server 业务相关 gin middleware。
package middleware

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
)

// AttachOAuthErrorFields 在 /v1/oauth/device/token 与 /v1/oauth/token/refresh 等
// RFC 8628 端点上，把 c.Set("oauth_error", ...) 的字段拼进响应 body。
func AttachOAuthErrorFields() gin.HandlerFunc {
	return func(c *gin.Context) {
		bw := &bodyWriter{ResponseWriter: c.Writer, buf: &bytes.Buffer{}}
		c.Writer = bw
		c.Next()

		oauthErr, hasOA := c.Get("oauth_error")
		if !hasOA {
			_, _ = bw.ResponseWriter.Write(bw.buf.Bytes())
			return
		}
		var m map[string]interface{}
		if json.Unmarshal(bw.buf.Bytes(), &m) != nil {
			_, _ = bw.ResponseWriter.Write(bw.buf.Bytes())
			return
		}
		m["error"] = oauthErr
		if d, ok := c.Get("oauth_error_description"); ok {
			m["error_description"] = d
		}
		out, _ := json.Marshal(m)
		bw.ResponseWriter.Header().Set("Content-Length", "")
		_, _ = bw.ResponseWriter.Write(out)
	}
}

type bodyWriter struct {
	gin.ResponseWriter
	buf *bytes.Buffer
}

func (w *bodyWriter) Write(b []byte) (int, error)       { return w.buf.Write(b) }
func (w *bodyWriter) WriteString(s string) (int, error) { return w.buf.WriteString(s) }
func (w *bodyWriter) WriteHeader(status int)            { w.ResponseWriter.WriteHeader(status) }

var _ http.ResponseWriter = (*bodyWriter)(nil)
