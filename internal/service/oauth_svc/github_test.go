package oauth_svc

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBuildAuthorizeURL(t *testing.T) {
	c := NewGithub(GithubConfig{
		ClientID:     "Iv1.test",
		CallbackPath: "/v1/auth/oauth/github/callback",
		PublicURL:    "https://server.example.com",
	})
	u := c.BuildAuthorizeURL("state-abc")
	assert.Contains(t, u, "https://github.com/login/oauth/authorize")
	assert.Contains(t, u, "client_id=Iv1.test")
	assert.Contains(t, u, "state=state-abc")
	assert.Contains(t, u, "scope=read%3Auser%2Cuser%3Aemail")
	assert.Contains(t, u, "redirect_uri=https%3A%2F%2Fserver.example.com%2Fv1%2Fauth%2Foauth%2Fgithub%2Fcallback")
}

func TestPickPrimaryVerifiedEmail(t *testing.T) {
	emails := []githubEmail{
		{Email: "a@b.com", Verified: true},
		{Email: "c@d.com", Primary: true, Verified: true},
	}
	got := pickPrimaryVerifiedEmail(emails)
	assert.Equal(t, "c@d.com", got)
}

func TestPickPrimaryVerifiedEmail_NoneVerified(t *testing.T) {
	emails := []githubEmail{{Email: "a@b.com", Primary: true}}
	assert.Equal(t, "", pickPrimaryVerifiedEmail(emails))
}
