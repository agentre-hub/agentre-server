package task

import (
	"context"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/service/release_svc"
	"github.com/agentre-hub/agentre-server/internal/task/crontab"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// countingUpstream 记下自己被真正问了几次——这正是「多副本下不重复拉取」要钉住的
// 那个数字：不是「Pull 被调了几次」（两个副本各调一次是正常的），而是「上游收到了
// 几次请求」。
type countingUpstream struct{ calls int }

func (u *countingUpstream) LatestVersion(context.Context) (string, error) {
	u.calls++
	return "1.2.3", nil
}

// TestTask_PullLatestRelease_TwoReplicasProduceOneUpstreamFetch 是多副本正确性的
// 决定性用例（规格「控制台呈现与 latest 来源」第一段：「这条链路必须满足：多副本下
// 不重复拉取、缓存共享」）。
//
// 用两次独立调用同一把 withPeriodLock 包出来的 job 模拟同一周期内两个副本各跑一次：
// 生产上 task.Task 在每个副本的进程里各注册一次这个 cron func，副本之间只共享同一个
// Redis，因此这里直接复用生产代码路径（withPeriodLock + crontab.PullLatestRelease），
// 而不是重新声明一遍锁语义。
func TestTask_PullLatestRelease_TwoReplicasProduceOneUpstreamFetch(t *testing.T) {
	mini := testutils.Redis(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	upstream := &countingUpstream{}
	orig := release_svc.Release()
	release_svc.SetDefault(release_svc.New(
		release_svc.Config{Enabled: true, CacheTTL: time.Hour}, upstream, client))
	t.Cleanup(func() { release_svc.SetDefault(orig) })

	wrapped := withPeriodLock("pull_latest_release", time.Minute, crontab.PullLatestRelease)

	// 两次调用代表同一周期内两个副本各跑一次；withPeriodLock 内部的 Redis 锁是它们
	// 之间唯一的协调点。
	assert.NoError(t, wrapped(context.Background()))
	assert.NoError(t, wrapped(context.Background()))

	assert.Equal(t, 1, upstream.calls, "同一周期内两个副本只应产生一次上游请求")

	// 反证：不经过锁、直接调用同一个 job 两次，Pull 本身并不是幂等短路的——上面那个
	// 1 确实来自 withPeriodLock 的协调，不是 release_svc.Pull 自己按某种缓存把第二次
	// 变成了空操作。
	assert.NoError(t, crontab.PullLatestRelease(context.Background()))
	assert.NoError(t, crontab.PullLatestRelease(context.Background()))
	assert.Equal(t, 3, upstream.calls, "没有锁协调时，两次调用应各自问一次上游")
}
