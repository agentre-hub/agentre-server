// Package task 的锁包装单测：验证同一周期内整个副本集只跑一次、
// 没抢到锁的副本安静返回 nil、TTL 过期后下一周期正常再跑一次。
package task

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/stretchr/testify/assert"
)

// TestWithPeriodLock_SecondCallInSamePeriodSkips 是决定性用例：同一把锁在
// 同一周期内被调用两次，只有第一次真正执行 job，第二次安静跳过且不报错。
func TestWithPeriodLock_SecondCallInSamePeriodSkips(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()

	var runs int32
	job := func(context.Context) error {
		atomic.AddInt32(&runs, 1)
		return nil
	}

	wrapped := withPeriodLock("test:same_period", time.Minute, job)

	assert.NoError(t, wrapped(ctx))
	err2 := wrapped(ctx)

	assert.NoError(t, err2, "没抢到锁的副本必须返回 nil，而不是错误")
	assert.Equal(t, int32(1), atomic.LoadInt32(&runs), "job 本体在整个周期内只应该真正跑一次")
}

// TestWithPeriodLock_NextPeriodRunsAgain 验证锁过期（key 消失）后，
// 下一周期能重新抢到锁并再次执行。miniredis 的 TTL 走虚拟时钟、不随真实
// 时间流逝，testutils.Redis() 也不暴露底层实例做 FastForward，因此这里
// 直接删掉锁 key 来模拟「TTL 到期」，等价于生产环境里 TTL 自然过期后的状态。
func TestWithPeriodLock_NextPeriodRunsAgain(t *testing.T) {
	testutils.Redis()
	ctx := context.Background()

	var runs int32
	job := func(context.Context) error {
		atomic.AddInt32(&runs, 1)
		return nil
	}

	const key = "test:next_period"
	wrapped := withPeriodLock(key, time.Minute, job)

	assert.NoError(t, wrapped(ctx))
	assert.NoError(t, redis.Default().Del(ctx, fmt.Sprintf("%s:%s", lockKeyPrefix, key)).Err())
	assert.NoError(t, wrapped(ctx))

	assert.Equal(t, int32(2), atomic.LoadInt32(&runs), "锁过期后，下一周期应当重新执行")
}
