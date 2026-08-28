package relay_svc

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

// commandLogHook 记下一条客户端上发出的每一条命令名与首个参数,用来断言「没有
// 轮询」这种关于**调用形状**的性质——它不是任何一个返回值能表达的。
type commandLogHook struct {
	mu   sync.Mutex
	cmds [][]any
}

func (h *commandLogHook) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (h *commandLogHook) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		h.mu.Lock()
		h.cmds = append(h.cmds, cmd.Args())
		h.mu.Unlock()
		return next(ctx, cmd)
	}
}

func (h *commandLogHook) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		h.mu.Lock()
		for _, cmd := range cmds {
			h.cmds = append(h.cmds, cmd.Args())
		}
		h.mu.Unlock()
		return next(ctx, cmds)
	}
}

func (h *commandLogHook) reset() {
	h.mu.Lock()
	h.cmds = nil
	h.mu.Unlock()
}

// countMatching 数出命令名为 name、且任一参数包含 substring 的条数。
func (h *commandLogHook) countMatching(name, substring string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, args := range h.cmds {
		if len(args) == 0 {
			continue
		}
		if got, _ := args[0].(string); !strings.EqualFold(got, name) {
			continue
		}
		for _, arg := range args[1:] {
			if value, ok := arg.(string); ok && strings.Contains(value, substring) {
				n++
				break
			}
		}
	}
	return n
}

// TestRedisForwarderDoesNotPollForDeliveryAcknowledgement 钉住这条性质:等一帧的
// 投递回执**不产生任何**针对回执键的读命令。
//
// 从前的实现是 10ms 一次 GET,一帧最坏空转 500 次;而这条路径由 daemon 的读循环
// 同步调用,于是每帧的等待时间直接成了单条 daemon 连接的吞吐上限。往返次数是这里
// 真正的代价,它只能从「发出了哪些命令」上断言,断言返回值看不出区别。
func TestRedisForwarderDoesNotPollForDeliveryAcknowledgement(t *testing.T) {
	mini := miniredis.RunT(t)
	publisherLog := &commandLogHook{}
	clientA := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientB := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientA.AddHook(publisherLog)
	t.Cleanup(func() { require.NoError(t, clientA.Close()) })
	t.Cleanup(func() { require.NoError(t, clientB.Close()) })
	configA := Config{InstanceID: "server-a", OnlineTTL: 30 * time.Second}
	configB := Config{InstanceID: "server-b", OnlineTTL: 30 * time.Second}
	forwarderA := NewRedisForwarder(configA, clientA)
	forwarderB := NewRedisForwarder(configB, clientB)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: configB.InstanceID}

	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	detach, err := forwarderB.(AttachmentForwarder).Attach(context.Background(), route, PeerDaemon, "", writer)
	require.NoError(t, err)
	t.Cleanup(detach)

	require.NoError(t, forwarderA.Forward(context.Background(), route, PeerClient, "", 2, []byte("request")))
	select {
	case received := <-writer.frames:
		require.Equal(t, []byte("request"), received.frame)
	case <-time.After(2 * time.Second):
		t.Fatal("cross-instance relay frame was not delivered")
	}

	require.Zero(t, publisherLog.countMatching("get", ":ack:"),
		"投递回执不应该靠轮询等出来")
}

// TestRedisForwarderDeliveryAcknowledgementLeavesNoKeys 钉住回执用完即消失。
// 从前每帧生成一个一次性回执键、命中后不删,只靠 TTL 自然过期:1000 帧/秒时
// Redis 里常驻着几万个已经没人看的键。
func TestRedisForwarderDeliveryAcknowledgementLeavesNoKeys(t *testing.T) {
	mini := miniredis.RunT(t)
	clientA := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientB := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, clientA.Close()) })
	t.Cleanup(func() { require.NoError(t, clientB.Close()) })
	configA := Config{InstanceID: "server-a", OnlineTTL: 30 * time.Second}
	configB := Config{InstanceID: "server-b", OnlineTTL: 30 * time.Second}
	forwarderA := NewRedisForwarder(configA, clientA)
	forwarderB := NewRedisForwarder(configB, clientB)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: configB.InstanceID}

	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 4)}
	detach, err := forwarderB.(AttachmentForwarder).Attach(context.Background(), route, PeerDaemon, "", writer)
	require.NoError(t, err)
	t.Cleanup(detach)

	for range 3 {
		require.NoError(t, forwarderA.Forward(context.Background(), route, PeerClient, "", 2, []byte("request")))
		select {
		case <-writer.frames:
		case <-time.After(2 * time.Second):
			t.Fatal("cross-instance relay frame was not delivered")
		}
	}

	for _, key := range mini.Keys() {
		require.NotContains(t, key, ":ack:", "投递回执在 Redis 里留下了垃圾键")
	}
}

// TestRedisForwarderIdleConsumerDoesNotBusyPoll 钉住空闲消费循环的命令速率。
//
// 从前这条循环每轮发一条 EXPIRE 再 XREADGROUP 阻塞 100ms,于是**每条 stream 每秒
// 恒定 20 条命令**,与有没有业务流量无关。每个(账号,机器指纹,副本)只要有 websocket
// 附着就跑一条,1000 台在线机器就是 2 万条命令/秒的地板噪音。
//
// 阻塞读本身不占 Redis 的 CPU,拉长阻塞窗口不会推迟任何一帧——有帧时 XREADGROUP
// 立刻返回。所以这里断言的是「空闲时几乎不出声」。
func TestRedisForwarderIdleConsumerDoesNotBusyPoll(t *testing.T) {
	mini := miniredis.RunT(t)
	consumerLog := &commandLogHook{}
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	client.AddHook(consumerLog)
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-b", OnlineTTL: 30 * time.Second}
	forwarder := NewRedisForwarder(config, client)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}

	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	detach, err := forwarder.(AttachmentForwarder).Attach(context.Background(), route, PeerDaemon, "", writer)
	require.NoError(t, err)
	t.Cleanup(detach)

	// 让附着期的建组 / 首轮 PEL 重读安顿下来,再开始数。
	time.Sleep(300 * time.Millisecond)
	consumerLog.reset()
	const window = time.Second
	time.Sleep(window)

	stream := streamKey(route)
	require.LessOrEqual(t, consumerLog.countMatching("xreadgroup", stream), 3,
		"空闲的消费循环在轮询 stream")
	require.LessOrEqual(t, consumerLog.countMatching("expire", stream), 2,
		"空闲的消费循环在反复给 stream 续期")
}
