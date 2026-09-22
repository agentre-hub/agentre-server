package session

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ClearCookie 必须能真的清掉 __Host- 前缀的 cookie：浏览器只认带 Secure 的
// Set-Cookie 删除指令，少了它整条指令被丢弃，登出就是假的。
func TestClearCookie_HostPrefixedName_SetsSecure(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/", nil)

	ClearCookie(c, HostCookieName)

	set := w.Header().Get("Set-Cookie")
	require.NotEmpty(t, set)
	assert.Contains(t, set, HostCookieName+"=")
	assert.Contains(t, set, "Secure")
}

// http（dev）部署下清的是 CookieName，不带 Secure：登出必须在任何场景下都真的
// 把票删掉，一张带 Secure 的删除指令在 HTTP 页面上会被浏览器忽略。
func TestClearCookie_LegacyName_OmitsSecure(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/", nil)

	ClearCookie(c, CookieName)

	set := w.Header().Get("Set-Cookie")
	require.NotEmpty(t, set)
	assert.Contains(t, set, CookieName+"=")
	assert.NotContains(t, set, "Secure")
}

// 转发票的名字跟控制台会话 cookie 同一条规矩（规格「转发登录」第 4 步）：https 下
// 带 __Host- 前缀，http（dev）下不带。
func TestForwardCookieName_FollowsTheHTTPSDecision(t *testing.T) {
	assert.Equal(t, "__Host-agentre_fw", ForwardCookieName(true))
	assert.Equal(t, "agentre_fw", ForwardCookieName(false))
}
