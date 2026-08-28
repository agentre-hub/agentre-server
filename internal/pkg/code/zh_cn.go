package code

import "github.com/cago-frame/cago/pkg/i18n"

// 中文包同时注册在 "zh-CN" 与 i18n.DefaultLang 两个标签下。
//
// 后者不是冗余：cago 的 i18n.T 在 ctx 没有语言时回落到 i18n.DefaultLang，而那个
// 常量是全小写的 "zh-cn"；本服务没有设置语言的中间件，于是**每一次**错误构造都走
// 那条回落分支。只注册 "zh-CN" 时 langs["zh-cn"] 是 nil map，取回的是零值空串，
// 客户端拿到 {"code":…,"msg":""}——有码无文案。两个标签指向同一份 map，没有副本。
func init() {
	i18n.Register("zh-CN", zhCN)
	i18n.Register(i18n.DefaultLang, zhCN)
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
	SyncCursorUnknown:      "服务端不认识该同步游标，请先拉取全量快照",

	PasskeyLimitReached:       "通行密钥数量已达上限，请先删除一把再添加",
	PasskeyChallengeInvalid:   "本次通行密钥操作已过期，请重新开始",
	PasskeyVerificationFailed: "通行密钥校验未通过",
	PasskeyAlreadyRegistered:  "这把通行密钥已经注册过了",
	PasskeyNotFound:           "通行密钥不存在",
	PasskeyOriginNotAllowed:   "当前站点不在通行密钥登录的允许列表里",
	PasskeyCredentialUnknown:  "这把通行密钥不属于任何可用账号",
	PasskeyCounterRollback:    "通行密钥的签名计数器发生回退，已拒绝本次登录",

	AccountChannelUnavailable: "实时通道暂不可用，已退回定时同步",

	OrgKindNotWritable:            "该类型不支持在网页上创建或修改",
	OrgObjectNotFound:             "对象不存在",
	OrgObjectDeleted:              "该对象已被删除",
	OrgBackendNotFound:            "引用的 Agent 后端不存在",
	OrgSystemAgentImmutable:       "内置 Agent 不能删除，也不能修改归属",
	OrgProjectParentCycle:         "父项目不能是这个项目自己或它的子项目",
	OrgProjectMemberExists:        "该 Agent 已经是这个项目的成员",
	OrgProjectPathDesktopReadOnly: "桌面端的项目路径不走这条通道",

	SessionImportMachineOffline: "这台机器当前不在线，无法读取它上面的本地会话",
	SessionImportFailed:         "导入本地会话失败",

	EngineProviderNotFound:      "供应商不存在",
	EngineBackendNotFound:       "Agent 后端不存在",
	EngineCLIPathForbidden:      "浏览器不能提交 CLI 路径",
	EngineBuiltinForbidden:      "浏览器不能创建内置后端",
	EngineBackendDeviceNotFound: "所选设备已不在账号内",
}
