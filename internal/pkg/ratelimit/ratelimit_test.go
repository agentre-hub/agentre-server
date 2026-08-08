package ratelimit

import (
	"context"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/stretchr/testify/assert"
)

func TestAllow_UnderLimit(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	l := New(redis.Default(), "rl:test:", 3, time.Minute)

	for i := 0; i < 3; i++ {
		ok, err := l.Allow(ctx, "ip-1")
		assert.NoError(t, err)
		assert.True(t, ok, "iter %d should be allowed", i)
	}
}

func TestAllow_OverLimitDenied(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	l := New(redis.Default(), "rl:test:", 2, time.Minute)
	_, _ = l.Allow(ctx, "ip-x")
	_, _ = l.Allow(ctx, "ip-x")
	ok, err := l.Allow(ctx, "ip-x")
	assert.NoError(t, err)
	assert.False(t, ok)
}

func TestAllow_IsolatedByKey(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()
	l := New(redis.Default(), "rl:test:", 1, time.Minute)
	ok1, _ := l.Allow(ctx, "a")
	ok2, _ := l.Allow(ctx, "b")
	assert.True(t, ok1)
	assert.True(t, ok2)
}
