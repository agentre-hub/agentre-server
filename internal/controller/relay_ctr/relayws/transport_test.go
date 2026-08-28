package relayws

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
)

type receivedFrame struct {
	messageType int
	data        []byte
}

type transportHarness struct {
	server     *httptest.Server
	peers      chan Connection
	frames     chan receivedFrame
	readErrors chan error
	deadlines  <-chan deadlineEvent
}

func TestTransportGivenProtobufSubprotocolWhenUpgradingThenNegotiatesIt(t *testing.T) {
	harness := newTransportHarness(t, defaultTiming(), Hooks{}, false)
	const expectedSubprotocol = "agentre-protobuf"
	dialer := websocket.Dialer{Subprotocols: []string{expectedSubprotocol}}
	conn, _, err := dialer.Dial(wsURL(harness.server.URL), nil)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, conn.Close()) })
	require.Equal(t, expectedSubprotocol, conn.Subprotocol())
}

func TestTransportGivenMissingProtobufSubprotocolWhenUpgradingThenRejectsBeforeWebSocket(t *testing.T) {
	harness := newTransportHarness(t, defaultTiming(), Hooks{}, false)
	conn, response, err := websocket.DefaultDialer.Dial(wsURL(harness.server.URL), nil)
	if conn != nil {
		t.Cleanup(func() { _ = conn.Close() })
	}
	require.Error(t, err)
	require.NotNil(t, response)
	t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	require.Equal(t, http.StatusUpgradeRequired, response.StatusCode)

	// 426 的正文是谈不拢子协议的调用方唯一能看到的东西。裸 http.StatusText 只会写
	// "Upgrade Required"，运维照着排查不出任何东西：正文必须指名这个端点说的子协议，
	// 并且说清补救办法（两端升到同一个版本）。措辞与桌面仓 protorpc.LANServer 的
	// 426 保持一致。
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Contains(t, string(body), ProtobufSubprotocol)
	require.Contains(t, strings.ToLower(string(body)), "upgrade")
	require.NotEqual(t, http.StatusText(http.StatusUpgradeRequired), strings.TrimSpace(string(body)))
}

func TestTransportUsesApprovedDefaultsAndPreservesOutboundFrames(t *testing.T) {
	cfg := defaultTiming()
	require.Equal(t, 15*time.Second, cfg.heartbeatInterval)
	require.Equal(t, 45*time.Second, cfg.readTimeout)
	require.Equal(t, 10*time.Second, cfg.writeTimeout)

	harness := newTransportHarness(t, cfg, Hooks{}, true)
	conn, peer := dialTransport(t, harness)
	requireDeadlineWithin(t, harness.deadlines, "read", cfg.readTimeout)

	require.NoError(t, peer.WriteMessage(websocket.BinaryMessage, []byte("response")))
	requireDeadlineWithin(t, harness.deadlines, "write", cfg.writeTimeout)
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
	messageType, frame, err := conn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.BinaryMessage, messageType)
	require.Equal(t, []byte("response"), frame)
}

func TestTransportHeartbeatsKeepResponsivePeersAlive(t *testing.T) {
	cfg := timing{
		heartbeatInterval: 10 * time.Millisecond,
		readTimeout:       70 * time.Millisecond,
		writeTimeout:      30 * time.Millisecond,
	}
	for _, tc := range []struct {
		name  string
		renew bool
	}{
		{name: "with renewal callback", renew: true},
		{name: "without renewal callback"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			renewed := make(chan struct{}, 16)
			var renew func() error
			if tc.renew {
				renew = func() error {
					select {
					case renewed <- struct{}{}:
					default:
					}
					return nil
				}
			}
			harness := newTransportHarness(t, cfg, Hooks{OnPeerActivity: renew}, false)
			conn, _ := dialTransport(t, harness)

			pings := make(chan struct{}, 16)
			conn.SetPingHandler(func(appData string) error {
				select {
				case pings <- struct{}{}:
				default:
				}
				return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(time.Second))
			})
			go drainConnection(conn)

			for range 8 {
				receiveWithin(t, pings, time.Second, "server heartbeat ping was not received")
			}
			if tc.renew {
				receiveWithin(t, renewed, time.Second, "heartbeat pong did not invoke renewal callback")
			}

			require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, []byte("request")))
			frame := receiveWithin(t, harness.frames, time.Second,
				"heartbeat-compliant peer stopped carrying frames")
			require.Equal(t, websocket.BinaryMessage, frame.messageType)
			require.Equal(t, []byte("request"), frame.data)
		})
	}
}

func TestTransportInboundDataExtendsReadLiveness(t *testing.T) {
	cfg := timing{
		heartbeatInterval: time.Hour,
		readTimeout:       50 * time.Millisecond,
		writeTimeout:      30 * time.Millisecond,
	}
	harness := newTransportHarness(t, cfg, Hooks{}, false)
	conn, _ := dialTransport(t, harness)

	for range 4 {
		time.Sleep(cfg.readTimeout / 2)
		require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, []byte("request")))
		frame := receiveWithin(t, harness.frames, time.Second, "inbound data did not extend read liveness")
		require.Equal(t, []byte("request"), frame.data)
	}
}

func TestTransportPeerPingRenewsAndExtendsReadLiveness(t *testing.T) {
	cfg := timing{
		heartbeatInterval: time.Hour,
		readTimeout:       60 * time.Millisecond,
		writeTimeout:      30 * time.Millisecond,
	}
	renewed := make(chan struct{}, 1)
	harness := newTransportHarness(t, cfg, Hooks{OnPeerActivity: func() error {
		select {
		case renewed <- struct{}{}:
		default:
		}
		return nil
	}}, false)
	conn, _ := dialTransport(t, harness)

	pongs := make(chan struct{}, 1)
	conn.SetPongHandler(func(string) error {
		select {
		case pongs <- struct{}{}:
		default:
		}
		return nil
	})
	go drainConnection(conn)

	time.Sleep(40 * time.Millisecond)
	require.NoError(t, conn.WriteControl(websocket.PingMessage, []byte("route"), time.Now().Add(time.Second)))
	receiveWithin(t, renewed, time.Second, "peer ping did not invoke renewal callback")
	receiveWithin(t, pongs, time.Second, "peer ping did not receive a pong")
	time.Sleep(40 * time.Millisecond)
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, []byte("request")))
	receiveWithin(t, harness.frames, time.Second, "peer ping did not extend read liveness")
}

func TestTransportUnresponsivePeerTimesOutAndCloses(t *testing.T) {
	cfg := timing{
		heartbeatInterval: time.Hour,
		readTimeout:       40 * time.Millisecond,
		writeTimeout:      20 * time.Millisecond,
	}
	harness := newTransportHarness(t, cfg, Hooks{}, false)
	conn, _ := dialTransport(t, harness)

	receiveWithin(t, harness.readErrors, time.Second, "unresponsive relay peer did not time out")
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
	_, _, err := conn.ReadMessage()
	require.Error(t, err)
}

// 凭据撤销的复查必须挂在服务端自己的心跳上，不能只挂在「对端来了 ping/pong」上：
// 一个只发帧、从不回应 ping 的对端会把读期限一直续下去，只靠对端活动的话它永远
// 躲得掉复查。断开还必须是一个真正的关闭帧，对端才能与网络中断区分开。
func TestTransportTerminatesRevokedCredentialOnItsOwnHeartbeat(t *testing.T) {
	cfg := timing{
		heartbeatInterval: 10 * time.Millisecond,
		readTimeout:       2 * time.Second,
		writeTimeout:      30 * time.Millisecond,
	}
	harness := newTransportHarness(t, cfg, Hooks{
		OnHeartbeat: func() error { return ErrCredentialRevoked },
	}, false)
	conn, _ := dialTransport(t, harness)

	require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
	_, _, err := conn.ReadMessage()
	require.True(t, websocket.IsCloseError(err, websocket.ClosePolicyViolation), "%v", err)
	require.Contains(t, err.Error(), credentialRevokedReason)
	receiveWithin(t, harness.readErrors, time.Second, "revoked relay peer did not unblock the read loop")
}

func newTransportHarness(
	t *testing.T,
	cfg timing,
	hooks Hooks,
	recordDeadlines bool,
) *transportHarness {
	t.Helper()
	harness := &transportHarness{
		peers:      make(chan Connection, 1),
		frames:     make(chan receivedFrame, 16),
		readErrors: make(chan error, 1),
	}
	transport := newWithTiming(cfg)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := transport.Upgrade(w, r, hooks)
		if err != nil {
			select {
			case harness.readErrors <- err:
			default:
			}
			return
		}
		harness.peers <- peer
		defer func() { _ = peer.Close() }()
		for {
			messageType, data, err := peer.ReadMessage()
			if err != nil {
				select {
				case harness.readErrors <- err:
				default:
				}
				return
			}
			harness.frames <- receivedFrame{messageType: messageType, data: data}
		}
	}))
	if recordDeadlines {
		deadlines := make(chan deadlineEvent, 64)
		server.Listener = &deadlineRecordingListener{Listener: server.Listener, events: deadlines}
		harness.deadlines = deadlines
	}
	server.Start()
	harness.server = server
	t.Cleanup(server.Close)
	return harness
}

func dialTransport(t *testing.T, harness *transportHarness) (*websocket.Conn, Connection) {
	t.Helper()
	dialer := websocket.Dialer{Subprotocols: []string{ProtobufSubprotocol}}
	conn, _, err := dialer.Dial(wsURL(harness.server.URL), nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return conn, receiveWithin(t, harness.peers, time.Second, "transport did not expose upgraded peer")
}

type deadlineEvent struct {
	kind string
	at   time.Time
}

type deadlineRecordingListener struct {
	net.Listener
	events chan<- deadlineEvent
}

func (l *deadlineRecordingListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &deadlineRecordingConn{Conn: conn, events: l.events}, nil
}

type deadlineRecordingConn struct {
	net.Conn
	events chan<- deadlineEvent
}

func (c *deadlineRecordingConn) SetReadDeadline(at time.Time) error {
	select {
	case c.events <- deadlineEvent{kind: "read", at: at}:
	default:
	}
	return c.Conn.SetReadDeadline(at)
}

func (c *deadlineRecordingConn) SetWriteDeadline(at time.Time) error {
	select {
	case c.events <- deadlineEvent{kind: "write", at: at}:
	default:
	}
	return c.Conn.SetWriteDeadline(at)
}

func requireDeadlineWithin(t *testing.T, events <-chan deadlineEvent, kind string, duration time.Duration) {
	t.Helper()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-events:
			remaining := time.Until(event.at)
			if event.kind == kind && remaining > duration-time.Second && remaining <= duration {
				return
			}
		case <-timer.C:
			t.Fatalf("relay did not apply %s deadline within %s", kind, duration)
		}
	}
}

func receiveWithin[T any](t *testing.T, values <-chan T, timeout time.Duration, failure string) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(timeout):
		t.Fatal(failure)
		var zero T
		return zero
	}
}

func drainConnection(conn *websocket.Conn) {
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

func wsURL(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http")
}
