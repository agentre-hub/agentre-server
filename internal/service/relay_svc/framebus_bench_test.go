package relay_svc

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
)

// countingHook 统计一条 redis 客户端上真正发出去的命令条数，pipeline 里的每一条
// 各算一次。中继转发的代价主要不在 CPU 而在往返次数，ns/op 单独看会把「10ms 轮询
// 一次」和「阻塞等一次」混为一谈——两者的 ns/op 可以很接近，命令数却差两个数量级。
type countingHook struct{ n atomic.Int64 }

func (h *countingHook) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (h *countingHook) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		h.n.Add(1)
		return next(ctx, cmd)
	}
}

func (h *countingHook) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		h.n.Add(int64(len(cmds)))
		return next(ctx, cmds)
	}
}

// benchForwarderPair 起两个共享同一个 miniredis 的实例：A 发布，B 持有 daemon 的
// websocket 附着并消费。这正是「浏览器落在副本 A、daemon 连在副本 B」的形状。
func benchForwarderPair(b *testing.B) (Forwarder, *countingHook, *countingHook, Route, func()) {
	b.Helper()
	mini := miniredis.RunT(b)
	publisherHook, consumerHook := &countingHook{}, &countingHook{}
	clientA := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientB := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientA.AddHook(publisherHook)
	clientB.AddHook(consumerHook)
	configA := Config{InstanceID: "server-a", OnlineTTL: 30 * time.Second}
	configB := Config{InstanceID: "server-b", OnlineTTL: 30 * time.Second}
	forwarderA := NewRedisForwarder(configA, clientA)
	forwarderB := NewRedisForwarder(configB, clientB)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: configB.InstanceID}

	writer := &discardingFrameWriter{}
	detach, err := forwarderB.(AttachmentForwarder).Attach(context.Background(), route, PeerDaemon, "", writer)
	if err != nil {
		b.Fatalf("attach daemon: %v", err)
	}
	return forwarderA, publisherHook, consumerHook, route, func() {
		detach()
		_ = clientA.Close()
		_ = clientB.Close()
	}
}

type discardingFrameWriter struct{ n atomic.Int64 }

func (w *discardingFrameWriter) WriteMessage(int, []byte) error {
	w.n.Add(1)
	return nil
}

// BenchmarkRedisForwarderCrossInstanceFrame 量的是跨副本转发一帧的完整代价。
// 这条路径由 daemon 的读循环**同步**调用，所以它的 ns/op 就是单条 daemon 连接的
// 帧吞吐上限的倒数。
func BenchmarkRedisForwarderCrossInstanceFrame(b *testing.B) {
	forwarder, publisherHook, consumerHook, route, cleanup := benchForwarderPair(b)
	defer cleanup()
	ctx := context.Background()
	frame := make([]byte, 512)

	b.ResetTimer()
	publisherHook.n.Store(0)
	consumerHook.n.Store(0)
	for range b.N {
		if err := forwarder.Forward(ctx, route, PeerClient, "", 2, frame); err != nil {
			b.Fatalf("forward: %v", err)
		}
	}
	b.StopTimer()

	perOp := func(n int64) float64 { return float64(n) / float64(b.N) }
	b.ReportMetric(perOp(publisherHook.n.Load()), "pubCmds/op")
	b.ReportMetric(perOp(consumerHook.n.Load()), "subCmds/op")
}

// BenchmarkRedisForwarderLocalFrame 是同副本投递的对照组：不碰 Redis，只有一次
// map 查找加一次 websocket 写。跨副本那条与它的差值就是帧总线本身的开销。
func BenchmarkRedisForwarderLocalFrame(b *testing.B) {
	mini := miniredis.RunT(b)
	hook := &countingHook{}
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	client.AddHook(hook)
	defer func() { _ = client.Close() }()
	config := Config{InstanceID: "server-a", OnlineTTL: 30 * time.Second}
	forwarder := NewRedisForwarder(config, client)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}
	detach, err := forwarder.(AttachmentForwarder).Attach(
		context.Background(), route, PeerDaemon, "", &discardingFrameWriter{})
	if err != nil {
		b.Fatalf("attach daemon: %v", err)
	}
	defer detach()
	ctx := context.Background()
	frame := make([]byte, 512)

	b.ResetTimer()
	hook.n.Store(0)
	for range b.N {
		if err := forwarder.Forward(ctx, route, PeerClient, "", 2, frame); err != nil {
			b.Fatalf("forward: %v", err)
		}
	}
	b.StopTimer()
	b.ReportMetric(float64(hook.n.Load())/float64(b.N), "redisCmds/op")
}

// BenchmarkRelayRenewDaemon 量的是 daemon 读循环里那次逐帧续期。它与转发是串行的，
// 所以它的代价直接叠加在上面那条 ns/op 上。
func BenchmarkRelayRenewDaemon(b *testing.B) {
	mini := miniredis.RunT(b)
	hook := &countingHook{}
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	client.AddHook(hook)
	defer func() { _ = client.Close() }()
	config := Config{InstanceID: "server-a", OnlineTTL: 30 * time.Second}
	svc := New(config, nil, client, fakeForwarder{})
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}
	ctx := context.Background()
	if err := client.Set(ctx, routeKey(route.AccountID, route.Fingerprint),
		route.InstanceID, config.OnlineTTL).Err(); err != nil {
		b.Fatalf("register: %v", err)
	}

	b.ResetTimer()
	hook.n.Store(0)
	for range b.N {
		if err := svc.RenewDaemon(ctx, route); err != nil {
			b.Fatalf("renew: %v", err)
		}
	}
	b.StopTimer()
	b.ReportMetric(float64(hook.n.Load())/float64(b.N), "redisCmds/op")
}

// BenchmarkRedisForwarderDaemonToClientFrame 量的是 daemon → 浏览器方向单帧的代价。
//
// 这个方向比反方向多一件事:要先解出「这条虚拟通道的浏览器连在哪个副本」。它由
// daemon 的读循环同步调用,所以一轮流式回复的每个 token 都要走一遍 —— redisCmds/op
// 是这里的主角,ns/op 在 miniredis 上偏乐观(真 Redis 是一次网络 RTT)。
func BenchmarkRedisForwarderDaemonToClientFrame(b *testing.B) {
	mini, err := miniredis.Run()
	if err != nil {
		b.Fatalf("miniredis: %v", err)
	}
	defer mini.Close()
	hook := &countingHook{}
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	client.AddHook(hook)
	defer func() { _ = client.Close() }()

	config := Config{InstanceID: "server-a", OnlineTTL: 30 * time.Second}
	f := NewRedisForwarder(config, client)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}
	const channelID = "bench-chan"

	ctx := context.Background()
	detachDaemon, err := f.(AttachmentForwarder).Attach(ctx, route, PeerDaemon, "", &discardingFrameWriter{})
	if err != nil {
		b.Fatalf("attach daemon: %v", err)
	}
	defer detachDaemon()
	detachClient, err := f.(AttachmentForwarder).Attach(ctx, route, PeerClient, channelID, &discardingFrameWriter{})
	if err != nil {
		b.Fatalf("attach client: %v", err)
	}
	defer detachClient()

	frame := []byte("hello")
	hook.n.Store(0)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := f.Forward(ctx, route, PeerDaemon, channelID, 2, frame); err != nil {
			b.Fatalf("forward: %v", err)
		}
	}
	b.StopTimer()
	b.ReportMetric(float64(hook.n.Load())/float64(b.N), "redisCmds/op")
}
