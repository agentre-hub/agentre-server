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
	DeviceKindMismatch:  "该指纹已属于另一台非浏览器设备",

	RelayDaemonNotFound: "该账号未登记此 daemon",
	RelayDaemonOffline:  "daemon 当前离线",
	RelayForwardFailed:  "daemon 在线但中转转发失败",

	SyncResyncRequired:     "设备离线过久，请先拉取全量快照再同步",
	SyncPayloadRejected:    "同步载荷包含不允许跨机传输的字段",
	SyncKindInvalid:        "同步对象类型无效",
	SyncAvatarHashMismatch: "头像内容与声明的哈希不符",
	SyncAvatarNotFound:     "头像不存在",
}
