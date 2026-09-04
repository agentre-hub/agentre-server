package auth

import "github.com/cago-frame/cago/server/mux"

// GithubCallbackPath 是 OAuth 回调落地的路径，与 GithubCallbackRequest 上注册的路由
// 同值（由 callback_path_test.go 钉住）。oauth_svc 用它拼 redirect_uri，两者必须一致，
// 所以它是路由表的推论而不是配置项。
const GithubCallbackPath = "/v1/auth/oauth/github/callback"

type GithubAuthorizeRequest struct {
	mux.Meta `path:"/v1/auth/oauth/github/authorize" method:"GET"`
	Next     string `form:"next"`
	UserCode string `form:"user_code"`
}

type GithubCallbackRequest struct {
	mux.Meta `path:"/v1/auth/oauth/github/callback" method:"GET"`
	Code     string `form:"code"  binding:"required"`
	State    string `form:"state" binding:"required"`
	Error    string `form:"error"` // GitHub 拒授权时带回
}

type LogoutRequest struct {
	mux.Meta `path:"/v1/auth/logout" method:"POST"`
}
type LogoutResponse struct{}

type MeRequest struct {
	mux.Meta `path:"/v1/auth/me" method:"GET"`
}
type MeResponse struct {
	UserID      int64  `json:"user_id"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
	GithubLogin string `json:"github_login"`
	CSRFToken   string `json:"csrf_token,omitempty"`
	DeviceID    int64  `json:"device_id,omitempty"`
}

// ListSessionsRequest 读出当前账号的全部登录会话。
type ListSessionsRequest struct {
	mux.Meta `path:"/v1/auth/sessions" method:"GET"`
}
type ListSessionsResponse struct {
	Sessions []SessionItem `json:"sessions"`
}

// SessionItem 是清单里的一条登录会话。
//
// 刻意不带 sid：sid 就是 cookie 里那枚凭据本身，发给页面等于让一条 XSS 顺走该账号
// 全部登录。清单上唯一需要区分的是「哪一条是当前」，Current 已经说清楚了。
// UserAgent 是原文，前端也原样展示——任何解析都是猜测，猜错会让用户撤销掉自己
// 正在用的那一条。
type SessionItem struct {
	UserAgent    string `json:"user_agent"`
	IP           string `json:"ip"`
	CreatedAt    int64  `json:"created_at"`
	LastActiveAt int64  `json:"last_active_at"`
	Current      bool   `json:"current"`
}

// RevokeOtherSessionsRequest 一次结束除当前会话外的全部登录。
type RevokeOtherSessionsRequest struct {
	mux.Meta `path:"/v1/auth/sessions/revoke-others" method:"POST"`
}
type RevokeOtherSessionsResponse struct {
	// Revoked 是实际撤销的条数：尽力删除，单条失败不影响其余，用户据此知道做成了几条。
	Revoked int `json:"revoked"`
}
