// Package passkey_ctr 是通行密钥的 HTTP 出入口：取会话、调 service、映射结构。
package passkey_ctr

import (
	"net/http"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/passkey"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/passkey_svc"
)

type Passkey struct {
	// insecureCookies 只在开发态为真（HTTP 本地调试），与 auth_ctr 同一个配置项。
	insecureCookies bool
}

func New(insecureCookies bool) *Passkey { return &Passkey{insecureCookies: insecureCookies} }

// BeginRegistration 取注册选项。challenge 与**当前这条浏览器会话**绑定。
func (p *Passkey) BeginRegistration(c *gin.Context, _ *api.BeginRegistrationRequest) (
	*api.BeginRegistrationResponse, error) {
	userID, sid, err := sessionOf(c)
	if err != nil {
		return nil, err
	}
	options, err := passkey_svc.Default().BeginRegistration(c.Request.Context(), userID, sid)
	if err != nil {
		return nil, err
	}
	return &api.BeginRegistrationResponse{PublicKey: options}, nil
}

// FinishRegistration 提交认证器回应，校验通过后落库。
func (p *Passkey) FinishRegistration(c *gin.Context, req *api.FinishRegistrationRequest) (
	*api.FinishRegistrationResponse, error) {
	userID, sid, err := sessionOf(c)
	if err != nil {
		return nil, err
	}
	created, err := passkey_svc.Default().FinishRegistration(c.Request.Context(), passkey_svc.FinishRegistration{
		UserID: userID, SessionID: sid, Name: req.Name, Response: req.Credential,
	})
	if err != nil {
		return nil, err
	}
	return &api.FinishRegistrationResponse{Passkey: toItem(*created)}, nil
}

// BeginLogin 取登录选项。公开端点：此刻还没有会话，请求里也没有任何标识。
func (p *Passkey) BeginLogin(c *gin.Context, _ *api.BeginLoginRequest) (
	*api.BeginLoginResponse, error) {
	options, err := passkey_svc.Default().BeginLogin(c.Request.Context())
	if err != nil {
		return nil, err
	}
	return &api.BeginLoginResponse{PublicKey: options}, nil
}

// FinishLogin 提交认证器回应；通过后建立浏览器会话并下发 cookie。
//
// 账号完全由 service 按凭证 ID 反查（并已过账号闸门），这里一个身份字段都不接受。
func (p *Passkey) FinishLogin(c *gin.Context, req *api.FinishLoginRequest) (
	*api.FinishLoginResponse, error) {
	ctx := c.Request.Context()
	userID, err := passkey_svc.Default().FinishLogin(ctx, req.Credential)
	if err != nil {
		return nil, err
	}
	sid, _, err := auth_svc.Default().StartSession(ctx, userID, session.Client{
		// 与 GitHub 回调记同样的两样东西：UA 与 IP 只有这一刻取得到，之后
		// /account 的会话清单全靠它们让用户认出自己的浏览器。
		UserAgent: c.Request.UserAgent(),
		IP:        c.ClientIP(),
	})
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	session.SetCookie(c, auth_svc.Default().CookieName(), sid, p.insecureCookies)
	return &api.FinishLoginResponse{}, nil
}

// List 列出当前账号的全部通行密钥。
func (p *Passkey) List(c *gin.Context, _ *api.ListRequest) (*api.ListResponse, error) {
	userID, _, err := sessionOf(c)
	if err != nil {
		return nil, err
	}
	list, err := passkey_svc.Default().List(c.Request.Context(), userID)
	if err != nil {
		return nil, err
	}
	// 预分配成空切片而不是 nil：空账号要序列化成 []，不是 null。
	items := make([]api.PasskeyItem, 0, len(list))
	for _, it := range list {
		items = append(items, toItem(it))
	}
	return &api.ListResponse{Passkeys: items}, nil
}

// Delete 删掉一把。删到零把也照常允许。
func (p *Passkey) Delete(c *gin.Context, req *api.DeleteRequest) (*api.DeleteResponse, error) {
	userID, _, err := sessionOf(c)
	if err != nil {
		return nil, err
	}
	// user_id 取自会话：删除范围完全由 cookie 圈定，路径里那个 id 只说明删哪一把。
	if err := passkey_svc.Default().Delete(c.Request.Context(), userID, req.ID); err != nil {
		return nil, err
	}
	return &api.DeleteResponse{}, nil
}

// sessionOf 取中间件放进上下文的账号 id，以及 cookie 里的会话标识。
//
// SessionAuth 已经保证两者都在，这里只是不让一个装配错误静默地变成「操作别人的密钥」
// 或者「challenge 落在一条空会话上」。
func sessionOf(c *gin.Context) (int64, string, error) {
	userID := ginctx.UserID(c)
	sid, _ := c.Cookie(auth_svc.Default().CookieName())
	if userID == 0 || sid == "" {
		return 0, "", i18n.NewErrorWithStatus(c.Request.Context(), http.StatusUnauthorized, code.Unauthorized)
	}
	return userID, sid, nil
}

func toItem(in passkey_svc.Passkey) api.PasskeyItem {
	return api.PasskeyItem{
		ID: in.ID, Name: in.Name, CreatedAt: in.CreatedAt, LastUsedAt: in.LastUsedAt,
	}
}
