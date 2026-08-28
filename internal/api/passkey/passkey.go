// Package passkey 定义通行密钥（WebAuthn）的请求 / 应答结构。
package passkey

import (
	"encoding/json"

	"github.com/cago-frame/cago/server/mux"
)

// BeginRegistrationRequest 取注册选项。前置条件是一条已登录的浏览器会话——请求体里
// 没有任何身份字段，账号与会话都取自 cookie。
type BeginRegistrationRequest struct {
	mux.Meta `path:"/v1/passkeys/register/begin" method:"POST"`
}

type BeginRegistrationResponse struct {
	// PublicKey 是 PublicKeyCredentialCreationOptions 原文，原样透传给
	// navigator.credentials.create({ publicKey })。
	//
	// 不在这一层重新定义一遍字段：那套结构由 WebAuthn 规范决定，抄一份进来只会多一处
	// 会漂移的映射，而浏览器要的就是规范里那个形状。
	PublicKey json.RawMessage `json:"publicKey"`
}

// FinishRegistrationRequest 提交认证器的回应。
type FinishRegistrationRequest struct {
	mux.Meta `path:"/v1/passkeys/register/finish" method:"POST"`
	// Name 是用户自己输入的名字，必填、限长——不从 AAGUID 猜设备型号。
	// 这里的 max 与 passkey_svc.MaxNameLen 是同一个数：绑定层挡住走 HTTP 的那条路，
	// service 那一层才是「必须落得进 varchar(64)」这件事的判据。
	Name string `json:"name" binding:"required,max=64"`
	// Credential 是 navigator.credentials.create() 回应的原文。
	Credential json.RawMessage `json:"credential" binding:"required"`
}

type FinishRegistrationResponse struct {
	Passkey PasskeyItem `json:"passkey"`
}

// BeginLoginRequest 取登录选项。**没有任何字段**，这不是疏忽：登录不要求任何标识
// （决策 10），allowCredentials 留空、由浏览器自己弹选择器。要一个邮箱输入框就等于
// 白送一个账号枚举面——回应快慢或文案差异都能泄漏「这个邮箱在不在册」。
type BeginLoginRequest struct {
	mux.Meta `path:"/v1/passkeys/login/begin" method:"POST"`
}

type BeginLoginResponse struct {
	// PublicKey 是 PublicKeyCredentialRequestOptions 原文，原样透传给
	// navigator.credentials.get({ publicKey })。
	PublicKey json.RawMessage `json:"publicKey"`
}

// FinishLoginRequest 提交认证器的回应。同样不带标识：账号由服务端按凭证 ID 反查。
type FinishLoginRequest struct {
	mux.Meta `path:"/v1/passkeys/login/finish" method:"POST"`
	// Credential 是 navigator.credentials.get() 回应的原文。
	Credential json.RawMessage `json:"credential" binding:"required"`
}

// FinishLoginResponse 是空的：登录的结果是那张 Set-Cookie 会话票，账号信息由
// /v1/auth/me 给出，没有理由在这里再复述一遍。
type FinishLoginResponse struct{}

// ListRequest 列出当前账号的全部通行密钥。
type ListRequest struct {
	mux.Meta `path:"/v1/passkeys" method:"GET"`
}

type ListResponse struct {
	Passkeys []PasskeyItem `json:"passkeys"`
}

// PasskeyItem 是清单里的一把密钥。
//
// 刻意不带凭证 ID 与公钥：清单是发给页面的东西，那两样是登录时的判据，页面一个都
// 用不上。名字 + 两个时间就足以让用户认出「这是哪一把」并决定删不删。
type PasskeyItem struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	CreatedAt  int64  `json:"created_at"`
	LastUsedAt int64  `json:"last_used_at"`
}

// DeleteRequest 删掉一把通行密钥。允许删到零把——GitHub 登录始终是回退路径。
type DeleteRequest struct {
	mux.Meta `path:"/v1/passkeys/:id" method:"DELETE"`
	ID       int64 `uri:"id" binding:"required"`
}

type DeleteResponse struct{}
