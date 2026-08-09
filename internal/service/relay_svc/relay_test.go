package relay_svc

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
)

type fakeForwarder struct{ err error }

func (f fakeForwarder) Check(context.Context, Route) error { return f.err }

func (f fakeForwarder) Forward(context.Context, Route, Peer, string, int, []byte) error { return f.err }

func newRelayForTest(t *testing.T, forwarder Forwarder) (RelaySvc, *miniredis.Miniredis, *mock_device_repo.MockDeviceRepo) {
	t.Helper()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	controller := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(controller)
	return New(Config{InstanceID: "server-a", OnlineTTL: time.Second}, devices, client, forwarder), mini, devices
}

func activeDaemon() *device_entity.Device {
	return &device_entity.Device{
		ID: 9, UserID: 7, Kind: device_entity.KindAgentred,
		Fingerprint: "fp-daemon", Status: 1,
	}
}

func TestIsDaemonOnline(t *testing.T) {
	ctx := context.Background()
	svc, mini, _ := newRelayForTest(t, fakeForwarder{})
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"}

	// 未登记 → 离线
	online, err := svc.IsDaemonOnline(ctx, 7, "fp-daemon")
	require.NoError(t, err)
	require.False(t, online)

	// 登记（带 TTL）→ 在线
	require.NoError(t, svc.RegisterDaemon(ctx, route))
	online, err = svc.IsDaemonOnline(ctx, 7, "fp-daemon")
	require.NoError(t, err)
	require.True(t, online)

	// 过期自动消失（R20，无人续期）→ 离线
	mini.FastForward(2 * time.Second)
	online, err = svc.IsDaemonOnline(ctx, 7, "fp-daemon")
	require.NoError(t, err)
	require.False(t, online)
}

func TestRelayDaemonRegistrationExpiresAfterServerStopsRenewing(t *testing.T) {
	svc, mini, devices := newRelayForTest(t, fakeForwarder{})
	devices.EXPECT().Find(gomock.Any(), int64(9)).Return(activeDaemon(), nil)
	devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(activeDaemon(), nil).Times(2)

	route, err := svc.PrepareDaemon(context.Background(), 7, 9, device_entity.KindAgentred)
	require.NoError(t, err)
	require.Equal(t, "server-a", route.InstanceID)
	require.NoError(t, svc.RegisterDaemon(context.Background(), route))

	resolved, err := svc.ConnectClient(context.Background(), 7, "fp-daemon")
	require.NoError(t, err)
	require.Equal(t, route, resolved)

	// 模拟注册此 daemon 的 server 实例崩溃：没有任何续期，TTL 必须清除在线态。
	mini.FastForward(2 * time.Second)
	_, err = svc.ConnectClient(context.Background(), 7, "fp-daemon")
	require.ErrorIs(t, err, ErrDaemonOffline)
}

type recordedFrame struct {
	messageType int
	frame       []byte
}

type recordingFrameWriter struct{ frames chan recordedFrame }

func (w *recordingFrameWriter) WriteMessage(messageType int, frame []byte) error {
	w.frames <- recordedFrame{messageType: messageType, frame: frame}
	return nil
}

type failingFrameWriter struct{ writes chan recordedFrame }

func (w *failingFrameWriter) WriteMessage(messageType int, frame []byte) error {
	w.writes <- recordedFrame{messageType: messageType, frame: frame}
	return errors.New("relay client websocket is closed")
}

func requireRelayStreamDrained(t *testing.T, client *goredis.Client, stream string) {
	t.Helper()
	require.Eventually(t, func() bool {
		length, err := client.XLen(context.Background(), stream).Result()
		return err == nil && length == 0
	}, time.Second, 10*time.Millisecond, "relay frame remained in stream history")
	pending, err := client.XPending(context.Background(), stream, frameBusGroup).Result()
	require.NoError(t, err)
	require.Zero(t, pending.Count, "relay frame remained pending")
}

func requireNoDeliveryAck(t *testing.T, client *goredis.Client, stream string) {
	t.Helper()
	keys, err := client.Keys(context.Background(), stream+":ack:*").Result()
	require.NoError(t, err)
	require.Empty(t, keys, "undelivered relay frame received a delivery acknowledgement")
}

// 中转客户端断开时,daemon 必须收到该通道的「空载荷信封」。共享的 relay websocket
// 还开着,所以整链路的断开事件不会触发 —— 没有这个逐通道信号,daemon 侧就留下一个
// 幽灵对端:MCP 隧道(R11)会把工具请求发给一条永远不会回应的通道,调用方只能干等到
// 自己的 ctx 超时,而不是立刻拿到「发起端不在线」的语义错误。
func TestAttachClientDetachSignalsChannelCloseToDaemon(t *testing.T) {
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	forwarder := NewRedisForwarder(config, client)
	controller := gomock.NewController(t)
	svc := New(config, mock_device_repo.NewMockDeviceRepo(controller), client, forwarder)

	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}
	daemonWriter := &recordingFrameWriter{frames: make(chan recordedFrame, 4)}
	detachDaemon, err := svc.AttachDaemon(context.Background(), route, daemonWriter)
	require.NoError(t, err)
	t.Cleanup(detachDaemon)

	clientWriter := &recordingFrameWriter{frames: make(chan recordedFrame, 4)}
	channelID, detachClient, err := svc.AttachClient(context.Background(), route, clientWriter)
	require.NoError(t, err)

	detachClient()

	select {
	case received := <-daemonWriter.frames:
		gotChannel, payload, err := unwrapEnvelope(received.frame)
		require.NoError(t, err)
		require.Equal(t, channelID, gotChannel)
		require.Empty(t, payload, "通道关闭以空载荷信封表示")
	case <-time.After(time.Second):
		t.Fatal("daemon was never told the relay client channel closed")
	}
}

// PrepareDaemon 是 /v1/relay/daemon 唯一的准入判据：只有本账号名下、活跃的
// agentred 设备才能把自己登记成中转目标。没有这几条，一个 desktop 端的 device JWT
// 就能冒充计算节点占住这个账号+指纹的中继路由，或者拿别人账号下的 deviceID 登记。
// 这些守卫此前一条测试都没有，整段删掉全绿。
func TestPrepareDaemonRejectsAnythingButThisAccountsActiveAgentred(t *testing.T) {
	ctx := context.Background()

	t.Run("非 agentred 设备种类", func(t *testing.T) {
		svc, _, _ := newRelayForTest(t, fakeForwarder{})
		// kind 在读库之前就被拒，连 Find 都不该发生（devices mock 没有 EXPECT）。
		_, err := svc.PrepareDaemon(ctx, 7, 9, device_entity.KindDesktop)
		require.ErrorIs(t, err, ErrDaemonForbidden)
	})

	t.Run("deviceID 属于别的账号", func(t *testing.T) {
		svc, _, devices := newRelayForTest(t, fakeForwarder{})
		other := activeDaemon()
		other.UserID = 8 // 调用方 JWT 里的账号是 7
		devices.EXPECT().Find(gomock.Any(), int64(9)).Return(other, nil)
		_, err := svc.PrepareDaemon(ctx, 7, 9, device_entity.KindAgentred)
		require.ErrorIs(t, err, ErrDaemonForbidden)
	})

	t.Run("设备已被撤销", func(t *testing.T) {
		svc, _, devices := newRelayForTest(t, fakeForwarder{})
		revoked := activeDaemon()
		revoked.Status = 2
		devices.EXPECT().Find(gomock.Any(), int64(9)).Return(revoked, nil)
		_, err := svc.PrepareDaemon(ctx, 7, 9, device_entity.KindAgentred)
		require.ErrorIs(t, err, ErrDaemonForbidden)
	})

	t.Run("本账号活跃的 agentred 才放行", func(t *testing.T) {
		svc, _, devices := newRelayForTest(t, fakeForwarder{})
		devices.EXPECT().Find(gomock.Any(), int64(9)).Return(activeDaemon(), nil)
		route, err := svc.PrepareDaemon(ctx, 7, 9, device_entity.KindAgentred)
		require.NoError(t, err)
		require.Equal(t, Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"}, route)
	})
}

func TestUnwrapEnvelopeRejectsNonUTF8ChannelID(t *testing.T) {
	_, _, err := unwrapEnvelope([]byte{0, 1, 0xff})
	require.Error(t, err)
}

func TestRedisForwarderDeliversLocalFramesWithoutWritingAStream(t *testing.T) {
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	forwarder := NewRedisForwarder(config, client)
	attachments := forwarder.(AttachmentForwarder)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}
	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}

	detach, err := attachments.Attach(context.Background(), route, PeerDaemon, "", writer)
	require.NoError(t, err)
	t.Cleanup(detach)
	require.NoError(t, forwarder.Forward(context.Background(), route, PeerClient, "", 2, []byte("request")))

	select {
	case received := <-writer.frames:
		require.Equal(t, 2, received.messageType)
		require.Equal(t, []byte("request"), received.frame)
	case <-time.After(time.Second):
		t.Fatal("local relay frame was not delivered")
	}
	length, err := client.XLen(context.Background(), streamKey(route)).Result()
	require.NoError(t, err)
	require.Zero(t, length)
}

func TestRedisForwarderRoutesDaemonFramesByChannel(t *testing.T) {
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	forwarder := NewRedisForwarder(config, client)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-b"}
	first := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	second := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}

	firstDetach, err := forwarder.(AttachmentForwarder).Attach(context.Background(), route, PeerClient, "channel-first", first)
	require.NoError(t, err)
	t.Cleanup(firstDetach)
	secondDetach, err := forwarder.(AttachmentForwarder).Attach(context.Background(), route, PeerClient, "channel-second", second)
	require.NoError(t, err)
	t.Cleanup(secondDetach)

	require.NoError(t, forwarder.Forward(context.Background(), route, PeerDaemon, "channel-first", 2, []byte("response")))
	select {
	case received := <-first.frames:
		require.Equal(t, 2, received.messageType)
		require.Equal(t, []byte("response"), received.frame)
	case <-time.After(time.Second):
		t.Fatal("matching client channel did not receive the relay frame")
	}
	select {
	case received := <-second.frames:
		t.Fatalf("non-matching client channel received relay frame: %q", received.frame)
	case <-time.After(100 * time.Millisecond):
	}
}

// 一条投递不出去的帧不得把整条 stream 的消费卡死。
//
// 触发状态（多实例部署里的常态）：实例 B 上同时挂着 daemon D 和一个客户端 C ——
// 两者算出的 streamKey 是同一条（Attach 对 PeerClient 把 local.InstanceID 改写成
// 本实例）。D 掉线后 attachments[stream] 里还剩 C，消费 goroutine 因此**不会**被
// detach 取消；而 Redis 路由键在 OnlineTTL 内仍指向 B，实例 A 照旧把发往 daemon
// 的帧 XAdd 进这条 stream。消费者读到它、deliver 报 "no local daemon relay
// websocket"，于是 pending 置回 true —— 下一轮又只读 PEL("0")、又是同一条队头、
// 又失败，永远轮不到 ">"。发往 C 的帧从此一条也进不来（而发布方那边早在 5s 的
// deliveryWaitTimeout 就已经放弃，重试对它毫无意义）。
func TestRedisForwarderUndeliverableFrameDoesNotStallTheStream(t *testing.T) {
	mini := miniredis.RunT(t)
	clientA := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientB := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, clientA.Close()) })
	t.Cleanup(func() { require.NoError(t, clientB.Close()) })
	hook := &failFirstFrameAckTxHook{failed: make(chan struct{})}
	clientB.AddHook(hook)
	configA := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	configB := Config{InstanceID: "server-b", OnlineTTL: time.Second}
	forwarderA := NewRedisForwarder(configA, clientA)
	forwarderB := NewRedisForwarder(configB, clientB)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: configB.InstanceID}

	// B 上先有 daemon,再接一个客户端 —— 两者共用同一条 stream。
	daemonWriter := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	daemonDetach, err := forwarderB.(AttachmentForwarder).Attach(
		context.Background(), route, PeerDaemon, "", daemonWriter)
	require.NoError(t, err)
	clientWriter := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	clientDetach, err := forwarderB.(AttachmentForwarder).Attach(
		context.Background(), route, PeerClient, "channel-live", clientWriter)
	require.NoError(t, err)
	t.Cleanup(clientDetach)

	// daemon 掉线;客户端还在,所以消费 goroutine 继续跑。
	daemonDetach()

	// 实例 A 推一条发往 daemon 的帧:它在 B 上永远投递不出去。
	stalled := make(chan error, 1)
	go func() {
		stalled <- forwarderA.Forward(context.Background(), route, PeerClient, "", 2, []byte("to-dead-daemon"))
	}()
	// 给消费者时间把它读进 PEL。
	time.Sleep(200 * time.Millisecond)

	// 之后发往**客户端**的帧必须照常到达 —— 队头那条投不出去的帧不该挡住它。
	require.NoError(t, forwarderA.Forward(
		context.Background(), route, PeerDaemon, "channel-live", 2, []byte("to-live-client")))
	select {
	case received := <-clientWriter.frames:
		require.Equal(t, []byte("to-live-client"), received.frame)
	case <-time.After(2 * time.Second):
		t.Fatal("一条投递不出去的帧把整条 stream 的消费卡死了")
	}
	// 发布方仍然如实收到失败:投不出去就是投不出去,不能假装成功。
	select {
	case err := <-stalled:
		require.Error(t, err)
	case <-time.After(6 * time.Second):
		t.Fatal("undeliverable forward never returned")
	}
	select {
	case <-hook.failed:
	case <-time.After(time.Second):
		t.Fatal("undeliverable frame deletion and acknowledgement were not transacted")
	}
	requireRelayStreamDrained(t, clientB, streamKey(route))
}

func TestRedisForwarderMalformedFrameIsDeletedAndAcknowledgedWithoutDeliveryAck(t *testing.T) {
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-b", OnlineTTL: time.Second}
	forwarder := NewRedisForwarder(config, client)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}
	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	detach, err := forwarder.(AttachmentForwarder).Attach(
		context.Background(), route, PeerDaemon, "", writer)
	require.NoError(t, err)
	t.Cleanup(detach)

	stream := streamKey(route)
	ack := stream + ":ack:malformed"
	_, err = client.XAdd(context.Background(), &goredis.XAddArgs{
		Stream: stream,
		Values: map[string]any{
			"peer": "invalid", "channel": "", "type": "2", "frame": "frame", "ack": ack,
		},
	}).Result()
	require.NoError(t, err)

	requireRelayStreamDrained(t, client, stream)
	require.ErrorIs(t, client.Get(context.Background(), ack).Err(), goredis.Nil)
}

func TestRedisForwarderRemoteMissingClientTargetReturnsForwardingErrorWithoutDeliveryAck(t *testing.T) {
	mini := miniredis.RunT(t)
	clientA := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientB := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, clientA.Close()) })
	t.Cleanup(func() { require.NoError(t, clientB.Close()) })
	configA := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	configB := Config{InstanceID: "server-b", OnlineTTL: time.Second}
	forwarderA := NewRedisForwarder(configA, clientA)
	forwarderB := NewRedisForwarder(configB, clientB)
	svc := New(configA, nil, clientA, forwarderA)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: configA.InstanceID}

	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}
	detach, err := forwarderB.(AttachmentForwarder).Attach(
		context.Background(), route, PeerClient, "live-channel", writer)
	require.NoError(t, err)
	t.Cleanup(detach)

	staleChannel := "stale-remote-channel"
	require.NoError(t, clientB.Set(
		context.Background(), clientChannelKey(route, staleChannel), configB.InstanceID, time.Second,
	).Err())
	envelope, err := wrapEnvelope(staleChannel, []byte("late-response"))
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	forwardErr := svc.ForwardDaemon(ctx, route, 2, envelope)
	stream := streamKey(Route{
		AccountID: route.AccountID, Fingerprint: route.Fingerprint, InstanceID: configB.InstanceID,
	})
	requireRelayStreamDrained(t, clientB, stream)
	requireNoDeliveryAck(t, clientB, stream)
	require.ErrorIs(t, forwardErr, ErrForwardFailed)
}

func TestRedisForwarderLocalMissingClientTargetReturnsForwardingError(t *testing.T) {
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	forwarder := NewRedisForwarder(config, client)
	svc := New(config, nil, client, forwarder)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}
	channelID := "stale-local-channel"

	require.NoError(t, client.Set(
		context.Background(), clientChannelKey(route, channelID), config.InstanceID, time.Second,
	).Err())
	envelope, err := wrapEnvelope(channelID, []byte("late-response"))
	require.NoError(t, err)
	require.ErrorIs(t, svc.ForwardDaemon(context.Background(), route, 2, envelope), ErrForwardFailed)
}

// 客户端写入失败必须如实返回转发错误；若跨实例，未完成的 socket 写入不得生成
// delivery ACK。共享 daemon websocket 是否继续由 controller 的连接编排负责。
func TestRelayDaemonClientWriteFailuresReturnForwardingErrorWithoutRemoteDeliveryAck(t *testing.T) {
	for _, remote := range []bool{false, true} {
		name := "local"
		if remote {
			name = "remote"
		}
		t.Run(name, func(t *testing.T) {
			mini := miniredis.RunT(t)
			daemonRedis := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
			clientRedis := daemonRedis
			t.Cleanup(func() { require.NoError(t, daemonRedis.Close()) })

			daemonConfig := Config{InstanceID: "server-a", OnlineTTL: time.Second}
			clientConfig := daemonConfig
			if remote {
				clientConfig.InstanceID = "server-b"
				clientRedis = goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
				t.Cleanup(func() { require.NoError(t, clientRedis.Close()) })
			}
			daemonForwarder := NewRedisForwarder(daemonConfig, daemonRedis)
			clientForwarder := daemonForwarder
			if remote {
				clientForwarder = NewRedisForwarder(clientConfig, clientRedis)
			}
			svc := New(daemonConfig, nil, daemonRedis, daemonForwarder)
			route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: daemonConfig.InstanceID}
			channelID := "closing-client"
			writer := &failingFrameWriter{writes: make(chan recordedFrame, 1)}
			detach, err := clientForwarder.(AttachmentForwarder).Attach(
				context.Background(), route, PeerClient, channelID, writer)
			require.NoError(t, err)
			t.Cleanup(detach)

			envelope, err := wrapEnvelope(channelID, []byte("late-response"))
			require.NoError(t, err)
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			forwardErr := svc.ForwardDaemon(ctx, route, 2, envelope)
			received := receiveRecordedFrame(t, writer.writes)
			require.Equal(t, []byte("late-response"), received.frame)
			if remote {
				stream := streamKey(Route{
					AccountID: route.AccountID, Fingerprint: route.Fingerprint,
					InstanceID: clientConfig.InstanceID,
				})
				requireRelayStreamDrained(t, clientRedis, stream)
				requireNoDeliveryAck(t, clientRedis, stream)
			}
			require.ErrorIs(t, forwardErr, ErrForwardFailed)
		})
	}
}

func receiveRecordedFrame(t *testing.T, frames <-chan recordedFrame) recordedFrame {
	t.Helper()
	select {
	case frame := <-frames:
		return frame
	case <-time.After(time.Second):
		t.Fatal("relay client write was not attempted")
		return recordedFrame{}
	}
}

// 退避阶梯必须单调不减、且永不越过自己声明的上限 —— 它是 Redis 抖动时唯一的
// 限流手段,越限意味着恢复后可能多等一个投递窗口,不单调则说明判据写错了位置。
func TestConsumerRetryDelayIsMonotonicAndCapped(t *testing.T) {
	previous := time.Duration(0)
	for failures := range 12 {
		delay := consumerRetryDelay(failures)
		require.LessOrEqual(t, delay, time.Second,
			"failures=%d 的退避 %s 越过了 1s 上限", failures, delay)
		require.GreaterOrEqual(t, delay, previous,
			"failures=%d 的退避 %s 比上一级 %s 还短", failures, delay, previous)
		previous = delay
	}
}

// 续期命令可能已脱离被取消的 goroutine context，在另一条 Redis 连接上晚于
// detach 的 DEL 到达。清理一旦删掉 presence，任何晚到续期都只能续已有键，不能
// 把已断开的客户端重新登记一个完整 TTL。
func TestRedisForwarderLateClientPresenceRenewalCannotRecreateDetachedPresence(t *testing.T) {
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-a", OnlineTTL: 2 * time.Second}
	forwarder := NewRedisForwarder(config, client).(*redisForwarder)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: config.InstanceID}
	channelID := "channel-racing-detach"
	presence := clientChannelKey(route, channelID)
	hook := newBlockingPresenceRenewalHook(presence)
	client.AddHook(hook)

	require.NoError(t, forwarder.registerClient(context.Background(), route, channelID))
	hook.arm()
	t.Cleanup(func() {
		forwarder.unregisterClient(route, channelID)
		hook.releaseRenewal()
	})

	select {
	case <-hook.started:
	case <-time.After(3 * time.Second):
		t.Fatal("client presence renewal was not attempted")
	}
	forwarder.unregisterClient(route, channelID)
	require.ErrorIs(t, client.Get(context.Background(), presence).Err(), goredis.Nil)

	hook.releaseRenewal()
	select {
	case <-hook.finished:
	case <-time.After(time.Second):
		t.Fatal("late client presence renewal did not finish")
	}
	require.ErrorIs(t, client.Get(context.Background(), presence).Err(), goredis.Nil)
}

type blockingPresenceRenewalHook struct {
	key      string
	started  chan struct{}
	release  chan struct{}
	finished chan struct{}

	mu          sync.Mutex
	armed       bool
	blocked     bool
	releaseOnce sync.Once
}

func newBlockingPresenceRenewalHook(key string) *blockingPresenceRenewalHook {
	return &blockingPresenceRenewalHook{
		key: key, started: make(chan struct{}), release: make(chan struct{}), finished: make(chan struct{}),
	}
}

func (h *blockingPresenceRenewalHook) arm() {
	h.mu.Lock()
	h.armed = true
	h.mu.Unlock()
}

func (h *blockingPresenceRenewalHook) releaseRenewal() {
	h.releaseOnce.Do(func() { close(h.release) })
}

func (h *blockingPresenceRenewalHook) DialHook(next goredis.DialHook) goredis.DialHook {
	return next
}

func (h *blockingPresenceRenewalHook) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		if !h.shouldBlock(cmd) {
			return next(ctx, cmd)
		}
		close(h.started)
		<-h.release
		err := next(context.WithoutCancel(ctx), cmd)
		close(h.finished)
		return err
	}
}

func (h *blockingPresenceRenewalHook) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return next
}

func (h *blockingPresenceRenewalHook) shouldBlock(cmd goredis.Cmder) bool {
	args := cmd.Args()
	if len(args) < 2 || (cmd.Name() != "set" && cmd.Name() != "expire") || args[1] != h.key {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.armed || h.blocked {
		return false
	}
	h.blocked = true
	return true
}

func TestRedisForwarderClientDetachRemovesExpiringPresence(t *testing.T) {
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	config := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	forwarder := NewRedisForwarder(config, client)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-b"}
	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}

	channelID := "channel-a"
	detach, err := forwarder.(AttachmentForwarder).Attach(context.Background(), route, PeerClient, channelID, writer)
	require.NoError(t, err)
	presence := clientChannelKey(route, channelID)
	ttl, err := client.TTL(context.Background(), presence).Result()
	require.NoError(t, err)
	require.Positive(t, ttl)

	detach()
	require.ErrorIs(t, client.Get(context.Background(), presence).Err(), goredis.Nil)
}

type blockingFrameWriter struct {
	started chan struct{}
	release chan struct{}
}

func (w *blockingFrameWriter) WriteMessage(int, []byte) error {
	w.started <- struct{}{}
	<-w.release
	return nil
}

type failFirstFrameAckTxHook struct {
	once               sync.Once
	failed             chan struct{}
	requireDeliveryAck bool
}

func (h *failFirstFrameAckTxHook) DialHook(next goredis.DialHook) goredis.DialHook {
	return next
}

func (h *failFirstFrameAckTxHook) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return next
}

func (h *failFirstFrameAckTxHook) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		var hasDelete, hasGroupAck, hasDeliveryAck bool
		for _, cmd := range cmds {
			switch cmd.Name() {
			case "xdel":
				hasDelete = true
			case "xack":
				hasGroupAck = true
			case "set":
				hasDeliveryAck = true
			}
		}
		if hasDelete && hasGroupAck && (!h.requireDeliveryAck || hasDeliveryAck) {
			failed := false
			h.once.Do(func() {
				failed = true
				close(h.failed)
			})
			if failed {
				return errors.New("transient frame acknowledgement failure")
			}
		}
		return next(ctx, cmds)
	}
}

func TestRedisForwarderWaitsForRemoteDeliveryAcknowledgement(t *testing.T) {
	mini := miniredis.RunT(t)
	clientA := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientB := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, clientA.Close()) })
	t.Cleanup(func() { require.NoError(t, clientB.Close()) })
	configA := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	configB := Config{InstanceID: "server-b", OnlineTTL: time.Second}
	forwarderA := NewRedisForwarder(configA, clientA)
	forwarderB := NewRedisForwarder(configB, clientB)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: configB.InstanceID}
	writer := &blockingFrameWriter{started: make(chan struct{}, 1), release: make(chan struct{})}
	detach, err := forwarderB.(AttachmentForwarder).Attach(context.Background(), route, PeerDaemon, "", writer)
	require.NoError(t, err)
	t.Cleanup(detach)

	forwarded := make(chan error, 1)
	go func() {
		forwarded <- forwarderA.Forward(context.Background(), route, PeerClient, "", 2, []byte("request"))
	}()
	select {
	case <-writer.started:
	case <-time.After(time.Second):
		t.Fatal("remote relay frame was not delivered")
	}
	select {
	case err := <-forwarded:
		t.Fatalf("forward returned before delivery was acknowledged: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(writer.release)
	select {
	case err := <-forwarded:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("forward did not return after delivery acknowledgement")
	}
	requireRelayStreamDrained(t, clientB, streamKey(route))
}

func TestRedisForwarderRecoversPendingFrameWhenAcknowledgementTransactionFails(t *testing.T) {
	mini := miniredis.RunT(t)
	clientA := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientB := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, clientA.Close()) })
	t.Cleanup(func() { require.NoError(t, clientB.Close()) })
	hook := &failFirstFrameAckTxHook{
		failed: make(chan struct{}), requireDeliveryAck: true,
	}
	clientB.AddHook(hook)
	configA := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	configB := Config{InstanceID: "server-b", OnlineTTL: time.Second}
	forwarderA := NewRedisForwarder(configA, clientA)
	forwarderB := NewRedisForwarder(configB, clientB)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: configB.InstanceID}
	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 2)}
	detach, err := forwarderB.(AttachmentForwarder).Attach(
		context.Background(), route, PeerDaemon, "", writer)
	require.NoError(t, err)
	t.Cleanup(detach)

	forwarded := make(chan error, 1)
	go func() {
		forwarded <- forwarderA.Forward(
			context.Background(), route, PeerClient, "", 2, []byte("request"))
	}()

	for delivery := 1; delivery <= 2; delivery++ {
		select {
		case received := <-writer.frames:
			require.Equal(t, []byte("request"), received.frame)
		case <-time.After(time.Second):
			t.Fatalf("pending relay frame was not delivered for attempt %d", delivery)
		}
	}
	select {
	case <-hook.failed:
	case <-time.After(time.Second):
		t.Fatal("frame acknowledgement transaction was not attempted")
	}
	select {
	case err := <-forwarded:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("forward did not recover after the transient acknowledgement failure")
	}
	requireRelayStreamDrained(t, clientB, streamKey(route))
}

// 消费循环的生命周期是「本实例还有 websocket 附着在这条 stream 上」，由 detach
// 结束——不是「Redis 一次都没抖过」。一次瞬时 Redis 故障（主从切换 / LOADING /
// 读超时）让消费 goroutine 退出，而 f.consumers[stream] 里那条 cancel 还在，
// startConsumerLocked 因此再也不会重启它：daemon 的 websocket 还连着、Check 仍然
// 通过、客户端照常接入，但跨实例来的帧从此没有任何人消费，每一帧都只能等到 5s
// 投递超时。恢复后必须自愈。
func TestRedisForwarderConsumerRecoversFromTransientRedisFailure(t *testing.T) {
	mini := miniredis.RunT(t)
	clientA := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	clientB := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, clientA.Close()) })
	t.Cleanup(func() { require.NoError(t, clientB.Close()) })
	configA := Config{InstanceID: "server-a", OnlineTTL: time.Second}
	configB := Config{InstanceID: "server-b", OnlineTTL: time.Second}
	forwarderA := NewRedisForwarder(configA, clientA)
	forwarderB := NewRedisForwarder(configB, clientB)
	route := Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: configB.InstanceID}
	writer := &recordingFrameWriter{frames: make(chan recordedFrame, 1)}

	detach, err := forwarderB.(AttachmentForwarder).Attach(context.Background(), route, PeerDaemon, "", writer)
	require.NoError(t, err)
	t.Cleanup(detach)

	// daemon 的 websocket 全程没动过，只有 Redis 抖了一下。
	mini.SetError("LOADING Redis is loading the dataset in memory")
	time.Sleep(300 * time.Millisecond)
	mini.SetError("")

	require.NoError(t, forwarderA.Forward(context.Background(), route, PeerClient, "", 2, []byte("after-outage")))
	select {
	case received := <-writer.frames:
		require.Equal(t, []byte("after-outage"), received.frame)
	case <-time.After(2 * time.Second):
		t.Fatal("the frame-bus consumer never came back after the Redis outage")
	}
}

// Default() 是包级单例存取口：调用方（比如只装配了部分服务的测试或 handler）
// 在忘记 SetDefault() 时不该拿到 nil 接口去 panic，而应得到一个明确报错的
// 安全实现——这也是 device_svc.ListUserDevices 对在线态 fail-open 的前提。
func TestDefaultIsNeverNilWithoutRegistration(t *testing.T) {
	old := defaultSvc
	defaultSvc = nil
	t.Cleanup(func() { defaultSvc = old })

	svc := Default()
	require.NotNil(t, svc)

	online, err := svc.IsDaemonOnline(context.Background(), 7, "fp-daemon")
	require.ErrorIs(t, err, ErrRelayUnconfigured)
	require.False(t, online)
}

func TestRelayClientFailuresAreDistinguishable(t *testing.T) {
	ctx := context.Background()

	t.Run("daemon is not registered to this account", func(t *testing.T) {
		svc, _, devices := newRelayForTest(t, fakeForwarder{})
		devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-unknown").Return(nil, nil)

		_, err := svc.ConnectClient(ctx, 7, "fp-unknown")
		require.ErrorIs(t, err, ErrDaemonNotFound)
	})

	t.Run("registered daemon is offline", func(t *testing.T) {
		svc, _, devices := newRelayForTest(t, fakeForwarder{})
		devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(activeDaemon(), nil)

		_, err := svc.ConnectClient(ctx, 7, "fp-daemon")
		require.ErrorIs(t, err, ErrDaemonOffline)
	})

	t.Run("online daemon cannot be forwarded to", func(t *testing.T) {
		svc, _, devices := newRelayForTest(t, fakeForwarder{err: errors.New("frame bus unavailable")})
		devices.EXPECT().Find(gomock.Any(), int64(9)).Return(activeDaemon(), nil)
		devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(activeDaemon(), nil)
		route, err := svc.PrepareDaemon(ctx, 7, 9, device_entity.KindAgentred)
		require.NoError(t, err)
		require.NoError(t, svc.RegisterDaemon(ctx, route))

		_, err = svc.ConnectClient(ctx, 7, "fp-daemon")
		require.ErrorIs(t, err, ErrForwardFailed)
	})
}
