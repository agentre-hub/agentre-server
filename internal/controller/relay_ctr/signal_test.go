package relay_ctr_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// 账号信号并入同一条中继连接（决策 13）：浏览器与桌面端不再单开一条信号连接，
// 信号从保留通道（决策 14）抵达，与普通通道共用这一条 socket。
func TestRelayClient_GivenAnAccountBroadcast_ThenItArrivesOnTheReservedChannel(t *testing.T) {
	harness := newSignalHarness(t)
	link := harness.client(t)

	for _, frame := range []accountchan_svc.Frame{
		{Type: accountchan_svc.FrameTypeSyncVersion, Version: 42},
		{Type: accountchan_svc.FrameTypeMirrorChanged},
		{Type: accountchan_svc.FrameTypeDevicePresence},
	} {
		require.NoError(t, harness.accountChan.Broadcast(context.Background(), 7, frame))
		method, version := decodeAccountNotification(t,
			link.next(t, relay_svc.SignalChannelID, "账号信号没有从保留通道抵达"))
		require.Equal(t, accountNotificationMethod(frame.Type), method)
		require.Equal(t, frame.Version, version)
	}
}

// 通道是账号级且跨副本的：同一个账号连在两个副本上的两条中继连接都要收到任一
// 副本发出的那一次广播，而别的账号一条都收不到。
func TestRelayClient_GivenTwoReplicas_ThenOneBroadcastReachesBothAndOnlyThatAccount(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	mini := miniredis.RunT(t)
	signer := newSignalSigner(t)
	replicaA := accountchan_svc.New(newRelayRedisClient(t, mini))
	replicaB := accountchan_svc.New(newRelayRedisClient(t, mini))
	serverA := newRelayServerWithAccountChan(t, signer, newForwardingRelayStub(), replicaA)
	serverB := newRelayServerWithAccountChan(t, signer, newForwardingRelayStub(), replicaB)

	onA := dialSignalClient(t, serverA, signalToken(t, signer, 7, 9))
	onB := dialSignalClient(t, serverB, signalToken(t, signer, 7, 10))
	otherAccount := dialSignalClient(t, serverB, signalToken(t, signer, 8, 11))

	require.NoError(t, replicaA.Broadcast(context.Background(), 7,
		accountchan_svc.Frame{Type: accountchan_svc.FrameTypeSyncVersion, Version: 42}))

	for _, link := range []*clientLink{onA, onB} {
		_, version := decodeAccountNotification(t,
			link.next(t, relay_svc.SignalChannelID, "同账号在另一个副本上的连接没收到信号"))
		require.Equal(t, int64(42), version)
	}
	otherAccount.requireQuiet(t, relay_svc.SignalChannelID, "另一个账号收到了不属于它的信号")
}

// 订阅建不起来时按**通道级**错误作答：整条连接照常服务 RPC，只有信号那一路退化。
// 合并之前这里是 upgrade 前的 HTTP 503——那时一条连接只有信号一件事，现在它上面
// 还跑着别人的 RPC 通道，为一个「尽力而为、可丢弃」的订阅杀掉全部 RPC 是不成立的。
func TestRelayClient_GivenTheSignalSubscriptionFails_ThenOnlyTheSignalChannelDegrades(t *testing.T) {
	harness := newSignalHarnessWith(t, unavailableAccountChan{})
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)
	link := harness.client(t)

	require.Equal(t, relay_svc.ChannelCodeSignalUnavailable, requireChannelError(t,
		link.next(t, relay_svc.SignalChannelID, "订阅失败没有在保留通道上如实作答")))

	// 连接照常服务 RPC：普通通道开得起来、帧转发得出去。
	link.open(t, "c-alpha", "machine:fp-alpha")
	request := []byte{0x08, 0x01, 0x12, 0x01, 0x7f}
	link.send(t, "c-alpha", request)
	_, frame := readDaemonEnvelope(t, alpha, "信号订阅失败连坐了同一条连接上的 RPC")
	require.Equal(t, request, frame)
}

// 保留通道只出不进：客户端往它写任何东西都按协议错误处理。
func TestRelayClient_GivenTheClientWritesToTheReservedChannel_ThenItIsAProtocolError(t *testing.T) {
	harness := newSignalHarness(t)
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)
	link := harness.client(t)

	link.send(t, relay_svc.SignalChannelID, []byte{0x08, 0x01})
	require.Equal(t, relay_svc.ChannelCodeReserved, requireChannelError(t,
		link.next(t, relay_svc.SignalChannelID, "客户端往保留通道写入没有被判成协议违例")))

	// 空载荷（普通通道上的「关掉这条」约定）同样是写入，同样被拒。
	link.send(t, relay_svc.SignalChannelID, nil)
	require.Equal(t, relay_svc.ChannelCodeReserved, requireChannelError(t,
		link.next(t, relay_svc.SignalChannelID, "客户端关保留通道没有被判成协议违例")))

	// 整条连接不受影响。
	link.open(t, "c-alpha", "machine:fp-alpha")
	link.send(t, "c-alpha", []byte{0x08, 0x02})
	_, frame := readDaemonEnvelope(t, alpha, "往保留通道写入连坐了整条连接")
	require.Equal(t, []byte{0x08, 0x02}, frame)
}

// 订阅仍排在 upgrade **之前**（Hard invariant 5）：upgrade 成功之后发生的每一次
// 广播都必然落在这份订阅上，不留「刚连上就漏掉一条」的窗口。
//
// 判据是握手本身被订阅挡住：订阅还没返回时 Dial 不得完成。
func TestRelayClient_GivenTheSubscriptionIsSlow_ThenTheUpgradeWaitsForIt(t *testing.T) {
	gate := make(chan struct{})
	harness := newSignalHarnessWith(t, &gatedAccountChan{gate: gate})
	signer := harness.signer

	dialed := make(chan error, 1)
	go func() {
		conn, response, err := protobufRelayDialer.Dial(wsURL(harness.server.URL, "/v1/relay/client"),
			http.Header{"Authorization": {"Bearer " + signalToken(t, signer, 7, 9)}})
		if response != nil {
			_ = response.Body.Close()
		}
		if conn != nil {
			t.Cleanup(func() { _ = conn.Close() })
		}
		dialed <- err
	}()

	select {
	case err := <-dialed:
		t.Fatalf("订阅还没建起来 upgrade 就完成了，中间那一段广播会漏掉：%v", err)
	case <-time.After(300 * time.Millisecond):
	}
	close(gate)
	require.NoError(t, receiveWithin(t, dialed, 2*time.Second, "订阅返回之后 upgrade 没有完成"))
}

// 信号源没了（Redis 订阅彻底断掉）：关掉的是那一条保留通道，不是整条连接——
// 上面还跑着 RPC。客户端据此把信号那一路标为不可用并退回 30 秒轮询。
func TestRelayClient_GivenTheSignalStreamStops_ThenOnlyTheSignalChannelCloses(t *testing.T) {
	stalling := &stallingAccountChan{signals: make(chan accountchan_svc.Frame)}
	harness := newSignalHarnessWith(t, stalling)
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)
	link := harness.client(t)

	close(stalling.signals)
	require.Empty(t, link.next(t, relay_svc.SignalChannelID, "信号源没了之后保留通道没有关闭"),
		"空载荷是「这条通道关了」的信号")

	link.open(t, "c-alpha", "machine:fp-alpha")
	link.send(t, "c-alpha", []byte{0x08, 0x09})
	_, frame := readDaemonEnvelope(t, alpha, "信号源没了连坐了整条连接")
	require.Equal(t, []byte{0x08, 0x09}, frame)
}

// /v1/account/channel 已不存在（决策 13）：合并的是传输，路由不再留一个空壳。
func TestAccountChannelEndpointIsGone(t *testing.T) {
	harness := newSignalHarness(t)
	request, err := http.NewRequest(http.MethodGet, harness.server.URL+"/v1/account/channel", nil)
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+signalToken(t, harness.signer, 7, 9))
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	require.Equal(t, http.StatusNotFound, response.StatusCode, "账号通道端点必须已经删除")
}

// ── 装配 ────────────────────────────────────────────────────────────────

func newSignalHarness(t *testing.T) *channelHarness {
	t.Helper()
	testutils.Redis()
	return newSignalHarnessWith(t, accountchan_svc.New(newRelayRedisClient(t, miniredis.RunT(t))))
}

func newSignalSigner(t *testing.T) *jwt.Signer {
	t.Helper()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	return signer
}

func signalToken(t *testing.T, signer *jwt.Signer, accountID, deviceID int64) string {
	t.Helper()
	token, _, err := signer.Sign(
		jwt.Claims{UID: accountID, DID: deviceID, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)
	return token
}

func dialSignalClient(t *testing.T, server *httptest.Server, token string) *clientLink {
	t.Helper()
	conn, response, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/client"),
		http.Header{"Authorization": {"Bearer " + token}})
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return newClientLink(conn)
}

func accountNotificationMethod(frameType string) string {
	switch frameType {
	case accountchan_svc.FrameTypeSyncVersion:
		return "account.sync_version"
	case accountchan_svc.FrameTypeMirrorChanged:
		return "account.mirror_changed"
	default:
		return "account.device_presence"
	}
}

// decodeAccountNotification 把保留通道上的一帧解成（方法名, 版本）。
func decodeAccountNotification(t *testing.T, payload []byte) (string, int64) {
	t.Helper()
	var envelope agentrewire.WireFrame
	require.NoError(t, proto.Unmarshal(payload, &envelope))
	notification := envelope.GetNotification()
	require.NotNil(t, notification, "账号信号必须编码成 wire notification")
	switch notification.Payload.(type) {
	case *agentrewire.Notification_AccountSyncVersion:
		return "account.sync_version", int64(notification.GetAccountSyncVersion().GetVersion())
	case *agentrewire.Notification_AccountMirrorChanged:
		return "account.mirror_changed", 0
	case *agentrewire.Notification_AccountDevicePresence:
		return "account.device_presence", 0
	default:
		t.Fatalf("未知账号通知 %T", notification.Payload)
		return "", 0
	}
}

// unavailableAccountChan 模拟订阅后端不可用（Redis 连不上）。
type unavailableAccountChan struct{}

func (unavailableAccountChan) Broadcast(context.Context, int64, accountchan_svc.Frame) error {
	return errors.New("account channel is unavailable")
}

func (unavailableAccountChan) Subscribe(
	context.Context, int64,
) (accountchan_svc.Subscription, error) {
	return nil, errors.New("account channel is unavailable")
}

// gatedAccountChan 的订阅在闸门打开前不返回，用来观察订阅与 upgrade 的先后。
type gatedAccountChan struct{ gate chan struct{} }

func (gatedAccountChan) Broadcast(context.Context, int64, accountchan_svc.Frame) error { return nil }

func (g *gatedAccountChan) Subscribe(
	context.Context, int64,
) (accountchan_svc.Subscription, error) {
	<-g.gate
	return stalledSignalSubscription{signals: make(chan accountchan_svc.Frame)}, nil
}

// stallingAccountChan 给出一份订阅上去就不再有信号的通道，用来驱动「信号源没了」。
type stallingAccountChan struct{ signals chan accountchan_svc.Frame }

func (s *stallingAccountChan) Broadcast(context.Context, int64, accountchan_svc.Frame) error {
	return nil
}

func (s *stallingAccountChan) Subscribe(
	context.Context, int64,
) (accountchan_svc.Subscription, error) {
	return stalledSignalSubscription{signals: s.signals}, nil
}

type stalledSignalSubscription struct{ signals chan accountchan_svc.Frame }

func (s stalledSignalSubscription) Signals() <-chan accountchan_svc.Frame { return s.signals }

func (s stalledSignalSubscription) Close() {}
