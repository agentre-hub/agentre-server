package release_svc

import (
	"context"
	"errors"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// fakeUpstream 记下被调用的次数，并按测试需要返回一个版本号或一次失败。
type fakeUpstream struct {
	calls   int
	version string
	err     error
}

func (f *fakeUpstream) LatestVersion(context.Context) (string, error) {
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	return f.version, nil
}

// Given 配置关闭；When 端点被问「最新版是多少」；Then 如实回「不知道」，且从不
// 触碰上游——spec 决策 12 的「可配置关闭」不是「关闭了也偷偷问一次」。
func TestLatest_ConfigDisabled_AnswersUnknownWithoutTouchingUpstream(t *testing.T) {
	mini := testutils.Redis(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	upstream := &fakeUpstream{version: "1.2.3"}
	svc := New(Config{Enabled: false, CacheTTL: time.Hour}, upstream, client)

	latest, found, err := svc.Latest(context.Background())

	require.NoError(t, err)
	assert.False(t, found, "配置关闭时必须如实回不知道")
	assert.Equal(t, Latest{}, latest)
	assert.Equal(t, 0, upstream.calls, "配置关闭时 Latest 不该问上游")
}

// Given 配置关闭；When 定时任务触发 Pull；Then 直接返回，不发出上游请求——否则
// 「关闭」这件事对 cron 无效，只对端点有效。
func TestPull_ConfigDisabled_DoesNotCallUpstream(t *testing.T) {
	mini := testutils.Redis(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	upstream := &fakeUpstream{version: "1.2.3"}
	svc := New(Config{Enabled: false, CacheTTL: time.Hour}, upstream, client)

	err := svc.Pull(context.Background())

	require.NoError(t, err)
	assert.Equal(t, 0, upstream.calls)
}

// Given 配置开启但还没有一次成功拉取过；When 端点被问；Then 如实回不知道，而不是
// 编一个「已是最新」出来（spec 决策 19）。
func TestLatest_NoSuccessfulPullYet_AnswersUnknown(t *testing.T) {
	mini := testutils.Redis(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	svc := New(Config{Enabled: true, CacheTTL: time.Hour}, &fakeUpstream{version: "1.2.3"}, client)

	latest, found, err := svc.Latest(context.Background())

	require.NoError(t, err)
	assert.False(t, found)
	assert.Equal(t, Latest{}, latest)
}

// Given 上游拉取失败；When Pull 被调用；Then 交回错误，且不覆盖缓存——随后 Latest
// 依旧如实回不知道（拉取失败与已是最新必须分得开）。
func TestPull_UpstreamFails_ReturnsErrorAndLeavesLatestUnknown(t *testing.T) {
	mini := testutils.Redis(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	upstream := &fakeUpstream{err: errors.New("upstream unreachable")}
	svc := New(Config{Enabled: true, CacheTTL: time.Hour}, upstream, client)

	err := svc.Pull(context.Background())
	require.Error(t, err)

	latest, found, latestErr := svc.Latest(context.Background())
	require.NoError(t, latestErr)
	assert.False(t, found, "拉取失败之后端点必须如实回不知道")
	assert.Equal(t, Latest{}, latest)
}

// Given 一次成功的 Pull；When 端点随后被问；Then 回缓存里的那个版本号——即便问的
// 是另一个副本（同一份 Redis），因为缓存是共享的，不是进程内的。
func TestLatest_AfterOneSuccessfulPull_ReturnsCachedVersion(t *testing.T) {
	mini := testutils.Redis(t)
	replicaA := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = replicaA.Close() })
	replicaB := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = replicaB.Close() })
	svcA := New(Config{Enabled: true, CacheTTL: time.Hour}, &fakeUpstream{version: "1.4.0"}, replicaA)
	svcB := New(Config{Enabled: true, CacheTTL: time.Hour}, &fakeUpstream{version: "9.9.9"}, replicaB)

	require.NoError(t, svcA.Pull(context.Background()))

	latest, found, err := svcB.Latest(context.Background())
	require.NoError(t, err)
	assert.True(t, found)
	assert.Equal(t, "1.4.0", latest.Version, "读到的必须是共享缓存里的那个值，不是这个副本自己的上游")
}
