// Package ginctx 集中定义鉴权中间件与控制器共享的 gin 上下文键和访问器。
// 本包只搬运已验证的值，不执行鉴权判定，也不依赖业务层。
package ginctx

import "github.com/gin-gonic/gin"

const (
	KeyUserID     = "user_id"
	KeyDeviceID   = "device_id"
	KeyDeviceKind = "device_kind"
	KeyJTI        = "jti"
	KeyCSRFToken  = "csrf_token"
)

// SetUserID 记下这条请求属于哪个账号。会话与设备两种鉴权都要落这一个键。
func SetUserID(c *gin.Context, userID int64) { c.Set(KeyUserID, userID) }

// SetDevice 记下调用方是哪台设备、什么形态。仅设备 JWT 分支有值。
func SetDevice(c *gin.Context, deviceID int64, kind string) {
	c.Set(KeyDeviceID, deviceID)
	c.Set(KeyDeviceKind, kind)
}

// SetJTI 转交已验签的凭据标识。中继类长连接只在 upgrade 时过一次中间件，之后要
// 靠它自己反复复查撤销，因此下游必须拿得到。
func SetJTI(c *gin.Context, jti string) { c.Set(KeyJTI, jti) }

// SetCSRFToken 记下会话侧的 CSRF token，供 CSRF 判据比对。仅 cookie 分支有值。
func SetCSRFToken(c *gin.Context, token string) { c.Set(KeyCSRFToken, token) }

// UserID 取调用方账号；键不存在或类型不符一律 0，由调用方按各自的 401 判据处理。
func UserID(c *gin.Context) int64 { return valueOf[int64](c, KeyUserID) }

// DeviceID 取调用方设备；会话分支没有这个键，读出来是 0。
func DeviceID(c *gin.Context) int64 { return valueOf[int64](c, KeyDeviceID) }

// DeviceKind 取设备形态；会话分支没有这个键，读出来是空串。
func DeviceKind(c *gin.Context) string { return valueOf[string](c, KeyDeviceKind) }

// JTI 取本次请求所用凭据的标识；非 JWT 分支为空串。
func JTI(c *gin.Context) string { return valueOf[string](c, KeyJTI) }

// CSRFToken 取会话的 CSRF token；非会话分支为空串，正好是 csrfOK 的失败判据。
func CSRFToken(c *gin.Context) string { return valueOf[string](c, KeyCSRFToken) }

func valueOf[T any](c *gin.Context, key string) T {
	v, _ := c.Get(key)
	typed, _ := v.(T)
	return typed
}
