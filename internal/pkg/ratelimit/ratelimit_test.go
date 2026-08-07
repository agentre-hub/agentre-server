package ratelimit

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
)

// commandRecorder 是一个 go-redis hook，记录实际下发的顶层命令名，
// 用来断言「计数自增与首次过期是否合成了一条脚本调用」。
type commandRecorder struct {
	mu   sync.Mutex
	cmds []string
}

func (r *commandRecorder) DialHook(next goredis.DialHook) goredis.DialHook {
	return next
}

func (r *commandRecorder) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		r.mu.Lock()
		r.cmds = append(r.cmds, cmd.Name())
		r.mu.Unlock()
		return next(ctx, cmd)
	}
}

func (r *commandRecorder) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return next
}

func (r *commandRecorder) names() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.cmds...)
}

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

// TestAllow_FirstCallSetsTTLAtomically 是本任务的 deciding RED 测试：
// 计数自增与首次过期必须在同一条命令里落地，Redis 层面不存在
// 「计数已写、TTL 还没设上」的中间态。
func TestAllow_FirstCallSetsTTLAtomically(t *testing.T) {
	testutils.Redis()
	rc := redis.Default()
	rec := &commandRecorder{}
	rc.AddHook(rec)
	ctx := context.Background()
	l := New(rc, "rl:test:", 3, time.Minute)

	key := "ip-atomic"
	ok, err := l.Allow(ctx, key)
	assert.NoError(t, err)
	assert.True(t, ok)

	ttl, err := rc.PTTL(ctx, "rl:test:"+key).Result()
	assert.NoError(t, err)
	assert.Greater(t, ttl, time.Duration(0), "计数 key 必须在首次自增时就带上 TTL")

	for _, name := range rec.names() {
		assert.NotEqual(t, "expire", name, "不应下发独立的 expire 命令")
		assert.NotEqual(t, "pexpire", name, "不应下发独立的 pexpire 命令")
	}
}
