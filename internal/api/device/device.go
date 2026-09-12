package device

import "github.com/cago-frame/cago/server/mux"

type DeviceAuthorizeRequest struct {
	mux.Meta    `path:"/v1/oauth/device/authorize" method:"POST"`
	DeviceKind  string `json:"device_kind"  binding:"required,oneof=desktop agentred mobile"`
	Fingerprint string `json:"fingerprint"  binding:"required,min=8,max=128"`
	Platform    string `json:"platform"     binding:"max=64"`
	Version     string `json:"version"`
	// Name 是设备自报的显示名（通常是主机名）。可空 —— 不带它的老客户端照常授权，
	// 设备名回退到指纹缩写。设备流没有第二条途径拿到这个名字：不在这里带上，
	// 设备列表里每台机器就都只能叫指纹缩写。
	Name string `json:"name" binding:"max=128"`
}
type DeviceAuthorizeResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	Interval                int    `json:"interval"`
	ExpiresIn               int    `json:"expires_in"`
}

type DeviceTokenRequest struct {
	mux.Meta   `path:"/v1/oauth/device/token" method:"POST"`
	GrantType  string `json:"grant_type"  binding:"required,eq=urn:ietf:params:oauth:grant-type:device_code"`
	DeviceCode string `json:"device_code" binding:"required"`
}
type DeviceTokenResponse struct {
	AccessToken      string `json:"access_token"`
	TokenType        string `json:"token_type"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshToken     string `json:"refresh_token"`
	RefreshExpiresIn int    `json:"refresh_expires_in"`
	DeviceID         int64  `json:"device_id"`
}

type DevicePendingRequest struct {
	mux.Meta `path:"/v1/oauth/device/pending" method:"GET"`
	UserCode string `form:"user_code" binding:"required"`
}
type DevicePendingResponse struct {
	DeviceKind string `json:"device_kind"`
	Platform   string `json:"platform"`
	Version    string `json:"version"`
	ExpiresIn  int    `json:"expires_in"`
}

type DeviceApproveRequest struct {
	mux.Meta `path:"/v1/oauth/device/approve" method:"POST"`
	UserCode string `json:"user_code" binding:"required"`
}
type DeviceApproveResponse struct {
	DeviceKind string `json:"device_kind"`
}

type DeviceDenyRequest struct {
	mux.Meta `path:"/v1/oauth/device/deny" method:"POST"`
	UserCode string `json:"user_code" binding:"required"`
}
type DeviceDenyResponse struct{}

// RelayTicketRequest 让已登录网页换取一枚只可用于 relay client 的短效票据。
// 它不创建 devices 行，也不能访问 daemon、同步或其它设备 JWT 端点。
type RelayTicketRequest struct {
	mux.Meta `path:"/v1/relay/ticket" method:"POST"`
}

type RelayTicketResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
	// PeerFingerprint 是这枚票里签着的网页对端身份（账号级派生，决策 8/9）。浏览器
	// 拿它当自己的对端标识，而不是自己生成一个存在 localStorage 里——那个清一次
	// 站点数据就换人，此前从网页发起的对话在镜像里当场成为孤儿。
	//
	// 名字与 JWT 里的 pfp、与 /v1/agent-sessions、/v1/session-import、dispatch 上行
	// 里的 peer_fingerprint 是同一个值同一个名字。别叫它 client_id：client_id
	// 在同一个服务的 /v1/oauth/* 底下是 RFC 6749 的注册客户端 —— 两回事。
	PeerFingerprint string `json:"peer_fingerprint"`
}

type TokenRefreshRequest struct {
	mux.Meta     `path:"/v1/oauth/token/refresh" method:"POST"`
	RefreshToken string `json:"refresh_token" binding:"required"`
}
type TokenRefreshResponse struct {
	AccessToken      string `json:"access_token"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshToken     string `json:"refresh_token"`
	RefreshExpiresIn int    `json:"refresh_expires_in"`
}

type TokenRevokeRequest struct {
	mux.Meta `path:"/v1/oauth/token/revoke" method:"POST"`
	DeviceID int64 `json:"device_id"`
}
type TokenRevokeResponse struct{}

type ListDevicesRequest struct {
	mux.Meta `path:"/v1/devices" method:"GET"`
}

type ListDevicesItem struct {
	ID int64 `json:"id"`
	// Name 是设备 claim 时自报的名字（通常是主机名）。它归设备所有：那台机器每次重新
	// 配对都会再报一次并覆盖这一格。
	Name string `json:"name"`
	// DisplayName 是**用户**给这台设备起的账号级备注名，空串 = 没起过。
	//
	// 消费端按「有 display_name 用它，没有回落 name」渲染——同一台 Mac 上三个 checkout
	// 在账号里就是三行同名设备，这一格是唯一分得清谁是谁的东西。两格都给而不是在服务端
	// 合成一格：改名界面要拿 name 当占位符、拿 display_name 当输入框里的当前值，合成之后
	// 就再也分不出「没设过」和「设成了和主机名一样」。
	DisplayName  string `json:"display_name"`
	Kind         string `json:"kind"`
	Platform     string `json:"platform"`
	Version      string `json:"version"`
	Fingerprint  string `json:"fingerprint"`
	LastSeenAt   int64  `json:"last_seen_at"`
	Status       int    `json:"status"`
	Online       bool   `json:"online"`
	IsThisDevice bool   `json:"is_this_device"`
	// ProtocolMismatch 为真表示这台机器上一次镜像握手被 daemon 判定协议版本不合而
	// 拒绝（spec「控制台呈现与 latest 来源」一节：「这要求 server 把握手被拒这件事记成
	// 按 (账号, 机器) 的共享状态供设备卡读取」）。渲染留给后续任务，这里只负责读得到。
	ProtocolMismatch bool `json:"protocol_mismatch"`
	// DaemonCommit 是这台机器最近一次镜像握手自报的短 commit（spec「协议：版本窗口
	// 与自报版本」）。空串 = 非发布构建：消费端据此显示为开发构建、永不劝升
	// （决策 5——未注入版本的构建自称 1.0.0，比任何 0.x 正式版都「新」，不加这道闸
	// 就会把本地构建的机器判成最新）。
	//
	// 只在 DaemonBuildKnown 为真时才有这层含义。
	DaemonCommit string `json:"daemon_commit"`
	// DaemonBuildKnown 为真表示 server 至少成功握过一次手、记下了这台机器自报的构建。
	// 为假时 DaemonCommit 恒为空串，且那个空串**不**表示开发构建——它表示不知道，
	// 消费端此时不下任何判断（决策 19：拿不到就是拿不到，不能借「没有值」冒充一个
	// 结论）。
	DaemonBuildKnown bool `json:"daemon_build_known"`
}

// DeviceUpgradeRequest 是控制台点「升级 agentred」发出的那一次调用（规格
// 2026-09-03-client-upgrade-guidance「控制台呈现与 latest 来源」）：server 借它对那台
// 机器已鉴权的镜像连接发起自更新，不引入新的授权面（决策 15）。
type DeviceUpgradeRequest struct {
	mux.Meta `path:"/v1/devices/upgrade" method:"POST"`
	DeviceID int64 `json:"device_id" binding:"required"`
	// Force 越过「有对话在跑就拒绝」那道闸（决策 8）。它是请求里的一个**显式**位：
	// 界面必须先走完二次确认才允许带上它，一次重试绝不能被读成默许。
	Force bool `json:"force"`
}

// DeviceUpgradeResponse 与 agentrewire.AgentredSelfUpdateResponse 一一对应：
// 「受理了没有」由 daemon 判定，server 与浏览器都只是把它原样传下去。
//
// 升成了没有不在这里答——受理之后 daemon 就重启了，判据是重连后 devices.version
// 变没变，由控制台自己轮询（规格「远程一键升级」）。
type DeviceUpgradeResponse struct {
	Accepted bool `json:"accepted"`
	// RejectReason 空串即受理；其余取值见 mirror_svc.UpgradeRejectReason。
	RejectReason string `json:"reject_reason"`
	// Message 是那句人话，逐字来自 daemon（与 `agentred update` 命令行、与桌面端同一
	// 句话——决策 22）。界面照抄它，不重翻一遍。
	Message string `json:"message"`
	// ActiveTurns 只在 reject_reason 是 active_turns 时非零。
	ActiveTurns int32 `json:"active_turns"`
	// TargetVersion 是 daemon 解析出来准备安装的版本；拿不到时是空串。
	TargetVersion string `json:"target_version"`
}

type ListDevicesResponse struct {
	Devices []ListDevicesItem `json:"devices"`
}

// RenameDeviceRequest 给一台设备设/改/清账号级备注名。
//
// 走 PATCH /v1/devices/:id 而不是 POST /v1/devices/:id/rename：本仓既有的「改一个已有
// 资源的一个字段」都是这个形状（engine 的 providers/:provider_key、backends/:sync_id）。
//
// DisplayName 上**不挂** binding max：长度判定在实体层（device_entity.NormalizeDisplayName），
// 判的是修剪之后的长度。挂在这里会让「恰好到上限 + 首尾各一个空格」被拒，而它修剪之后
// 明明合法——同一条规则有两个判据就一定会漂。
type RenameDeviceRequest struct {
	mux.Meta `path:"/v1/devices/:id" method:"PATCH"`
	DeviceID int64 `uri:"id" binding:"required"`
	// DisplayName 空串（或只有空白）= 清空备注名，生效的显示名回落到设备自报的 name。
	//
	// 指针 + required：字段**缺席**与字段是空串是两件事。少了这一层，一个漏写字段、
	// 或者干脆没带 body 的请求会被读成「清空」，用户设的名字就这么悄悄没了；
	// 清空必须是显式写出来的 "display_name": ""。
	DisplayName *string `json:"display_name" binding:"required"`
}

type RenameDeviceResponse struct {
	// DisplayName 是这一改之后**生效**的显示名：设了备注名就是它，清空之后是设备自报名。
	// 调用方可以直接拿它刷新那一行，不必自己再算一遍回落。
	DisplayName string `json:"display_name"`
}
