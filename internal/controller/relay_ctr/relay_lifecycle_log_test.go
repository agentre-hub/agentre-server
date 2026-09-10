package relay_ctr_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// 中继连接的一生从前一行日志都不产：upgrade 失败、挂总线失败、登记在线态失败、
// 读循环退出，四个 return 全是裸的。而「agentred 连不上 / 老掉线」正是这个服务最
// 常见的一类报障，服务端手上却什么都没有。
//
// 这一组用例钉住的是「每一条中继连接都留得下接上与走人两行，失败各归各的级别」。

// 日志观测点是整个测试进程共用的（见 testutils.Logs），而上一个用例的连接可能正在
// 收尾。所以每条断言都连同身份字段一起过滤：daemon 用指纹，客户端用账号，两者都
// 按用例取唯一值。只按消息名过滤会捞到隔壁用例的连接。
func byFingerprint(fingerprint string) func(map[string]any) bool {
	return func(fields map[string]any) bool { return fields["fingerprint"] == fingerprint }
}

func byAccount(accountID int64) func(map[string]any) bool {
	return func(fields map[string]any) bool { return fields["accountId"] == accountID }
}

func relayLogLines(
	logs *observer.ObservedLogs, message string, match func(map[string]any) bool,
) []observer.LoggedEntry {
	return logs.Filter(func(entry observer.LoggedEntry) bool {
		return entry.Message == message && match(entry.ContextMap())
	}).All()
}

// awaitRelayLog 等一条日志出现——连接的收场发生在 handler 的 goroutine 上，
// 客户端这边关完不代表服务端已经记完。
func awaitRelayLog(
	t *testing.T, logs *observer.ObservedLogs, message string,
	match func(map[string]any) bool, within time.Duration,
) observer.LoggedEntry {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if found := relayLogLines(logs, message, match); len(found) > 0 {
			return found[0]
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("日志里始终没有出现 %q；实际记下的是 %v", message, logs.AllUntimed())
	return observer.LoggedEntry{}
}

func newLoggedRelayServer(
	t *testing.T, svc relay_svc.RelaySvc, kind string, accountID int64,
) (*httptest.Server, http.Header) {
	t.Helper()
	testutils.Redis(t)
	signer := newSignalSigner(t)
	server := newRelayServer(t, signer, svc)
	token, _, err := signer.Sign(jwt.Claims{UID: accountID, DID: 9, Kind: kind}, time.Hour)
	require.NoError(t, err)
	return server, http.Header{"Authorization": {"Bearer " + token}}
}

// daemonStub 让这条 daemon 连接在日志里认得出自己：指纹取用例名。
func daemonStub(t *testing.T) *relayStub {
	t.Helper()
	stub := newForwardingRelayStub()
	stub.daemonRoute.Fingerprint = t.Name()
	return stub
}

// dialDaemon 接一条 daemon 中继连接，并等到它真的登记成在线。
func dialDaemon(t *testing.T, svc relay_svc.RelaySvc) *websocket.Conn {
	t.Helper()
	server, headers := newLoggedRelayServer(t, svc, device_entity.KindAgentred, 7)
	conn, response, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"), headers)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())
	return conn
}

// 接上与正常走人：两行都是 Info——这是一条连接本来的结局，不需要人去看，但必须
// 留得下来，否则「这台机器什么时候在线过」无从回答。
func TestRelayDaemonLogsConnectAndOrderlyDisconnect(t *testing.T) {
	logs := testutils.Logs(t)
	stub := daemonStub(t)
	conn := dialDaemon(t, stub)
	receiveWithin(t, stub.registered, time.Second, "daemon 没有登记在线")

	connected := awaitRelayLog(t, logs, "relay daemon connected", byFingerprint(t.Name()), 2*time.Second)
	fields := connected.ContextMap()
	require.Equal(t, zapcore.InfoLevel, connected.Level)
	require.Equal(t, int64(7), fields["accountId"])
	require.Equal(t, int64(9), fields["deviceId"])
	require.Equal(t, "server-a", fields["instanceId"])

	require.NoError(t, conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second)))
	require.NoError(t, conn.Close())

	disconnected := awaitRelayLog(t, logs, "relay daemon disconnected", byFingerprint(t.Name()), 2*time.Second)
	require.Equal(t, zapcore.InfoLevel, disconnected.Level, "对端好好地关掉是 Info")
	require.Empty(t, relayLogLines(logs, "relay daemon disconnected unexpectedly", byFingerprint(t.Name())))
}

// 连接没打招呼就没了（进程被杀 / 网络断）：Warn，并带上读循环拿到的原因。这是
// 「掉线」类报障唯一的服务端物证。
func TestRelayDaemonLogsAnAbruptDisconnectAsAWarning(t *testing.T) {
	logs := testutils.Logs(t)
	stub := daemonStub(t)
	conn := dialDaemon(t, stub)
	receiveWithin(t, stub.registered, time.Second, "daemon 没有登记在线")

	require.NoError(t, conn.UnderlyingConn().Close())

	disconnected := awaitRelayLog(t, logs,
		"relay daemon disconnected unexpectedly", byFingerprint(t.Name()), 2*time.Second)
	require.Equal(t, zapcore.WarnLevel, disconnected.Level)
	require.NotEmpty(t, disconnected.ContextMap()["error"], "断开原因必须留下来")
	require.Empty(t, relayLogLines(logs, "relay daemon disconnected", byFingerprint(t.Name())))
}

// 登记在线态失败 = Redis 写不进去。daemon 的 websocket 建好了却不算在线，客户端
// 全部解析不到这台机器——服务端坏了，Error。
func TestRelayDaemonRegistrationFailureIsLoggedAsAnError(t *testing.T) {
	logs := testutils.Logs(t)
	stub := &brokenRelayStub{
		relayStub:   daemonStub(t),
		registerErr: errors.New("redis: connection refused"),
	}
	conn := dialDaemon(t, stub)
	t.Cleanup(func() { _ = conn.Close() })

	failed := awaitRelayLog(t, logs,
		"relay daemon registration failed", byFingerprint(t.Name()), 2*time.Second)
	require.Equal(t, zapcore.ErrorLevel, failed.Level)
	require.Contains(t, failed.ContextMap()["error"], "connection refused")
	require.Empty(t, relayLogLines(logs, "relay daemon connected", byFingerprint(t.Name())),
		"登记不上就不算接上了，别记一行「已连接」把人骗过去")
}

// 挂上帧总线失败：这台 daemon 收不到任何跨实例来的帧。同样是服务端侧的故障。
func TestRelayDaemonAttachFailureIsLoggedAsAnError(t *testing.T) {
	logs := testutils.Logs(t)
	stub := &brokenRelayStub{
		relayStub: daemonStub(t),
		attachErr: errors.New("relay frame bus is unreachable"),
	}
	conn := dialDaemon(t, stub)
	t.Cleanup(func() { _ = conn.Close() })

	failed := awaitRelayLog(t, logs, "relay daemon attach failed", byFingerprint(t.Name()), 2*time.Second)
	require.Equal(t, zapcore.ErrorLevel, failed.Level)
	require.Contains(t, failed.ContextMap()["error"], "unreachable")
}

// 握手就没成：客户端的锅居多（少了 Upgrade 头、子协议不对），服务端照常活着，
// 所以是 Warn。但它得留痕——否则「连不上」的现场在服务端是一片空白。
func TestRelayWebsocketUpgradeFailureIsLoggedAsAWarning(t *testing.T) {
	logs := testutils.Logs(t)
	stub := daemonStub(t)
	server, headers := newLoggedRelayServer(t, stub, device_entity.KindAgentred, 7)

	request, err := http.NewRequest(http.MethodGet, server.URL+"/v1/relay/daemon", nil)
	require.NoError(t, err)
	request.Header = headers
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, response.StatusCode)
	require.NoError(t, response.Body.Close())

	failed := awaitRelayLog(t, logs,
		"relay daemon websocket upgrade failed", byFingerprint(t.Name()), 2*time.Second)
	require.Equal(t, zapcore.WarnLevel, failed.Level)
	require.Equal(t, int64(7), failed.ContextMap()["accountId"])
	require.NotEmpty(t, failed.ContextMap()["error"])
}

// 客户端连接同样记起止。它没有机器指纹，账号就是它在日志里的全部身份，所以这一组
// 用例各用一个只属于自己的账号号码。
func TestRelayClientLogsConnectAndDisconnect(t *testing.T) {
	const account = int64(7101)
	logs := testutils.Logs(t)
	server, headers := newLoggedRelayServer(t, newForwardingRelayStub(), device_entity.KindDesktop, account)
	conn, response, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/client"), headers)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())

	connected := awaitRelayLog(t, logs, "relay client connected", byAccount(account), 2*time.Second)
	require.Equal(t, zapcore.InfoLevel, connected.Level)

	require.NoError(t, conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second)))
	require.NoError(t, conn.Close())

	disconnected := awaitRelayLog(t, logs, "relay client disconnected", byAccount(account), 2*time.Second)
	require.Equal(t, zapcore.InfoLevel, disconnected.Level)
}

// 协议违例（非二进制帧 / 信封拆不开）会整条连接判死。客户端写错了，服务端没坏，
// 所以是 Warn；但断开的原因必须说清是违例而不是网络，否则前端只会看到「又断了」。
func TestRelayClientProtocolViolationClosesTheConnectionWithAReason(t *testing.T) {
	for _, tc := range []struct {
		name    string
		account int64
		write   func(*websocket.Conn) error
		why     string
	}{
		{
			name:    "非二进制帧",
			account: 7201,
			write:   func(c *websocket.Conn) error { return c.WriteMessage(websocket.TextMessage, []byte("hi")) },
			why:     "non-binary frame",
		},
		{
			name:    "信封拆不开",
			account: 7202,
			write:   func(c *websocket.Conn) error { return c.WriteMessage(websocket.BinaryMessage, []byte{0xff}) },
			why:     "envelope",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs := testutils.Logs(t)
			server, headers := newLoggedRelayServer(
				t, newForwardingRelayStub(), device_entity.KindDesktop, tc.account)
			conn, response, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/client"), headers)
			require.NoError(t, err)
			require.NoError(t, response.Body.Close())
			t.Cleanup(func() { _ = conn.Close() })

			require.NoError(t, tc.write(conn))

			closed := awaitRelayLog(t, logs,
				"relay client disconnected unexpectedly", byAccount(tc.account), 2*time.Second)
			require.Equal(t, zapcore.WarnLevel, closed.Level)
			require.Contains(t, closed.ContextMap()["error"], tc.why,
				"断开原因得说清是协议违例，别只留一个网络错误")
		})
	}
}

// 账号信号那一路订阅不上时，连接照常服务 RPC（既有用例已钉住降级行为）。这里钉的
// 是它别再无声无息：整条连接只是缺了一路信号，Warn。
func TestRelaySignalSubscriptionFailureIsLoggedAsAWarning(t *testing.T) {
	logs := testutils.Logs(t)
	harness := newSignalHarnessWith(t, unavailableAccountChan{})
	harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)

	unavailable := awaitRelayLog(t, logs, "relay account signals unavailable",
		func(fields map[string]any) bool { return fields["peer"] == "daemon" }, 2*time.Second)
	require.Equal(t, zapcore.WarnLevel, unavailable.Level)
	require.Equal(t, int64(7), unavailable.ContextMap()["accountId"])
	require.NotEmpty(t, unavailable.ContextMap()["error"])
}

// brokenRelayStub 让 daemon 那两步服务端侧的装配各自失败，用来观察它们的日志级别。
type brokenRelayStub struct {
	*relayStub
	attachErr   error
	registerErr error
}

func (s *brokenRelayStub) AttachDaemon(
	ctx context.Context, route relay_svc.Route, writer relay_svc.FrameWriter,
) (func(), error) {
	if s.attachErr != nil {
		return nil, s.attachErr
	}
	return s.relayStub.AttachDaemon(ctx, route, writer)
}

func (s *brokenRelayStub) RegisterDaemon(ctx context.Context, route relay_svc.Route) error {
	if s.registerErr != nil {
		return s.registerErr
	}
	return s.relayStub.RegisterDaemon(ctx, route)
}
