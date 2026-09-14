package relay_ctr_test

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// 账号信号走 daemon 那条连接（决策 13）：agentred 不单开信号连接，保留通道
// relay_svc.SignalChannelID 由服务端在它的 /v1/relay/daemon 连接上主动推送——与
// Client() 那一路对称。
//
// 这是补上的回归（T9 note）：Daemon() 从前只订阅设备归属，从不订阅账号信号，一台
// 在线 agentred 因此只能靠下一次中继重连才刷新引擎快照。
func TestRelayDaemon_GivenAnAccountBroadcast_ThenItArrivesOnTheReservedChannel(t *testing.T) {
	harness := newSignalHarness(t)
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)

	for _, frame := range []accountchan_svc.Frame{
		{Type: accountchan_svc.FrameTypeSyncVersion, Version: 42},
		{Type: accountchan_svc.FrameTypeMirrorChanged},
		{Type: accountchan_svc.FrameTypeDevicePresence},
	} {
		require.NoError(t, harness.accountChan.Broadcast(context.Background(), 7, frame))
		channelID, payload := readDaemonEnvelope(t, alpha, "账号信号没有从 daemon 连接的保留通道抵达")
		require.Equal(t, relay_svc.SignalChannelID, channelID)
		method, version := decodeAccountNotification(t, payload)
		require.Equal(t, accountNotificationMethod(frame.Type), method)
		require.Equal(t, frame.Version, version)
	}
}

// 订阅建不起来时按通道级降级作答，不牵连 daemon 那条连接的 RPC 转发——与
// Client() 的 TestRelayClient_GivenTheSignalSubscriptionFails_ThenOnlyTheSignalChannelDegrades
// 对称（Hard invariant 5：变的只有它跑在哪条 socket 上）。
func TestRelayDaemon_GivenTheSignalSubscriptionFails_ThenRPCForwardingStillWorks(t *testing.T) {
	svc := newDaemonForwardingRelayStub()
	server := newRelayServerWithAccountChan(t, svc, unavailableAccountChan{})
	alpha := dialRelayDaemon(t, server, deviceToken(7, 9, device_entity.KindAgentred))

	channelID, payload := readDaemonEnvelope(t, alpha, "订阅失败没有在 daemon 连接的保留通道上如实作答")
	require.Equal(t, relay_svc.SignalChannelID, channelID)
	require.Equal(t, relay_svc.ChannelCodeSignalUnavailable, requireChannelError(t, payload))
	closedChannel, closedFrame := readDaemonEnvelope(t, alpha, "订阅失败之后 daemon 连接上的保留通道没有随即关闭")
	require.Equal(t, relay_svc.SignalChannelID, closedChannel)
	require.Empty(t, closedFrame)

	// 连接照常服务 RPC：普通通道开得起来、帧转发得出去。
	client, response, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/client"),
		http.Header{"Authorization": {"Bearer " + deviceToken(7, 4, device_entity.KindDesktop)}})
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Close() })
	link := newClientLink(client)
	link.open(t, "c-alpha", "machine:fp-alpha")
	request := []byte{0x08, 0x01, 0x12, 0x01, 0x7f}
	link.send(t, "c-alpha", request)
	frameChannel, frame := readDaemonEnvelope(t, alpha, "信号订阅失败连坐了 daemon 连接的 RPC 转发")
	require.Equal(t, request, frame)
	require.NotEqual(t, relay_svc.SignalChannelID, frameChannel)
}

// daemonForwardingRelayStub 只实现这个控制器用例需要的帧转发边界。账号信号失败
// 与 Redis 在线态、跨副本帧总线无关，因此这里不启动 miniredis；真实 websocket
// 仍由 httptest server 驱动，mock 只替代 RelaySvc。
type daemonForwardingRelayStub struct {
	*relayStub

	mu           sync.Mutex
	daemonWriter relay_svc.FrameWriter
}

func newDaemonForwardingRelayStub() *daemonForwardingRelayStub {
	return &daemonForwardingRelayStub{relayStub: newForwardingRelayStub()}
}

func (s *daemonForwardingRelayStub) AttachDaemon(
	_ context.Context, _ relay_svc.Route, writer relay_svc.FrameWriter,
) (func(), error) {
	s.mu.Lock()
	s.daemonWriter = writer
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		s.daemonWriter = nil
		s.mu.Unlock()
	}, nil
}

func (s *daemonForwardingRelayStub) ForwardClient(
	_ context.Context, _ relay_svc.Route, channelID string, messageType int, frame []byte,
) error {
	s.mu.Lock()
	writer := s.daemonWriter
	s.mu.Unlock()
	if writer == nil {
		return errors.New("daemon is not attached")
	}
	envelope, err := relay_svc.WrapEnvelope(channelID, frame)
	if err != nil {
		return err
	}
	return writer.WriteMessage(messageType, envelope)
}

var _ relay_svc.RelaySvc = (*daemonForwardingRelayStub)(nil)
