package apierr

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

func abortOnce(t *testing.T, status, biz int) (*httptest.ResponseRecorder, map[string]any, bool) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)

	Abort(c, status, biz)

	var body map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	return w, body, c.IsAborted()
}

func TestAbort_WritesTheEnvelopeAndStopsTheChain(t *testing.T) {
	w, body, aborted := abortOnce(t, http.StatusUnauthorized, code.Unauthorized)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Equal(t, float64(code.Unauthorized), body["code"])
	assert.NotEmpty(t, body["msg"], "msg 必须译过，前端直接展示它")
	assert.True(t, aborted, "必须终止处理链，否则后面的 handler 还会跑")
}

// data 字段必须在，且为 null。cago 自己的 httputils.HandleError 写的是
// {code,msg,request_id}——没有 data。中间件和裸 websocket handler 走的是本函数
// 而不是那条路，两种信封的差别对前端是可见的：api.ts 按 {code,msg,data} 解包。
// 这条用例就是钉住「别顺手改用 cago 的那个」。
func TestAbort_KeepsTheDataKeyExplicitlyNull(t *testing.T) {
	_, body, _ := abortOnce(t, http.StatusForbidden, code.Forbidden)

	v, ok := body["data"]
	assert.True(t, ok, "data 键必须存在")
	assert.Nil(t, v)
	_, hasRequestID := body["request_id"]
	assert.False(t, hasRequestID, "本信封没有 request_id，加进去就是换了一种形状")
}

// 状态码与业务码是两个独立的入参：同一个 401 下有 Unauthorized / JWTBlacklisted /
// JWTSignatureInvalid 三种业务码，daemon 靠业务码区分该重签还是该重新配对。
func TestAbort_StatusAndBusinessCodeAreIndependent(t *testing.T) {
	_, body, _ := abortOnce(t, http.StatusUnauthorized, code.JWTBlacklisted)

	assert.Equal(t, float64(code.JWTBlacklisted), body["code"])
}
