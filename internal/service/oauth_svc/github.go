package oauth_svc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"agentre-server/internal/service/user_svc"
)

type githubClient struct {
	cfg  GithubConfig
	http *http.Client
}

// NewGithub 构造默认实现（10s timeout）。
func NewGithub(cfg GithubConfig) GithubClient {
	return &githubClient{cfg: cfg, http: &http.Client{Timeout: 10 * time.Second}}
}

func (c *githubClient) BuildAuthorizeURL(state string) string {
	q := url.Values{}
	q.Set("client_id", c.cfg.ClientID)
	q.Set("redirect_uri", strings.TrimRight(c.cfg.PublicURL, "/")+c.cfg.CallbackPath)
	q.Set("state", state)
	q.Set("scope", "read:user,user:email")
	return "https://github.com/login/oauth/authorize?" + q.Encode()
}

func (c *githubClient) ExchangeCode(ctx context.Context, code string) (string, error) {
	form := url.Values{}
	form.Set("client_id", c.cfg.ClientID)
	form.Set("client_secret", c.cfg.ClientSecret)
	form.Set("code", code)
	req, _ := http.NewRequestWithContext(ctx, "POST",
		"https://github.com/login/oauth/access_token", strings.NewReader(form.Encode()))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("github exchange status %d", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.AccessToken == "" {
		return "", errors.New("github exchange: empty access_token; " + body.Error)
	}
	return body.AccessToken, nil
}

type githubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

func pickPrimaryVerifiedEmail(emails []githubEmail) string {
	for _, e := range emails {
		if e.Primary && e.Verified {
			return e.Email
		}
	}
	return ""
}

func (c *githubClient) FetchProfile(ctx context.Context, accessToken string) (*Profile, error) {
	getJSON := func(u string, out interface{}) ([]byte, error) {
		req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
		req.Header.Set("Authorization", "Bearer "+accessToken)
		req.Header.Set("Accept", "application/vnd.github+json")
		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode/100 != 2 {
			return nil, fmt.Errorf("github %s status %d", u, resp.StatusCode)
		}
		raw, _ := io.ReadAll(resp.Body)
		if out != nil {
			_ = json.Unmarshal(raw, out)
		}
		return raw, nil
	}
	var user struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		AvatarURL string `json:"avatar_url"`
	}
	raw, err := getJSON("https://api.github.com/user", &user)
	if err != nil {
		return nil, err
	}

	email := user.Email
	verified := email != ""
	if email == "" {
		var emails []githubEmail
		if _, err := getJSON("https://api.github.com/user/emails", &emails); err != nil {
			return nil, err
		}
		email = pickPrimaryVerifiedEmail(emails)
		verified = email != ""
	}
	return &Profile{
		ID: user.ID, Login: user.Login, Name: user.Name, AvatarURL: user.AvatarURL,
		Email: email, Verified: verified, RawProfile: raw,
	}, nil
}

// ToGithubProfile 把 oauth_svc.Profile 转 user_svc.GithubProfile。
func ToGithubProfile(p *Profile) user_svc.GithubProfile {
	return user_svc.GithubProfile{
		GithubID:    fmt.Sprintf("%d", p.ID),
		Login:       p.Login,
		DisplayName: p.Name,
		Email:       p.Email,
		AvatarURL:   p.AvatarURL,
		RawProfile:  p.RawProfile,
	}
}

var defaultGithub GithubClient

func DefaultGithub() GithubClient     { return defaultGithub }
func SetDefaultGithub(c GithubClient) { defaultGithub = c }
