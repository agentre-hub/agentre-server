package relay_ctr_test

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/api"
	"agentre-server/internal/bootstrap"
	"agentre-server/internal/controller/relay_ctr"
	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
	"agentre-server/internal/service/relay_svc"
)

type relayStub struct {
	daemonRoute    relay_svc.Route
	daemonErr      error
	clientErr      error
	registered     chan struct{}
	renewed        chan struct{}
	daemonFrames   chan struct{}
	clientFrames   chan struct{}
	daemonDetached chan struct{}
	clientDetached chan struct{}
	daemonWriters  chan relay_svc.FrameWriter
	clientWriters  chan relay_svc.FrameWriter
}

func (s *relayStub) PrepareDaemon(context.Context, int64, int64, string) (relay_svc.Route, error) {
	if s.daemonErr != nil {
		return relay_svc.Route{}, s.daemonErr
	}
	return s.daemonRoute, nil
}

func (s *relayStub) RegisterDaemon(context.Context, relay_svc.Route) error {
	select {
	case s.registered <- struct{}{}:
	default:
	}
	return nil
}

func (s *relayStub) RenewDaemon(context.Context, relay_svc.Route) error {
	select {
	case s.renewed <- struct{}{}:
	default:
	}
	return nil
}

func (s *relayStub) ConnectClient(context.Context, int64, string) (relay_svc.Route, error) {
	if s.clientErr != nil {
		return relay_svc.Route{}, s.clientErr
	}
	return s.daemonRoute, nil
}

func (s *relayStub) IsDaemonOnline(context.Context, int64, string) (bool, error) {
	return false, nil
}

func (s *relayStub) AttachDaemon(_ context.Context, _ relay_svc.Route, writer relay_svc.FrameWriter) (func(), error) {
	select {
	case s.daemonWriters <- writer:
	default:
	}
	return func() {
		select {
		case s.daemonDetached <- struct{}{}:
		default:
		}
	}, nil
}

func (s *relayStub) AttachClient(_ context.Context, _ relay_svc.Route, writer relay_svc.FrameWriter) (string, func(), error) {
	select {
	case s.clientWriters <- writer:
	default:
	}
	return "channel-id", func() {
		select {
		case s.clientDetached <- struct{}{}:
		default:
		}
	}, nil
}

func (s *relayStub) ForwardDaemon(context.Context, relay_svc.Route, int, []byte) error {
	select {
	case s.daemonFrames <- struct{}{}:
	default:
	}
	return nil
}

func (s *relayStub) ForwardClient(context.Context, relay_svc.Route, string, int, []byte) error {
	select {
	case s.clientFrames <- struct{}{}:
	default:
	}
	return nil
}

func TestRelayEndpointsRequireDeviceJWTAndDaemonRenewsOnFrames(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	stub := &relayStub{
		daemonRoute:  relay_svc.Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"},
		registered:   make(chan struct{}, 1),
		renewed:      make(chan struct{}, 1),
		daemonFrames: make(chan struct{}, 1),
		clientFrames: make(chan struct{}, 1),
	}

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{},
		Signer: signer,
		Relay:  stub,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	noAuth, err := http.NewRequest(http.MethodGet, server.URL+"/v1/relay/daemon", nil)
	require.NoError(t, err)
	response, err := http.DefaultClient.Do(noAuth)
	require.NoError(t, err)
	require.Equal(t, http.StatusUnauthorized, response.StatusCode)
	require.NoError(t, response.Body.Close())

	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 9, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	noUpgrade, err := http.NewRequest(http.MethodGet, server.URL+"/v1/relay/daemon", nil)
	require.NoError(t, err)
	noUpgrade.Header.Set("Authorization", "Bearer "+token)
	response, err = http.DefaultClient.Do(noUpgrade)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, response.StatusCode)
	require.NoError(t, response.Body.Close())
	select {
	case <-stub.registered:
		t.Fatal("non-websocket request registered an online daemon")
	default:
	}

	headers := http.Header{"Authorization": {"Bearer " + token}}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"), headers)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, conn.Close()) })
	// 真实的 ForwardDaemon 只收二进制信封（relay_svc.ForwardDaemon 会拒绝其它一切），
	// 所以这里必须发一个 production 真会发出的帧，而不是桩恰好也肯收的文本。
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage,
		relayEnvelope("channel-id", []byte(`{"jsonrpc":"2.0"}`))))

	select {
	case <-stub.renewed:
	case <-time.After(time.Second):
		t.Fatal("daemon frame did not renew the online registration")
	}
	select {
	case <-stub.daemonFrames:
	case <-time.After(time.Second):
		t.Fatal("daemon frame did not reach the forwarding seam")
	}

	clientConn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL, "/v1/relay/client?daemon_fingerprint=fp-daemon"), headers)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, clientConn.Close()) })
	require.NoError(t, clientConn.WriteMessage(websocket.BinaryMessage, []byte("request")))
	select {
	case <-stub.clientFrames:
	case <-time.After(time.Second):
		t.Fatal("client frame did not reach the forwarding seam")
	}
}

func TestRelayLifecycleRejectsOversizedMessagesAndDetaches(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	for _, tc := range []struct {
		name       string
		path       string
		kind       string
		daemonWire bool
		framesOf   func(*relayStub) <-chan struct{}
		detachedOf func(*relayStub) <-chan struct{}
	}{
		{
			name: "daemon", path: "/v1/relay/daemon", kind: device_entity.KindAgentred, daemonWire: true,
			framesOf:   func(stub *relayStub) <-chan struct{} { return stub.daemonFrames },
			detachedOf: func(stub *relayStub) <-chan struct{} { return stub.daemonDetached },
		},
		{
			name: "client", path: "/v1/relay/client?daemon_fingerprint=fp-daemon", kind: device_entity.KindDesktop,
			framesOf:   func(stub *relayStub) <-chan struct{} { return stub.clientFrames },
			detachedOf: func(stub *relayStub) <-chan struct{} { return stub.clientDetached },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := &relayStub{
				daemonRoute: relay_svc.Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"},
				registered:  make(chan struct{}, 1), renewed: make(chan struct{}, 1),
				daemonFrames: make(chan struct{}, 1), clientFrames: make(chan struct{}, 1),
				daemonDetached: make(chan struct{}, 1), clientDetached: make(chan struct{}, 1),
			}
			server := newRelayServer(t, signer, stub)
			token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 9, Kind: tc.kind}, time.Hour)
			require.NoError(t, err)
			conn, _, err := websocket.DefaultDialer.Dial(
				wsURL(server.URL, tc.path), http.Header{"Authorization": {"Bearer " + token}},
			)
			require.NoError(t, err)
			t.Cleanup(func() { _ = conn.Close() })

			require.NoError(t, conn.SetWriteDeadline(time.Now().Add(2*time.Second)))
			require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, relayPayloadOfSize(10<<20, tc.daemonWire)))
			receiveWithin(t, tc.framesOf(stub), time.Second, "10 MiB relay message was not accepted")
			require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, relayPayloadOfSize((10<<20)+1, tc.daemonWire)))
			require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
			_, _, err = conn.ReadMessage()
			require.True(t, websocket.IsCloseError(err, websocket.CloseMessageTooBig), err)
			select {
			case <-tc.detachedOf(stub):
			case <-time.After(time.Second):
				t.Fatal("oversized relay peer did not run detach cleanup")
			}
		})
	}
}

func TestRelayLifecycleUsesApprovedDeadlinesAndPreservesOutboundFrames(t *testing.T) {
	timing := relay_ctr.DefaultLifecycleTiming()
	require.Equal(t, 15*time.Second, timing.HeartbeatInterval)
	require.Equal(t, 45*time.Second, timing.ReadTimeout)
	require.Equal(t, 10*time.Second, timing.WriteTimeout)

	for _, tc := range []struct {
		name     string
		path     string
		writerOf func(*relayStub) <-chan relay_svc.FrameWriter
	}{
		{
			name: "daemon", path: "/v1/relay/daemon",
			writerOf: func(stub *relayStub) <-chan relay_svc.FrameWriter { return stub.daemonWriters },
		},
		{
			name: "client", path: "/v1/relay/client",
			writerOf: func(stub *relayStub) <-chan relay_svc.FrameWriter { return stub.clientWriters },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newLifecycleRelayStub()
			server, deadlines := newLifecycleRelayServer(t, stub, tc.path, timing, true)
			conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL, tc.path), nil)
			require.NoError(t, err)
			t.Cleanup(func() { _ = conn.Close() })

			writer := receiveWithin(t, tc.writerOf(stub), time.Second, "relay writer was not attached")
			requireDeadlineWithin(t, deadlines, "read", timing.ReadTimeout)
			require.NoError(t, writer.WriteMessage(websocket.BinaryMessage, []byte("response")))
			requireDeadlineWithin(t, deadlines, "write", timing.WriteTimeout)
			require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
			messageType, frame, err := conn.ReadMessage()
			require.NoError(t, err)
			require.Equal(t, websocket.BinaryMessage, messageType)
			require.Equal(t, []byte("response"), frame)
		})
	}
}

func TestRelayLifecycleServerHeartbeatsKeepBothPeerTypesAlive(t *testing.T) {
	timing := relay_ctr.LifecycleTiming{
		HeartbeatInterval: 10 * time.Millisecond,
		ReadTimeout:       70 * time.Millisecond,
		WriteTimeout:      30 * time.Millisecond,
	}
	for _, tc := range []struct {
		name     string
		path     string
		frame    []byte
		framesOf func(*relayStub) <-chan struct{}
	}{
		{
			name: "daemon", path: "/v1/relay/daemon", frame: relayEnvelope("channel-id", []byte("response")),
			framesOf: func(stub *relayStub) <-chan struct{} { return stub.daemonFrames },
		},
		{
			name: "client", path: "/v1/relay/client", frame: []byte("request"),
			framesOf: func(stub *relayStub) <-chan struct{} { return stub.clientFrames },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newLifecycleRelayStub()
			server, _ := newLifecycleRelayServer(t, stub, tc.path, timing, false)
			conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL, tc.path), nil)
			require.NoError(t, err)
			t.Cleanup(func() { _ = conn.Close() })

			pings := make(chan struct{}, 16)
			conn.SetPingHandler(func(appData string) error {
				select {
				case pings <- struct{}{}:
				default:
				}
				return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(time.Second))
			})
			go drainRelayConnection(conn)

			for range 8 {
				receiveWithin(t, pings, time.Second, "server heartbeat ping was not received")
			}
			if tc.name == "daemon" {
				receiveWithin(t, stub.renewed, time.Second, "daemon pong did not renew its route")
			} else {
				select {
				case <-stub.renewed:
					t.Fatal("client heartbeat created daemon route renewal")
				default:
				}
			}

			require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, tc.frame))
			receiveWithin(t, tc.framesOf(stub), time.Second, "heartbeat-compliant peer stopped carrying frames")
		})
	}
}

func TestRelayLifecycleInboundDataExtendsReadLiveness(t *testing.T) {
	timing := relay_ctr.LifecycleTiming{
		HeartbeatInterval: time.Hour,
		ReadTimeout:       50 * time.Millisecond,
		WriteTimeout:      30 * time.Millisecond,
	}
	for _, tc := range []struct {
		name     string
		path     string
		frame    []byte
		framesOf func(*relayStub) <-chan struct{}
	}{
		{
			name: "daemon", path: "/v1/relay/daemon", frame: relayEnvelope("channel-id", []byte("response")),
			framesOf: func(stub *relayStub) <-chan struct{} { return stub.daemonFrames },
		},
		{
			name: "client", path: "/v1/relay/client", frame: []byte("request"),
			framesOf: func(stub *relayStub) <-chan struct{} { return stub.clientFrames },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newLifecycleRelayStub()
			server, _ := newLifecycleRelayServer(t, stub, tc.path, timing, false)
			conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL, tc.path), nil)
			require.NoError(t, err)
			t.Cleanup(func() { _ = conn.Close() })

			for range 4 {
				time.Sleep(timing.ReadTimeout / 2)
				require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, tc.frame))
				receiveWithin(t, tc.framesOf(stub), time.Second, "inbound data did not reach forwarding")
			}
		})
	}
}

func TestRelayLifecycleDaemonPingRenewsRouteAndExtendsReadLiveness(t *testing.T) {
	timing := relay_ctr.LifecycleTiming{
		HeartbeatInterval: time.Hour,
		ReadTimeout:       60 * time.Millisecond,
		WriteTimeout:      30 * time.Millisecond,
	}
	stub := newLifecycleRelayStub()
	server, _ := newLifecycleRelayServer(t, stub, "/v1/relay/daemon", timing, false)
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"), nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	pongs := make(chan struct{}, 1)
	conn.SetPongHandler(func(string) error {
		select {
		case pongs <- struct{}{}:
		default:
		}
		return nil
	})
	go drainRelayConnection(conn)

	time.Sleep(40 * time.Millisecond)
	require.NoError(t, conn.WriteControl(websocket.PingMessage, []byte("route"), time.Now().Add(time.Second)))
	receiveWithin(t, stub.renewed, time.Second, "daemon ping did not renew its route")
	receiveWithin(t, pongs, time.Second, "daemon ping did not receive a pong")
	time.Sleep(40 * time.Millisecond)
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, relayEnvelope("channel-id", []byte("response"))))
	receiveWithin(t, stub.daemonFrames, time.Second, "daemon ping did not extend read liveness")
}

func TestRelayLifecycleUnresponsivePeersCloseAndDetach(t *testing.T) {
	timing := relay_ctr.LifecycleTiming{
		HeartbeatInterval: time.Hour,
		ReadTimeout:       40 * time.Millisecond,
		WriteTimeout:      20 * time.Millisecond,
	}
	for _, tc := range []struct {
		name       string
		path       string
		detachedOf func(*relayStub) <-chan struct{}
	}{
		{
			name: "daemon", path: "/v1/relay/daemon",
			detachedOf: func(stub *relayStub) <-chan struct{} { return stub.daemonDetached },
		},
		{
			name: "client", path: "/v1/relay/client",
			detachedOf: func(stub *relayStub) <-chan struct{} { return stub.clientDetached },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newLifecycleRelayStub()
			server, _ := newLifecycleRelayServer(t, stub, tc.path, timing, false)
			conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL, tc.path), nil)
			require.NoError(t, err)
			t.Cleanup(func() { _ = conn.Close() })

			receiveWithin(t, tc.detachedOf(stub), time.Second, "unresponsive relay peer did not detach")
			require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
			_, _, err = conn.ReadMessage()
			require.Error(t, err)
		})
	}
}

// PrepareDaemon 的准入判据（本账号名下、活跃的 agentred）被拒时必须走 403，而且
// 必须**在 websocket upgrade 之前**答复：一个 desktop 端的 device JWT 拿不到升级后
// 的连接，也就没机会占住这个账号+指纹的中继路由。403 这一支此前没有任何测试。
func TestRelayDaemonForbiddenAnswers403BeforeUpgrading(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 4, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)

	stub := &relayStub{
		daemonErr: relay_svc.ErrDaemonForbidden, registered: make(chan struct{}, 1),
		renewed: make(chan struct{}, 1), daemonFrames: make(chan struct{}, 1),
		clientFrames: make(chan struct{}, 1),
	}
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg: &bootstrap.ServerConfig{}, Signer: signer, Relay: stub,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	_, response, err := websocket.DefaultDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"),
		http.Header{"Authorization": {"Bearer " + token}})
	require.Error(t, err, "a forbidden daemon must never get an upgraded connection")
	require.NotNil(t, response)
	defer response.Body.Close()
	require.Equal(t, http.StatusForbidden, response.StatusCode)
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Contains(t, string(body), `"code":`+strconv.Itoa(code.Forbidden))
	select {
	case <-stub.registered:
		t.Fatal("a forbidden daemon registered an online route")
	default:
	}
}

func TestRelayClientFailureStatusesAreDistinct(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 4, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)

	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "not found", err: relay_svc.ErrDaemonNotFound, status: http.StatusNotFound, code: "30400"},
		{name: "offline", err: relay_svc.ErrDaemonOffline, status: http.StatusConflict, code: "30401"},
		{name: "forward failed", err: relay_svc.ErrForwardFailed, status: http.StatusBadGateway, code: "30402"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			testMux := muxtest.NewTestMux()
			stub := &relayStub{
				clientErr: tc.err, registered: make(chan struct{}, 1), renewed: make(chan struct{}, 1),
				daemonFrames: make(chan struct{}, 1), clientFrames: make(chan struct{}, 1),
			}
			require.NoError(t, (&api.RouterDeps{
				Cfg:    &bootstrap.ServerConfig{},
				Signer: signer,
				Relay:  stub,
			}).Router(context.Background(), testMux.Router))
			server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
			t.Cleanup(server.Close)

			req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/relay/client?daemon_fingerprint=fp-daemon", nil)
			require.NoError(t, err)
			req.Header.Set("Authorization", "Bearer "+token)
			response, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, tc.status, response.StatusCode)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.Contains(t, string(body), `"code":`+tc.code)
		})
	}
}

func TestRelayFramesCrossServerInstances(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mini := miniredis.RunT(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	controllers := gomock.NewController(t)
	daemonDevices := mock_device_repo.NewMockDeviceRepo(controllers)
	clientDevices := mock_device_repo.NewMockDeviceRepo(controllers)
	daemon := activeRelayDaemon()
	daemonDevices.EXPECT().Find(gomock.Any(), int64(9)).Return(daemon, nil)
	clientDevices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), daemon.Fingerprint).Return(daemon, nil).Times(2)

	configA := relay_svc.Config{InstanceID: "server-a", OnlineTTL: time.Second}
	redisA := newRelayRedisClient(t, mini)
	serverA := newRelayServer(t, signer, relay_svc.New(
		configA, clientDevices, redisA, relay_svc.NewRedisForwarder(configA, redisA),
	))
	configB := relay_svc.Config{InstanceID: "server-b", OnlineTTL: time.Second}
	redisB := newRelayRedisClient(t, mini)
	serverB := newRelayServer(t, signer, relay_svc.New(
		configB, daemonDevices, redisB, relay_svc.NewRedisForwarder(configB, redisB),
	))

	daemonToken, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 9, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	clientToken, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 4, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)

	daemonConn, _, err := websocket.DefaultDialer.Dial(
		wsURL(serverB.URL, "/v1/relay/daemon"),
		http.Header{"Authorization": {"Bearer " + daemonToken}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, daemonConn.Close()) })

	clientConn, response, err := websocket.DefaultDialer.Dial(
		wsURL(serverA.URL, "/v1/relay/client?daemon_fingerprint="+daemon.Fingerprint),
		http.Header{"Authorization": {"Bearer " + clientToken}},
	)
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, clientConn.Close()) })
	otherClientConn, _, err := websocket.DefaultDialer.Dial(
		wsURL(serverA.URL, "/v1/relay/client?daemon_fingerprint="+daemon.Fingerprint),
		http.Header{"Authorization": {"Bearer " + clientToken}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, otherClientConn.Close()) })

	require.NoError(t, clientConn.WriteMessage(websocket.BinaryMessage, []byte("request")))
	daemonConn.SetReadDeadline(time.Now().Add(time.Second))
	messageType, frame, err := daemonConn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.BinaryMessage, messageType)
	channelID, innerFrame := decodeRelayEnvelope(t, frame)
	require.NotEmpty(t, channelID)
	require.Equal(t, []byte("request"), innerFrame)

	require.NoError(t, daemonConn.WriteMessage(websocket.BinaryMessage, relayEnvelope(channelID, []byte("response"))))
	clientConn.SetReadDeadline(time.Now().Add(time.Second))
	messageType, frame, err = clientConn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.BinaryMessage, messageType)
	require.Equal(t, []byte("response"), frame)

	otherClientConn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	_, _, err = otherClientConn.ReadMessage()
	require.Error(t, err)
	var networkErr net.Error
	require.ErrorAs(t, err, &networkErr)
	require.True(t, networkErr.Timeout())
}

func relayPayloadOfSize(size int, daemonWire bool) []byte {
	payload := make([]byte, size)
	if !daemonWire {
		return payload
	}
	channelID := "channel-id"
	binary.BigEndian.PutUint16(payload[:2], uint16(len(channelID)))
	copy(payload[2:], channelID)
	return payload
}

func relayEnvelope(channelID string, frame []byte) []byte {
	payload := make([]byte, 2+len(channelID)+len(frame))
	binary.BigEndian.PutUint16(payload, uint16(len(channelID)))
	copy(payload[2:], channelID)
	copy(payload[2+len(channelID):], frame)
	return payload
}

func decodeRelayEnvelope(t *testing.T, payload []byte) (string, []byte) {
	t.Helper()
	require.GreaterOrEqual(t, len(payload), 2)
	channelLength := int(binary.BigEndian.Uint16(payload[:2]))
	require.Greater(t, channelLength, 0)
	require.GreaterOrEqual(t, len(payload), 2+channelLength)
	return string(payload[2 : 2+channelLength]), payload[2+channelLength:]
}

func activeRelayDaemon() *device_entity.Device {
	return &device_entity.Device{
		ID: 9, UserID: 7, Kind: device_entity.KindAgentred, Fingerprint: "fp-daemon", Status: 1,
	}
}

func newRelayServer(t *testing.T, signer *jwt.Signer, svc relay_svc.RelaySvc) *httptest.Server {
	t.Helper()
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{},
		Signer: signer,
		Relay:  svc,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server
}

func newRelayRedisClient(t *testing.T, mini *miniredis.Miniredis) *goredis.Client {
	t.Helper()
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	return client
}

func newLifecycleRelayStub() *relayStub {
	return &relayStub{
		daemonRoute: relay_svc.Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"},
		registered:  make(chan struct{}, 1), renewed: make(chan struct{}, 16),
		daemonFrames: make(chan struct{}, 16), clientFrames: make(chan struct{}, 16),
		daemonDetached: make(chan struct{}, 1), clientDetached: make(chan struct{}, 1),
		daemonWriters: make(chan relay_svc.FrameWriter, 1), clientWriters: make(chan relay_svc.FrameWriter, 1),
	}
}

func newLifecycleRelayServer(
	t *testing.T,
	stub *relayStub,
	path string,
	timing relay_ctr.LifecycleTiming,
	recordDeadlines bool,
) (*httptest.Server, <-chan deadlineEvent) {
	t.Helper()
	controller := relay_ctr.NewWithLifecycleTiming(stub, timing)
	engine := gin.New()
	engine.GET(path, func(c *gin.Context) {
		c.Set("user_id", int64(7))
		c.Set("device_id", int64(9))
		if path == "/v1/relay/daemon" {
			c.Set("device_kind", device_entity.KindAgentred)
			controller.Daemon(c)
			return
		}
		c.Set("device_kind", device_entity.KindDesktop)
		controller.Client(c)
	})

	server := httptest.NewUnstartedServer(engine)
	var deadlines chan deadlineEvent
	if recordDeadlines {
		deadlines = make(chan deadlineEvent, 64)
		server.Listener = &deadlineRecordingListener{Listener: server.Listener, events: deadlines}
	}
	server.Start()
	t.Cleanup(server.Close)
	return server, deadlines
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

func drainRelayConnection(conn *websocket.Conn) {
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

func wsURL(httpURL, path string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http") + path
}

var _ relay_svc.RelaySvc = (*relayStub)(nil)
