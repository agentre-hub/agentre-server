package relay_ctr_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// 账号信号并入 daemon 那条连接（决策 13）：agentred 不再单开一条信号连接
// （旧的 /v1/account/channel 已删），保留通道 relay_svc.SignalChannelID 改由服务端
// 在它的 /v1/relay/daemon 连接上主动推送——与 Client() 已经在跑的那一路对称。
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
	harness := newSignalHarnessWith(t, unavailableAccountChan{})
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)

	channelID, payload := readDaemonEnvelope(t, alpha, "订阅失败没有在 daemon 连接的保留通道上如实作答")
	require.Equal(t, relay_svc.SignalChannelID, channelID)
	require.Equal(t, relay_svc.ChannelCodeSignalUnavailable, requireChannelError(t, payload))
	closedChannel, closedFrame := readDaemonEnvelope(t, alpha, "订阅失败之后 daemon 连接上的保留通道没有随即关闭")
	require.Equal(t, relay_svc.SignalChannelID, closedChannel)
	require.Empty(t, closedFrame)

	// 连接照常服务 RPC：普通通道开得起来、帧转发得出去。
	link := harness.client(t)
	link.open(t, "c-alpha", "machine:fp-alpha")
	request := []byte{0x08, 0x01, 0x12, 0x01, 0x7f}
	link.send(t, "c-alpha", request)
	frameChannel, frame := readDaemonEnvelope(t, alpha, "信号订阅失败连坐了 daemon 连接的 RPC 转发")
	require.Equal(t, request, frame)
	require.NotEqual(t, relay_svc.SignalChannelID, frameChannel)
}
