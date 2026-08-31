package relay_svc

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

/*
	daemon 那条链路上的转发**不能**跑在读循环上。

	读循环此前是「读一帧 → 同步转发 → 才读下一帧」。而转发在跨副本时要等一次 Redis
	投递回执(最坏一个投递超时),于是一台机器上**所有会话的每一个 token** 都排在同
	一条队里:A 会话慢一下,B 会话跟着停。

	改成按虚拟通道分派之后,通道之间彼此独立;通道**之内**仍然单线程,所以保序。
*/

// blockingForwarder 让指定通道的转发卡住，其余通道照常。
type blockingForwarder struct {
	blockChannel string
	entered      chan struct{}
	release      chan struct{}

	mu   sync.Mutex
	seen map[string][][]byte
}

func newBlockingForwarder(blockChannel string) *blockingForwarder {
	return &blockingForwarder{
		blockChannel: blockChannel,
		entered:      make(chan struct{}, 1),
		release:      make(chan struct{}),
		seen:         map[string][][]byte{},
	}
}

func (f *blockingForwarder) Check(context.Context, Route) error { return nil }

// 分派器的生命周期挂在 AttachDaemon 上，所以假 forwarder 也要支持附着。
func (f *blockingForwarder) Attach(
	context.Context, Route, Peer, string, FrameWriter,
) (func(), error) {
	return func() {}, nil
}

func (f *blockingForwarder) Forward(
	_ context.Context, _ Route, _ Peer, channelID string, _ int, frame []byte,
) error {
	if channelID == f.blockChannel {
		select {
		case f.entered <- struct{}{}:
		default:
		}
		// 阻塞设上界:转发要是**又**变回同步的,用例该当场失败,而不是把整个包挂到
		// go test 的超时上 —— 那种红对排查毫无帮助。
		select {
		case <-f.release:
		case <-time.After(3 * time.Second):
		}
	}
	f.mu.Lock()
	f.seen[channelID] = append(f.seen[channelID], append([]byte(nil), frame...))
	f.mu.Unlock()
	return nil
}

func (f *blockingForwarder) framesFor(channelID string) [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte(nil), f.seen[channelID]...)
}

func daemonRouteForTest() Route {
	return Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"}
}

// 一条卡住的通道不再拖住同一条 daemon 链路上的其它通道。
func TestForwardDaemon_GivenOneStalledChannel_ThenOtherChannelsKeepFlowing(t *testing.T) {
	forwarder := newBlockingForwarder("stalled")
	svc, _, _ := newRelayForTest(t, forwarder)
	ctx := context.Background()
	route := daemonRouteForTest()

	detach, err := svc.AttachDaemon(ctx, route, &discardingFrameWriter{})
	require.NoError(t, err)
	t.Cleanup(detach)
	t.Cleanup(func() { close(forwarder.release) })

	require.NoError(t, svc.ForwardDaemon(ctx, route, websocket.BinaryMessage,
		daemonEnvelope("stalled", []byte("first"))))
	<-forwarder.entered

	require.NoError(t, svc.ForwardDaemon(ctx, route, websocket.BinaryMessage,
		daemonEnvelope("healthy", []byte("second"))))

	require.Eventually(t, func() bool { return len(forwarder.framesFor("healthy")) == 1 },
		2*time.Second, 10*time.Millisecond,
		"卡住的那条通道不该拦住同一条链路上别的通道")
}

// ForwardDaemon 只入队,不等转发完成 —— 否则「摘下读循环」就没有发生。
func TestForwardDaemon_ReturnsWithoutWaitingForTheForward(t *testing.T) {
	forwarder := newBlockingForwarder("stalled")
	svc, _, _ := newRelayForTest(t, forwarder)
	ctx := context.Background()
	route := daemonRouteForTest()

	detach, err := svc.AttachDaemon(ctx, route, &discardingFrameWriter{})
	require.NoError(t, err)
	t.Cleanup(detach)
	t.Cleanup(func() { close(forwarder.release) })

	done := make(chan struct{})
	go func() {
		defer close(done)
		for range 8 {
			_ = svc.ForwardDaemon(ctx, route, websocket.BinaryMessage,
				daemonEnvelope("stalled", []byte("x")))
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ForwardDaemon 仍然在等转发完成:读循环还是被同步阻塞着")
	}
}

// 通道**之内**必须保序:分派解的是通道之间的队头阻塞,不是把一条会话的帧打乱。
func TestForwardDaemon_PreservesOrderWithinAChannel(t *testing.T) {
	forwarder := newBlockingForwarder("none")
	svc, _, _ := newRelayForTest(t, forwarder)
	ctx := context.Background()
	route := daemonRouteForTest()

	detach, err := svc.AttachDaemon(ctx, route, &discardingFrameWriter{})
	require.NoError(t, err)
	t.Cleanup(detach)
	t.Cleanup(func() { close(forwarder.release) })

	const frames = 64
	for i := range frames {
		require.NoError(t, svc.ForwardDaemon(ctx, route, websocket.BinaryMessage,
			daemonEnvelope("ordered", []byte{byte(i)})))
	}

	require.Eventually(t, func() bool { return len(forwarder.framesFor("ordered")) == frames },
		2*time.Second, 10*time.Millisecond)
	for i, frame := range forwarder.framesFor("ordered") {
		require.Equal(t, []byte{byte(i)}, frame, "第 %d 帧乱序了", i)
	}
}

// 摘掉 daemon 连接之后，分派器要收工，不留下永远跑着的 worker。
func TestForwardDaemon_DetachStopsDispatchingAndRejectsLaterFrames(t *testing.T) {
	forwarder := newBlockingForwarder("none")
	svc, _, _ := newRelayForTest(t, forwarder)
	ctx := context.Background()
	route := daemonRouteForTest()

	detach, err := svc.AttachDaemon(ctx, route, &discardingFrameWriter{})
	require.NoError(t, err)
	t.Cleanup(func() { close(forwarder.release) })

	require.NoError(t, svc.ForwardDaemon(ctx, route, websocket.BinaryMessage,
		daemonEnvelope("c1", []byte("before"))))
	require.Eventually(t, func() bool { return len(forwarder.framesFor("c1")) == 1 },
		2*time.Second, 10*time.Millisecond)

	detach()

	assert.Error(t, svc.ForwardDaemon(ctx, route, websocket.BinaryMessage,
		daemonEnvelope("c1", []byte("after"))),
		"连接都摘了,还收帧就是在给一条不存在的链路排队")
}

// 信封解不开是协议违例，不是转发失败：它必须**同步**报上去，让控制器拆掉这条链路。
func TestForwardDaemon_MalformedEnvelopeStillFailsSynchronously(t *testing.T) {
	forwarder := newBlockingForwarder("none")
	svc, _, _ := newRelayForTest(t, forwarder)
	ctx := context.Background()
	route := daemonRouteForTest()

	detach, err := svc.AttachDaemon(ctx, route, &discardingFrameWriter{})
	require.NoError(t, err)
	t.Cleanup(detach)
	t.Cleanup(func() { close(forwarder.release) })

	assert.Error(t, svc.ForwardDaemon(ctx, route, websocket.BinaryMessage, []byte{0x00}))
}

func daemonEnvelope(channelID string, frame []byte) []byte {
	envelope, err := wrapEnvelope(channelID, frame)
	if err != nil {
		panic(err)
	}
	return envelope
}
