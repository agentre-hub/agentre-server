package auth_ctr

import (
	"errors"
	"net/http"
	"strings"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/auth"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/oauth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

type Auth struct {
	insecureCookies bool
}

func NewAuth(insecureCookies bool) *Auth { return &Auth{insecureCookies: insecureCookies} }

// safeNext 仅允许相对路径或同源；其它视作不合法返回 "/".
func safeNext(in string) string {
	if in == "" {
		return "/"
	}
	if strings.HasPrefix(in, "/") && !strings.HasPrefix(in, "//") {
		return in
	}
	return "/"
}

func (a *Auth) GithubAuthorize(c *gin.Context, req *api.GithubAuthorizeRequest) error {
	state, err := auth_svc.Default().CreateOAuthState(c.Request.Context(), auth_svc.OAuthStatePayload{
		Next: safeNext(req.Next), UserCode: req.UserCode, IP: c.ClientIP(),
	})
	if err != nil {
		return i18n.NewInternalError(c.Request.Context(), code.OAuthExchangeFailed)
	}
	url := oauth_svc.DefaultGithub().BuildAuthorizeURL(state)
	c.Redirect(http.StatusFound, url)
	return nil
}

func (a *Auth) GithubCallback(c *gin.Context, req *api.GithubCallbackRequest) error {
	ctx := c.Request.Context()

	payload, err := auth_svc.Default().ConsumeOAuthState(ctx, req.State)
	if err != nil || payload == nil {
		c.Redirect(http.StatusFound, "/login?err=oauth_state_invalid")
		return nil
	}
	if req.Error == "access_denied" {
		c.Redirect(http.StatusFound, "/login?err=access_denied")
		return nil
	}
	accessTok, err := oauth_svc.DefaultGithub().ExchangeCode(ctx, req.Code)
	if err != nil {
		c.Redirect(http.StatusFound, "/login?err=oauth_exchange_failed")
		return nil
	}
	profile, err := oauth_svc.DefaultGithub().FetchProfile(ctx, accessTok)
	if err != nil {
		c.Redirect(http.StatusFound, "/login?err=oauth_profile_failed")
		return nil
	}
	if profile.Email == "" {
		c.Redirect(http.StatusFound, "/login?err=github_email_missing")
		return nil
	}
	u, err := user_svc.User().FindOrCreateFromGithub(ctx, oauth_svc.ToGithubProfile(profile))
	if err != nil {
		// identity 存在但账号不可用（被封禁）是这条路径的常态，不是基础设施故障：
		// user_svc 在这种情形下返回 user_entity.Check 产出的成形错误，这里把它变成一次
		// 重定向而不是 500——同时也是不让调用方继续往下对 nil 账号解引用 u.ID 的关键。
		// 其它错误（真正的 DB/identity 查询故障）性质不同，仍按 500 处理。
		if target, ok := githubAccountErrRedirect(err); ok {
			c.Redirect(http.StatusFound, target)
			return nil
		}
		return i18n.NewInternalError(ctx, code.ServerError)
	}
	sid, _, err := auth_svc.Default().StartSession(ctx, u.ID, session.Client{
		// UA 与 IP 只有这一刻取得到，之后会话清单全靠它们让用户认出自己的浏览器。
		UserAgent: c.Request.UserAgent(),
		IP:        c.ClientIP(),
	})
	if err != nil {
		return i18n.NewInternalError(ctx, code.ServerError)
	}
	session.SetCookie(c, auth_svc.Default().CookieName(), sid, a.insecureCookies)

	target := safeNext(payload.Next)
	if payload.UserCode != "" {
		sep := "?"
		if strings.Contains(target, "?") {
			sep = "&"
		}
		target += sep + "user_code=" + payload.UserCode
	}
	c.Redirect(http.StatusFound, target)
	return nil
}

func (a *Auth) Logout(c *gin.Context, _ *api.LogoutRequest) (*api.LogoutResponse, error) {
	sid, _ := c.Cookie(auth_svc.Default().CookieName())
	if sid != "" {
		_ = auth_svc.Default().EndSession(c.Request.Context(), sid)
	}
	session.ClearCookie(c, auth_svc.Default().CookieName())
	return &api.LogoutResponse{}, nil
}

// ListSessions 列出当前账号的全部登录会话，并标出请求自己所在的那一条。
func (a *Auth) ListSessions(c *gin.Context, _ *api.ListSessionsRequest) (*api.ListSessionsResponse, error) {
	ctx := c.Request.Context()
	userID, err := a.sessionUserID(c)
	if err != nil {
		return nil, err
	}
	list, err := auth_svc.Default().ListSessions(ctx, userID)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	current, _ := c.Cookie(auth_svc.Default().CookieName())
	items := make([]api.SessionItem, 0, len(list))
	for _, info := range list {
		items = append(items, api.SessionItem{
			UserAgent:    info.UserAgent,
			IP:           info.IP,
			CreatedAt:    info.CreatedAt,
			LastActiveAt: info.LastActiveAt,
			Current:      info.SID == current,
		})
	}
	return &api.ListSessionsResponse{Sessions: items}, nil
}

// RevokeOtherSessions 结束除当前会话外的全部登录，返回实际撤销的条数。
func (a *Auth) RevokeOtherSessions(c *gin.Context, _ *api.RevokeOtherSessionsRequest) (
	*api.RevokeOtherSessionsResponse, error) {
	ctx := c.Request.Context()
	userID, err := a.sessionUserID(c)
	if err != nil {
		return nil, err
	}
	current, _ := c.Cookie(auth_svc.Default().CookieName())
	revoked, err := auth_svc.Default().EndOtherSessions(ctx, userID, current)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return &api.RevokeOtherSessionsResponse{Revoked: revoked}, nil
}

// sessionUserID 取中间件放进上下文的账号 id。SessionAuth 已经保证它在，这里只是
// 不让一个装配错误静默地变成「操作别人的会话」。
func (a *Auth) sessionUserID(c *gin.Context) (int64, error) {
	userID := ginctx.UserID(c)
	if userID == 0 {
		return 0, i18n.NewErrorWithStatus(c.Request.Context(), http.StatusUnauthorized, code.Unauthorized)
	}
	return userID, nil
}

func (a *Auth) Me(c *gin.Context, _ *api.MeRequest) (*api.MeResponse, error) {
	ctx := c.Request.Context()
	userID := ginctx.UserID(c)
	if userID == 0 {
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusUnauthorized, code.Unauthorized)
	}
	u, err := user_svc.User().Find(ctx, userID)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	if u == nil {
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusUnauthorized, code.UserNotFound)
	}
	resp := &api.MeResponse{
		UserID:      u.ID,
		Email:       u.Email,
		DisplayName: u.DisplayName,
		AvatarURL:   u.AvatarURL,
	}

	// 填充 github_login。读不到就留空：一个附属字段不该让整个 /me 挂掉。
	if login, err := user_svc.User().GithubLogin(ctx, userID); err == nil {
		resp.GithubLogin = login
	}

	resp.CSRFToken = ginctx.CSRFToken(c)
	resp.DeviceID = ginctx.DeviceID(c)
	return resp, nil
}

// githubAccountErrRedirect 把 user_svc.FindOrCreateFromGithub 在「identity 存在、账号
// 不可用」路径上返回的 user_entity.Check 错误映射成 /login?err= 重定向目标。只认得
// UserBanned；其它错误（包括理论上的 UserNotFound——账号行本身缺失，当前没有账号删除
// 功能所以不可达——以及真正的基础设施故障）都不在这里处理，ok 返回 false 交给调用方
// 按 500 处理。
func githubAccountErrRedirect(err error) (string, bool) {
	var he *httputils.Error
	if !errors.As(err, &he) || he.Code != code.UserBanned {
		return "", false
	}
	return "/login?err=user_banned", true
}
