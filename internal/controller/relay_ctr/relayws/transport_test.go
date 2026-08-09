package relayws

import (
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

func TestTransportUsesApprovedDefaultsAndPreservesOutboundFrames(t *testing.T) {
	cfg := defaultTiming()
	require.Equal(t, 15*time.Second, cfg.heartbeatInterval)
	require.Equal(t, 45*time.Second, cfg.readTimeout)
	require.Equal(t, 10*time.Second, cfg.writeTimeout)

	harness := newTransportHarness(t, cfg, nil, true)
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
			harness := newTransportHarness(t, cfg, renew, false)
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
	harness := newTransportHarness(t, cfg, nil, false)
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
	harness := newTransportHarness(t, cfg, func() error {
		select {
		case renewed <- struct{}{}:
		default:
		}
		return nil
	}, false)
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
	harness := newTransportHarness(t, cfg, nil, false)
	conn, _ := dialTransport(t, harness)

	receiveWithin(t, harness.readErrors, time.Second, "unresponsive relay peer did not time out")
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
	_, _, err := conn.ReadMessage()
	require.Error(t, err)
}

func newTransportHarness(
	t *testing.T,
	cfg timing,
	renew func() error,
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
		peer, err := transport.Upgrade(w, r, renew)
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
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(harness.server.URL), nil)
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
