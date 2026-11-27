package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
)

// agrctl 的文案是英文，它的每条请求都带 Accept-Language: en；server 的错误消息按它点名的
// 语言包回，agrctl 原样打印才前后一致。没点名（或点名的不是一个语言包的确切标签，例如
// 浏览器的 en-US）时照旧回落到默认的中文，现有调用方看到的文案不变。
func TestRouter_GivenAnAcceptLanguageNamingABundle_ThenErrorMessagesComeInThatLanguage(t *testing.T) {
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&RouterDeps{Cfg: &bootstrap.ServerConfig{}}).Router(context.Background(), testMux.Router))
	engine := testMux.IRouter.(*gin.Engine)

	msgFor := func(acceptLanguage string) string {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/v1/devices/cli-children", nil)
		if acceptLanguage != "" {
			req.Header.Set("Accept-Language", acceptLanguage)
		}
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, req)
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
		var body struct {
			Msg string `json:"msg"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		return body.Msg
	}

	require.Equal(t, "unauthorized", msgFor("en"))
	require.Equal(t, "unauthorized", msgFor("EN"), "language tags are case-insensitive")
	require.Equal(t, "未登录或会话已失效", msgFor(""))
	require.Equal(t, "未登录或会话已失效", msgFor("zh-CN,zh;q=0.9"))
	require.Equal(t, "未登录或会话已失效", msgFor("en-US,en;q=0.9"), "a browser's region tag keeps today's text")
	require.Equal(t, "未登录或会话已失效", msgFor("fr"))
}
