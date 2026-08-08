package code

import "github.com/cago-frame/cago/pkg/i18n"

func init() {
	i18n.Register("zh-CN", zhCN)
}

var zhCN = map[int]string{
	OperationFailed:  "操作失败",
	InvalidParameter: "参数错误",
	NotFound:         "资源不存在",
	ServerError:      "服务器内部错误",
	Unauthorized:     "未登录或会话已失效",
	Forbidden:        "无权访问",

	UserNotFound:        "用户不存在",
	UserBanned:          "用户已被封禁",
	OAuthStateInvalid:   "OAuth state 无效或已过期",
	OAuthExchangeFailed: "GitHub OAuth 兑换失败",
	OAuthProfileFailed:  "无法获取 GitHub 用户信息",
	GithubEmailMissing:  "GitHub 主邮箱不可访问，请在 GitHub 设置中将主邮箱设为已验证",
	SessionExpired:      "会话已过期，请重新登录",
	SessionInvalid:      "会话无效",

	DeviceFlowAuthorizationPending: "等待用户在浏览器中确认授权",
	DeviceFlowSlowDown:             "轮询过于频繁，请降低频率",
	DeviceFlowExpiredToken:         "设备授权已过期，请重新发起 login",
	DeviceFlowAccessDenied:         "用户拒绝授权",
	DeviceFlowInvalidGrant:         "device_code 无效",
	DeviceFlowUserCodeInvalid:      "user_code 格式不正确或不存在",
	DeviceFlowAlreadyConsumed:      "该 user_code 已被处理",

	DeviceNotFound:      "设备不存在",
	DeviceRevoked:       "设备授权已被撤销",
	RefreshTokenReplay:  "检测到 refresh token 重放，已撤销该设备所有凭证",
	RefreshTokenExpired: "refresh token 已过期，请重新授权",
	JWTSignatureInvalid: "访问令牌签名无效",
	JWTBlacklisted:      "访问令牌已被撤销",
	DeviceListFailed:    "拉取设备列表失败",
}
