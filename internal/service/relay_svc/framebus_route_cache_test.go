package relay_svc

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// commandCounter 按命令名统计,好把「解析路由的那次 GET」和别的往返分开数。
type commandCounter struct {
	mu sync.Mutex
	n  map[string]int
}

func newCommandCounter() *commandCounter { return &commandCounter{n: map[string]int{}} }

func (c *commandCounter) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (c *commandCounter) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		c.mu.Lock()
		c.n[strings.ToLower(cmd.Name())]++
		c.mu.Unlock()
		return next(ctx, cmd)
	}
}

func (c *commandCounter) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		c.mu.Lock()
		for _, cmd := range cmds {
			c.n[strings.ToLower(cmd.Name())]++
		}
		c.mu.Unlock()
		return next(ctx, cmds)
	}
}

func (c *commandCounter) count(name string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n[name]
}

// localRig 起单副本形状:浏览器和 daemon 都连在同一个副本上。这是最常见的部署,
// 也是路由解析最该便宜的那一种 —— 答案永远是「就在本机」。
func localRig(t *testing.T) (*redisForwarder, *commandCounter, Route, string, func(), func()) {
	t.Helper()
	mini := miniredis.RunT(t)
	counter := newCommandCounter()
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	client.AddHook(counter)
	config := Config{InstanceID: "server-a", OnlineTTL: 30 * time.Second}
	f := NewRedisForwarder(config, client).(*redisForwarder)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}
	const channelID = "chan-1"

	ctx := context.Background()
	detachDaemon, err := f.Attach(ctx, route, PeerDaemon, "", &discardingFrameWriter{})
	require.NoError(t, err)
	detachClient, err := f.Attach(ctx, route, PeerClient, channelID, &discardingFrameWriter{})
	require.NoError(t, err)

	var once sync.Once
	dropClient := func() { once.Do(detachClient) }
	return f, counter, route, channelID, dropClient, func() {
		dropClient()
		detachDaemon()
		_ = client.Close()
	}
}

// TestForward_ClientRouteIsResolvedOncePerChannelNotPerFrame
//
// Given 一条已建立的虚拟通道;
// When  daemon 侧连着转发很多帧过来;
// Then  「这条通道的浏览器连在哪个副本」只该解析一次,而不是每帧一次 Redis GET。
//
// 这条路径由 daemon 的读循环**同步**调用:每帧一次 Redis 往返,等于把一整轮流式
// 回复的每个 token 都押在一次网络 RTT 上。而它问的东西在通道存活期间根本不会变
// —— channelID 是客户端 Open() 时随机生成的,一条通道对应一个客户端连接。
func TestForward_ClientRouteIsResolvedOncePerChannelNotPerFrame(t *testing.T) {
	f, counter, route, channelID, _, cleanup := localRig(t)
	defer cleanup()
	ctx := context.Background()

	const frames = 200
	for i := 0; i < frames; i++ {
		require.NoError(t, f.Forward(ctx, route, PeerDaemon, channelID, 2, []byte("x")))
	}

	assert.LessOrEqual(t, counter.count("get"), 1,
		"%d 帧解析了 %d 次路由:这是每帧一次 Redis 往返", frames, counter.count("get"))
}

// TestForward_StaleRouteIsReResolvedInsteadOfTrustedForever
//
// 缓存必须自愈。这里直接把一条**陈旧**的答案塞进缓存(白盒:现实里制造它需要浏览器
// 在通道存活期间换副本,而缓存的持有方是另一个副本、没人通知得到它)。
//
// 陈旧的答案投不出去。此时唯一正确的动作是清掉它、重解析一次 —— 否则「省一次往返」
// 就变成了「从此一直投错」,那是拿正确性换往返。
func TestForward_StaleRouteIsReResolvedInsteadOfTrustedForever(t *testing.T) {
	f, counter, route, _, _, cleanup := localRig(t)
	defer cleanup()
	ctx := context.Background()

	// 一条本机根本没有附着的通道,却在缓存里被记成「就在本机」。
	const ghost = "chan-gone"
	f.rememberClientRoute(clientChannelKey(route, ghost), f.instanceID)
	before := counter.count("get")

	require.NoError(t, f.Forward(ctx, route, PeerDaemon, ghost, 2, []byte("x")),
		"通道确实没了是正常情况,不该往上报错")

	assert.Equal(t, before+1, counter.count("get"),
		"投不出去之后必须重解析一次;信了陈旧缓存就再也纠不回来了")
	assert.Empty(t, f.routes[clientChannelKey(route, ghost)].instanceID,
		"陈旧条目要被清掉,不能留着继续骗下一帧")
}

// TestForward_LocalDetachDropsTheCachedRoute 浏览器就挂在本副本时,断开这一刻就该
// 把缓存清掉 —— 最常见的那条路径因此连「陈旧一次」都不会发生。
func TestForward_LocalDetachDropsTheCachedRoute(t *testing.T) {
	f, _, route, channelID, dropClient, cleanup := localRig(t)
	defer cleanup()
	ctx := context.Background()

	require.NoError(t, f.Forward(ctx, route, PeerDaemon, channelID, 2, []byte("x")))
	_, ok := f.cachedClientRoute(clientChannelKey(route, channelID))
	require.True(t, ok, "转过一帧之后路由该在缓存里")

	dropClient()

	_, ok = f.cachedClientRoute(clientChannelKey(route, channelID))
	assert.False(t, ok, "本机通道都断了,缓存不该还留着它")
}

// TestForward_CachedRouteExpires 期限是兜底:通道的持有方在**别的**副本上时,断开
// 那一刻没人通知得到这边,只能靠失败自愈与这个期限收场。
func TestForward_CachedRouteExpires(t *testing.T) {
	f, _, route, channelID, _, cleanup := localRig(t)
	defer cleanup()

	now := time.Now()
	f.now = func() time.Time { return now }
	key := clientChannelKey(route, channelID)
	f.rememberClientRoute(key, "server-elsewhere")
	_, ok := f.cachedClientRoute(key)
	require.True(t, ok)

	now = now.Add(clientRouteCacheTTL + time.Second)

	_, ok = f.cachedClientRoute(key)
	assert.False(t, ok, "过了期限就不该再用这份答案")
}
