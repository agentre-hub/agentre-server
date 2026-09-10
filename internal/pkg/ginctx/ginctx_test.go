package ginctx

import (
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func newCtx() *gin.Context {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(nil)
	return c
}

// 鉴权中间件写进去、控制器读出来，这一进一出必须是同一把键。以前两侧各写字面量
// "user_id"，改一处漏一处不会有任何编译错误，所以键只能有这一个来源。
func TestSetThenGet_RoundTrips(t *testing.T) {
	c := newCtx()

	SetUserID(c, 42)
	SetDevice(c, 7, "desktop")
	SetJTI(c, "jti-1")
	SetCSRFToken(c, "csrf-1")

	assert.Equal(t, int64(42), UserID(c))
	assert.Equal(t, int64(7), DeviceID(c))
	assert.Equal(t, "desktop", DeviceKind(c))
	assert.Equal(t, "jti-1", JTI(c))
	assert.Equal(t, "csrf-1", CSRFToken(c))
}

// 与被替换掉的那 13 处内联写法保持同一语义：键不在就是零值，不是 panic。公开端点
// 和「会话或设备」两可的端点都会读到没写过的键（如 session 分支没有 device_id）。
func TestMissingKeys_AreZeroValues(t *testing.T) {
	c := newCtx()

	assert.Zero(t, UserID(c))
	assert.Zero(t, DeviceID(c))
	assert.Empty(t, DeviceKind(c))
	assert.Empty(t, JTI(c))
	assert.Empty(t, CSRFToken(c))
}

// 类型断言失败也必须落到零值：上游若写了别的类型，控制器拿到的是 0，会被既有的
// “userID == 0 → 401” 判据挡住，而不是把请求当成某个账号的。
func TestWrongTypes_FallBackToZero(t *testing.T) {
	c := newCtx()
	c.Set(KeyUserID, "not-an-int64")
	c.Set(KeyDeviceID, 7) // int，不是 int64
	c.Set(KeyJTI, 123)

	assert.Zero(t, UserID(c))
	assert.Zero(t, DeviceID(c))
	assert.Empty(t, JTI(c))
}

// CSRF() 中间件按「有没有出示与会话匹配的 token」判定，空串是它的失败判据之一，
// 因此读不到键与读到空串必须不可区分。
func TestCSRFToken_MissingReadsAsEmpty(t *testing.T) {
	c := newCtx()
	assert.Equal(t, "", CSRFToken(c))
	SetCSRFToken(c, "")
	assert.Equal(t, "", CSRFToken(c))
}
