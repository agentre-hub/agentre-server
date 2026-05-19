package oauth_svc

import "context"

// GithubConfig 来自 hub.oauth.github.*。
type GithubConfig struct {
	ClientID     string
	ClientSecret string
	CallbackPath string
	PublicURL    string
}

// GithubClient 抽象 GitHub OAuth 客户端，方便测试注入 fake。
type GithubClient interface {
	BuildAuthorizeURL(state string) string
	ExchangeCode(ctx context.Context, code string) (accessToken string, err error)
	FetchProfile(ctx context.Context, accessToken string) (*Profile, error)
}

type Profile struct {
	ID         int64
	Login      string
	Name       string
	AvatarURL  string
	Email      string
	Verified   bool
	RawProfile []byte
}
