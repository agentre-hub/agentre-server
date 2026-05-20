package auth_ctr

import (
	"net/http"
	"strings"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	api "agentre-hub/internal/api/auth"
	"agentre-hub/internal/pkg/code"
	"agentre-hub/internal/service/auth_svc"
	"agentre-hub/internal/service/oauth_svc"
	"agentre-hub/internal/service/user_svc"
)

type Auth struct{}

func NewAuth() *Auth { return &Auth{} }

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
		return i18n.NewInternalError(ctx, code.ServerError)
	}
	sid, _, err := auth_svc.Default().StartSession(ctx, u.ID)
	if err != nil {
		return i18n.NewInternalError(ctx, code.ServerError)
	}
	setSessionCookie(c, auth_svc.Default().CookieName(), sid)

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
	clearSessionCookie(c, auth_svc.Default().CookieName())
	return &api.LogoutResponse{}, nil
}

func (a *Auth) Me(c *gin.Context, _ *api.MeRequest) (*api.MeResponse, error) {
	ctx := c.Request.Context()
	uid, _ := c.Get("user_id")
	userID, _ := uid.(int64)
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
	if csrf, ok := c.Get("csrf_token"); ok {
		if s, ok := csrf.(string); ok {
			resp.CSRFToken = s
		}
	}
	if did, ok := c.Get("device_id"); ok {
		if d, ok := did.(int64); ok && d != 0 {
			resp.DeviceID = d
		}
	}
	return resp, nil
}

// ---- cookie helpers ----

func setSessionCookie(c *gin.Context, name, value string) {
	insecure := c.GetBool("hub_insecure_cookies")
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(name, value, 14*24*3600, "/", "", !insecure, true)
}

func clearSessionCookie(c *gin.Context, name string) {
	c.SetCookie(name, "", -1, "/", "", false, true)
}
