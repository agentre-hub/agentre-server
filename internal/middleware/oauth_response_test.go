package middleware_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	. "github.com/smartystreets/goconvey/convey"

	"agentre-server/internal/middleware"
)

// serve 挂一条最小路由：AttachOAuthErrorFields + 一个由用例决定怎么写响应的 handler。
func serve(handler gin.HandlerFunc) *httptest.ResponseRecorder {
	r := gin.New()
	r.GET("/token", middleware.AttachOAuthErrorFields(), handler)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/token", nil))
	return w
}

func TestAttachOAuthErrorFields(t *testing.T) {
	gin.SetMode(gin.TestMode)

	Convey("AttachOAuthErrorFields", t, func() {
		Convey("有 oauth_error → error 拼进 body，原字段不动", func() {
			w := serve(func(c *gin.Context) {
				c.Set("oauth_error", "authorization_pending")
				c.JSON(http.StatusBadRequest, gin.H{"code": 30000, "msg": "还没授权"})
			})

			So(w.Code, ShouldEqual, http.StatusBadRequest)

			var body map[string]interface{}
			So(json.Unmarshal(w.Body.Bytes(), &body), ShouldBeNil)
			So(body["error"], ShouldEqual, "authorization_pending")
			So(body["code"], ShouldEqual, float64(30000))
			So(body["msg"], ShouldEqual, "还没授权")
			_, hasDesc := body["error_description"]
			So(hasDesc, ShouldBeFalse)
		})

		Convey("同时有 oauth_error_description → 两个字段都拼进去", func() {
			w := serve(func(c *gin.Context) {
				c.Set("oauth_error", "expired_token")
				c.Set("oauth_error_description", "device_code 已过期")
				c.JSON(http.StatusBadRequest, gin.H{"code": 30000, "msg": "expired"})
			})

			var body map[string]interface{}
			So(json.Unmarshal(w.Body.Bytes(), &body), ShouldBeNil)
			So(body["error"], ShouldEqual, "expired_token")
			So(body["error_description"], ShouldEqual, "device_code 已过期")
		})

		Convey("没有 oauth_error → body 逐字透传", func() {
			w := serve(func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{"code": 0, "msg": "ok"})
			})

			So(w.Code, ShouldEqual, http.StatusOK)
			So(w.Body.String(), ShouldEqual, `{"code":0,"msg":"ok"}`)
		})

		Convey("有 oauth_error 但 body 不是 JSON → 原样透传，不吞不报错", func() {
			w := serve(func(c *gin.Context) {
				c.Set("oauth_error", "invalid_grant")
				c.String(http.StatusBadRequest, "boom")
			})

			So(w.Code, ShouldEqual, http.StatusBadRequest)
			So(w.Body.String(), ShouldEqual, "boom")
		})
	})
}
