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
	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
	"agentre-server/internal/service/relay_svc"
)

type relayStub struct {
	daemonRoute       relay_svc.Route
	daemonErr         error
	clientErr         error
	registered        chan struct{}
	renewed           chan struct{}
	daemonFrames      chan struct{}
	clientFrames      chan struct{}
	daemonForwardErrs chan error
	clientForwardErrs chan error
	daemonDetached    chan struct{}
	clientDetached    chan struct{}
	clientAccounts    chan int64
	clientTargets     chan string
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

func (s *relayStub) ConnectClient(_ context.Context, accountID int64, target string) (relay_svc.Route, error) {
	if s.clientAccounts != nil {
		s.clientAccounts <- accountID
	}
	if s.clientTargets != nil {
		s.clientTargets <- target
	}
	if s.clientErr != nil {
		return relay_svc.Route{}, s.clientErr
	}
	return s.daemonRoute, nil
}

func TestRelayClientAcceptsSessionTicketFromQuery(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	ticket, _, err := signer.Sign(jwt.Claims{UID: 7, Kind: "relay_client"}, time.Minute)
	require.NoError(t, err)

	stub := newForwardingRelayStub()
	stub.clientAccounts = make(chan int64, 1)
	stub.clientTargets = make(chan string, 1)
	server := newRelayServer(t, signer, stub)
	endpoint := wsURL(server.URL, "/v1/relay/client?daemon_fingerprint=fp-daemon&access_token="+ticket)
	conn, response, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, conn.Close()) })
	require.Equal(t, int64(7), receiveWithin(t, stub.clientAccounts, time.Second,
		"relay ticket user id did not reach ConnectClient"))
	require.Equal(t, "fp-daemon", receiveWithin(t, stub.clientTargets, time.Second,
		"relay target did not reach ConnectClient"))
}

func (s *relayStub) IsDaemonOnline(context.Context, int64, string) (bool, error) {
	return false, nil
}

func (s *relayStub) AttachDaemon(_ context.Context, _ relay_svc.Route, _ relay_svc.FrameWriter) (func(), error) {
	return func() {
		select {
		case s.daemonDetached <- struct{}{}:
		default:
		}
	}, nil
}

func (s *relayStub) AttachClient(_ context.Context, _ relay_svc.Route, _ relay_svc.FrameWriter) (string, func(), error) {
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
	select {
	case err := <-s.daemonForwardErrs:
		return err
	default:
		return nil
	}
}

func (s *relayStub) ForwardClient(context.Context, relay_svc.Route, string, int, []byte) error {
	select {
	case s.clientFrames <- struct{}{}:
	default:
	}
	select {
	case err := <-s.clientForwardErrs:
		return err
	default:
		return nil
	}
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
	daemonPongs := make(chan struct{}, 1)
	conn.SetPongHandler(func(string) error {
		select {
		case daemonPongs <- struct{}{}:
		default:
		}
		return nil
	})
	go drainRelayConnection(conn)
	require.NoError(t, conn.WriteControl(websocket.PingMessage, []byte("route"), time.Now().Add(time.Second)))
	receiveWithin(t, stub.renewed, time.Second, "daemon ping did not renew its route")
	receiveWithin(t, daemonPongs, time.Second, "daemon ping did not receive a pong")

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
	clientPongs := make(chan struct{}, 1)
	clientConn.SetPongHandler(func(string) error {
		select {
		case clientPongs <- struct{}{}:
		default:
		}
		return nil
	})
	go drainRelayConnection(clientConn)
	require.NoError(t, clientConn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)))
	receiveWithin(t, clientPongs, time.Second, "client ping did not receive a pong")
	select {
	case <-stub.renewed:
		t.Fatal("client ping renewed a daemon route")
	default:
	}
	require.NoError(t, clientConn.WriteMessage(websocket.BinaryMessage, []byte("request")))
	select {
	case <-stub.clientFrames:
	case <-time.After(time.Second):
		t.Fatal("client frame did not reach the forwarding seam")
	}
}

func TestDesktopRelayTargetCanBeAddressedThroughEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	mini := miniredis.RunT(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	controller := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(controller)
	desktop := &device_entity.Device{
		ID: 10, UserID: 7, Kind: device_entity.KindDesktop, Fingerprint: "fp-desktop", Status: 1,
	}
	devices.EXPECT().Find(gomock.Any(), desktop.ID).Return(desktop, nil)
	devices.EXPECT().FindByFingerprint(gomock.Any(), desktop.UserID, desktop.Fingerprint).Return(desktop, nil)

	config := relay_svc.Config{InstanceID: "server-a", OnlineTTL: time.Second}
	redisClient := newRelayRedisClient(t, mini)
	server := newRelayServer(t, signer, relay_svc.New(
		config, devices, redisClient, relay_svc.NewRedisForwarder(config, redisClient),
	))
	targetToken, _, err := signer.Sign(jwt.Claims{
		UID: desktop.UserID, DID: desktop.ID, Kind: device_entity.KindDesktop,
	}, time.Hour)
	require.NoError(t, err)
	clientToken, _, err := signer.Sign(jwt.Claims{
		UID: desktop.UserID, DID: 4, Kind: device_entity.KindAgentred,
	}, time.Hour)
	require.NoError(t, err)

	targetConn, _, err := websocket.DefaultDialer.Dial(
		wsURL(server.URL, "/v1/relay/daemon"),
		http.Header{"Authorization": {"Bearer " + targetToken}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, targetConn.Close()) })

	clientConn, response, err := websocket.DefaultDialer.Dial(
		wsURL(server.URL, "/v1/relay/client?daemon_fingerprint="+desktop.Fingerprint),
		http.Header{"Authorization": {"Bearer " + clientToken}},
	)
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, clientConn.Close()) })
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

func TestRelayDaemonContinuesAfterClientDeliveryForwardingError(t *testing.T) {
	stub := newForwardingRelayStub()
	stub.daemonForwardErrs = make(chan error, 2)
	stub.daemonForwardErrs <- relay_svc.ErrForwardFailed
	stub.daemonForwardErrs <- nil
	server, headers := newAuthenticatedRelayServer(t, stub, "/v1/relay/daemon")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"), headers)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	require.NoError(t, conn.WriteMessage(
		websocket.BinaryMessage, relayEnvelope("stale-channel", []byte("late-response")),
	))
	receiveWithin(t, stub.daemonFrames, time.Second, "failed daemon response did not reach forwarding")
	require.NoError(t, conn.WriteMessage(
		websocket.BinaryMessage, relayEnvelope("live-channel", []byte("later-response")),
	))
	receiveWithin(t, stub.daemonFrames, time.Second,
		"client delivery failure closed the shared daemon websocket before a later response")
}

func TestRelayClientForwardingErrorStillClosesClientConnection(t *testing.T) {
	stub := newForwardingRelayStub()
	stub.clientForwardErrs = make(chan error, 1)
	stub.clientForwardErrs <- relay_svc.ErrForwardFailed
	server, headers := newAuthenticatedRelayServer(t, stub, "/v1/relay/client")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(server.URL, "/v1/relay/client"), headers)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, []byte("request")))
	receiveWithin(t, stub.clientFrames, time.Second, "failed client request did not reach forwarding")
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
	_, _, err = conn.ReadMessage()
	require.Error(t, err)
}

// PrepareDaemon 的准入判据（本账号名下、活跃且可寻址的设备）被拒时必须走 403，
// 而且必须**在 websocket upgrade 之前**答复：不支持的设备种类拿不到升级后的连接，
// 也就没机会占住这个账号+指纹的中继路由。
func TestRelayDaemonForbiddenAnswers403BeforeUpgrading(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 4, Kind: device_entity.KindWeb}, time.Hour)
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
	testutils.Redis()
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

func newForwardingRelayStub() *relayStub {
	return &relayStub{
		daemonRoute: relay_svc.Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"},
		registered:  make(chan struct{}, 1), renewed: make(chan struct{}, 16),
		daemonFrames: make(chan struct{}, 16), clientFrames: make(chan struct{}, 16),
		daemonDetached: make(chan struct{}, 1), clientDetached: make(chan struct{}, 1),
	}
}

func newAuthenticatedRelayServer(
	t *testing.T,
	stub *relayStub,
	path string,
) (*httptest.Server, http.Header) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	server := newRelayServer(t, signer, stub)

	kind := device_entity.KindDesktop
	if path == "/v1/relay/daemon" {
		kind = device_entity.KindAgentred
	}
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 9, Kind: kind}, time.Hour)
	require.NoError(t, err)
	return server, http.Header{"Authorization": {"Bearer " + token}}
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
