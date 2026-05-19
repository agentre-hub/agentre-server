package session

import (
	"context"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/stretchr/testify/assert"
)

func TestCreate_ReturnsSidAndCsrf(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "hub_session", 14*24*3600)

	sid, sess, err := store.Create(ctx, 42)
	assert.NoError(t, err)
	assert.NotEmpty(t, sid)
	assert.NotEmpty(t, sess.CSRFToken)
	assert.Equal(t, int64(42), sess.UserID)
}

func TestGet_RoundTrip(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "hub_session", 14*24*3600)

	sid, created, err := store.Create(ctx, 7)
	assert.NoError(t, err)

	got, err := store.Get(ctx, sid)
	assert.NoError(t, err)
	assert.Equal(t, created.UserID, got.UserID)
	assert.Equal(t, created.CSRFToken, got.CSRFToken)
}

func TestGet_Missing(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "hub_session", 14*24*3600)
	got, err := store.Get(ctx, "no-such-sid")
	assert.NoError(t, err)
	assert.Nil(t, got)
}

func TestDelete(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	store := New(redis.Default(), "hub_session", 14*24*3600)

	sid, _, _ := store.Create(ctx, 1)
	assert.NoError(t, store.Delete(ctx, sid))
	got, _ := store.Get(ctx, sid)
	assert.Nil(t, got)
}
