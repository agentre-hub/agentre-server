package auth_svc

import (
	"context"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/stretchr/testify/assert"

	"agentre-server/internal/pkg/session"
)

func newSvc() AuthSvc {
	return New(session.New(redis.Default(), "server_session", 86400))
}

func TestOAuthState_Roundtrip(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	s := newSvc()
	state, err := s.CreateOAuthState(ctx, OAuthStatePayload{Next: "/device", UserCode: "A4F-7Q2", IP: "1.2.3.4"})
	assert.NoError(t, err)
	assert.NotEmpty(t, state)

	got, err := s.ConsumeOAuthState(ctx, state)
	assert.NoError(t, err)
	assert.Equal(t, "/device", got.Next)
	assert.Equal(t, "A4F-7Q2", got.UserCode)

	again, _ := s.ConsumeOAuthState(ctx, state)
	assert.Nil(t, again)
}

func TestStartSession(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	s := newSvc()
	sid, sess, err := s.StartSession(ctx, 42)
	assert.NoError(t, err)
	assert.NotEmpty(t, sid)
	assert.NotEmpty(t, sess.CSRFToken)
	assert.Equal(t, int64(42), sess.UserID)
}
