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
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/controller/relay_ctr/relayws"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

var protobufRelayDialer = websocket.Dialer{Subprotocols: []string{relayws.ProtobufSubprotocol}}

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
	conn, response, err := protobufRelayDialer.Dial(endpoint, nil)
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

func TestRelayEndpointsRequireDeviceJWTAndDaemonRenewsOnHeartbeat(t *testing.T) {
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
	conn, _, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"), headers)
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

	// ForwardDaemon 只拆 relay 的 channel 路由信封；内层 Protobuf RpcFrame 是 opaque
	// bytes，服务端不解析，也不要求它是 UTF-8/JSON。
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage,
		relayEnvelope("channel-id", []byte{0x08, 0x01, 0x12, 0x02, 0xff, 0x00})))

	select {
	case <-stub.daemonFrames:
	case <-time.After(time.Second):
		t.Fatal("daemon frame did not reach the forwarding seam")
	}
	// 上面那个 ping 刚续过一次,紧跟着的这一帧因此被节流掉:在线态续期挂在心跳上,
	// 不再逐帧重复(逐帧那次给每帧多加两次串行 Redis 往返,而转发就跑在读循环上)。
	// 节流本身由 TestRelayDaemonThrottlesOnlineRenewalAcrossFrames 单独钉住。
	select {
	case <-stub.renewed:
		t.Fatal("紧跟在一次续期之后的帧不应该再续一次在线态")
	default:
	}

	clientConn, _, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/client?daemon_fingerprint=fp-daemon"), headers)
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

	targetConn, _, err := protobufRelayDialer.Dial(
		wsURL(server.URL, "/v1/relay/daemon"),
		http.Header{"Authorization": {"Bearer " + targetToken}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, targetConn.Close()) })

	clientConn, response, err := protobufRelayDialer.Dial(
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
			conn, _, err := protobufRelayDialer.Dial(
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
	conn, _, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"), headers)
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
	conn, _, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/client"), headers)
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

	_, response, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"),
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

	daemonConn, _, err := protobufRelayDialer.Dial(
		wsURL(serverB.URL, "/v1/relay/daemon"),
		http.Header{"Authorization": {"Bearer " + daemonToken}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, daemonConn.Close()) })

	clientConn, response, err := protobufRelayDialer.Dial(
		wsURL(serverA.URL, "/v1/relay/client?daemon_fingerprint="+daemon.Fingerprint),
		http.Header{"Authorization": {"Bearer " + clientToken}},
	)
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, clientConn.Close()) })
	otherClientConn, _, err := protobufRelayDialer.Dial(
		wsURL(serverA.URL, "/v1/relay/client?daemon_fingerprint="+daemon.Fingerprint),
		http.Header{"Authorization": {"Bearer " + clientToken}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, otherClientConn.Close()) })

	requestFrame := []byte{0x08, 0x01, 0x12, 0x03, 0x00, 0xff, 0x80}
	require.NoError(t, clientConn.WriteMessage(websocket.BinaryMessage, requestFrame))
	daemonConn.SetReadDeadline(time.Now().Add(time.Second))
	messageType, frame, err := daemonConn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.BinaryMessage, messageType)
	channelID, innerFrame := decodeRelayEnvelope(t, frame)
	require.NotEmpty(t, channelID)
	require.Equal(t, requestFrame, innerFrame, "relay must not parse or rewrite the Protobuf RpcFrame")

	responseFrame := []byte{0x08, 0x01, 0x1a, 0x04, 0xde, 0xad, 0x00, 0xbe}
	require.NoError(t, daemonConn.WriteMessage(websocket.BinaryMessage, relayEnvelope(channelID, responseFrame)))
	clientConn.SetReadDeadline(time.Now().Add(time.Second))
	messageType, frame, err = clientConn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.BinaryMessage, messageType)
	require.Equal(t, responseFrame, frame, "relay must preserve opaque Protobuf response bytes")

	otherClientConn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	_, _, err = otherClientConn.ReadMessage()
	require.Error(t, err)
	var networkErr net.Error
	require.ErrorAs(t, err, &networkErr)
	require.True(t, networkErr.Timeout())
}

// 中继的两个 websocket 端点只在 upgrade 那一刻过一次鉴权中间件，之后不再经过任何
// 中间件。凭据在连接建好**之后**被撤销时，服务端必须自己把这条连接掐掉，否则登出与
// 设备撤销都只挡得住新连接，一条撤销前建好的连接会继续读写该账号的全部会话。
//
// 下面两个用例用「对端主动发一个 ping」逼服务端立刻复查（生产里这件事由 15s 心跳
// 承担，不依赖对端配合）。断开必须是一个真正的 websocket 关闭帧，好让对端能把它与
// 网络中断区分开：daemon 会退避重连，重连在 upgrade 处被拒才是正确结局。
func TestRelayClientClosesWhenIssuingSessionEnds(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	auth := auth_svc.New(session.New(redis.Default(), "server_session", 86400))
	auth_svc.SetDefault(auth)
	ctx := context.Background()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	// 同一个账号的两个浏览器：各自一次登录会话，各自一张 relay ticket。
	sidA, _, err := auth.StartSession(ctx, 7)
	require.NoError(t, err)
	sidB, _, err := auth.StartSession(ctx, 7)
	require.NoError(t, err)
	ticketA, jtiA, err := signer.Sign(jwt.Claims{UID: 7, Kind: "relay_client"}, 2*time.Minute)
	require.NoError(t, err)
	ticketB, jtiB, err := signer.Sign(jwt.Claims{UID: 7, Kind: "relay_client"}, 2*time.Minute)
	require.NoError(t, err)
	require.NoError(t, auth.TrackRelayTicket(ctx, sidA, jtiA, 2*time.Minute))
	require.NoError(t, auth.TrackRelayTicket(ctx, sidB, jtiB, 2*time.Minute))

	server := newRelayServer(t, signer, newForwardingRelayStub())
	connA := dialRelayClient(t, server, ticketA)
	connB := dialRelayClient(t, server, ticketB)

	require.NoError(t, auth.EndSession(ctx, sidA))

	requireRelayPeerClosed(t, connA, "登出后这次会话建好的 client 连接必须被断开")
	requireRelayPeerAlive(t, connB, "登出一个浏览器不能踢掉同账号另一个浏览器的连接")
}

// 撤销必须能掐到「连接挂在另一个 server 副本上」的情形：撤销请求落在哪个实例上无关
// 紧要，判据是共享 Redis 里的 jti 黑名单（device_svc.Revoke 已经在写它），持有那条
// 连接的实例自己读得到，不需要任何实例间寻址。
func TestRelayDaemonClosesWhenDeviceCredentialRevokedOnAnotherInstance(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	ctx := context.Background()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	serverA := newRelayServer(t, signer, newForwardingRelayStub())
	serverB := newRelayServer(t, signer, newForwardingRelayStub())

	keptToken, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 9, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	revokedToken, revokedJTI, err := signer.Sign(
		jwt.Claims{UID: 7, DID: 10, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)

	kept := dialRelayDaemon(t, serverA, keptToken)       // 账号下另一台 daemon，挂在实例 A
	revoked := dialRelayDaemon(t, serverB, revokedToken) // 被撤销的那台，挂在实例 B

	// device_svc.Revoke 的既有动作：把该设备已签发的 access token jti 全部拉黑。
	require.NoError(t, jwtblacklist.Add(ctx, revokedJTI, int(15*time.Minute/time.Second)))

	requireRelayPeerClosed(t, revoked, "设备撤销后它已经建好的 daemon 连接必须被断开")
	requireRelayPeerAlive(t, kept, "撤销一台设备不能踢掉同账号另一台设备的 daemon 连接")
}

func dialRelayClient(t *testing.T, server *httptest.Server, ticket string) *websocket.Conn {
	t.Helper()
	conn, response, err := protobufRelayDialer.Dial(
		wsURL(server.URL, "/v1/relay/client?daemon_fingerprint=fp-daemon&access_token="+ticket), nil)
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func dialRelayDaemon(t *testing.T, server *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	conn, response, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"),
		http.Header{"Authorization": {"Bearer " + token}})
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// requireRelayPeerClosed 先发一个 ping 逼服务端复查凭据，再要求读到一个真正的关闭帧
// （而不是对端只能看见 EOF 的 1006 异常断开）。
func requireRelayPeerClosed(t *testing.T, conn *websocket.Conn, failure string) {
	t.Helper()
	// 服务端可能已经先一步关掉了连接，写 ping 失败本身不是断言对象。
	_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second))
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(2*time.Second)))
	_, _, err := conn.ReadMessage()
	require.Error(t, err, failure)
	require.True(t, websocket.IsCloseError(err, websocket.ClosePolicyViolation), "%s: %v", failure, err)
}

func requireRelayPeerAlive(t *testing.T, conn *websocket.Conn, failure string) {
	t.Helper()
	require.NoError(t, conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)))
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(300*time.Millisecond)))
	_, _, err := conn.ReadMessage()
	require.Error(t, err, failure)
	var networkErr net.Error
	require.ErrorAs(t, err, &networkErr, "%s: %v", failure, err)
	require.True(t, networkErr.Timeout(), "%s: %v", failure, err)
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

// 封禁只能改库（产品里没有封禁动作），因此它对一条**已经建好**的中继连接的生效路径
// 只有一条：逐次复查时闸门的缓存到期、重新查库、判出 UserBanned。这里用独享 miniredis
// 的 FastForward 让缓存到期，再用一个 ping 逼服务端立刻复查（生产里由 15s 心跳承担，
// 不依赖对端配合）。
func TestRelayDaemonClosesWhenAccountBannedAfterConnect(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	const gateTTL = time.Minute
	banned := installRelayAccountGate(t, gateTTL)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	server := newRelayServer(t, signer, newForwardingRelayStub())
	bannedToken, _, err := signer.Sign(
		jwt.Claims{UID: 7, DID: 9, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	keptToken, _, err := signer.Sign(
		jwt.Claims{UID: 8, DID: 10, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	// client 那条连接的票要挂在一次**真实存在**的登录会话上：否则归属会话查无此 key，
	// 既有的凭据复查自己就会断开它，用例便测不出账号闸门有没有生效。
	ctx := context.Background()
	auth := auth_svc.New(session.New(redis.Default(), "server_session", 86400))
	auth_svc.SetDefault(auth)
	sid, _, err := auth.StartSession(ctx, 7)
	require.NoError(t, err)
	ticket, jti, err := signer.Sign(jwt.Claims{UID: 7, Kind: "relay_client"}, 2*time.Minute)
	require.NoError(t, err)
	require.NoError(t, auth.TrackRelayTicket(ctx, sid, jti, 2*time.Minute))

	bannedDaemon := dialRelayDaemon(t, server, bannedToken)
	bannedClient := dialRelayClient(t, server, ticket)
	keptDaemon := dialRelayDaemon(t, server, keptToken)

	banned.ban()

	requireRelayPeerClosed(t, bannedDaemon, "账号被封后它已经建好的 daemon 连接必须被断开")
	requireRelayPeerClosed(t, bannedClient, "账号被封后它已经建好的 client 连接必须被断开")
	requireRelayPeerAlive(t, keptDaemon, "封一个账号不能踢掉另一个账号的连接")
}

// relayAccountGate 是上面那个用例的封禁开关：ban() 之后既翻转库里的状态，也把闸门
// 已缓存的「可用」结论快进到过期——否则封禁最多要等一个 TTL 才可观察，用例就得真的睡。
type relayAccountGate struct {
	banned *atomic.Bool
	expire func()
}

func (g *relayAccountGate) ban() {
	g.banned.Store(true)
	g.expire()
}

func installRelayAccountGate(t *testing.T, ttl time.Duration) *relayAccountGate {
	t.Helper()
	banned := &atomic.Bool{}
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	repo := mock_user_repo.NewMockUserRepo(ctrl)
	repo.EXPECT().FindIgnoreStatus(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, id int64) (*user_entity.User, error) {
			status := consts.ACTIVE
			if id == 7 && banned.Load() {
				status = consts.BAN
			}
			return &user_entity.User{ID: id, Status: status}, nil
		}).AnyTimes()
	user_repo.RegisterUser(repo)

	mini := miniredis.RunT(t)
	client := newRelayRedisClient(t, mini)
	user_svc.SetGate(user_svc.NewGate(client, ttl))
	t.Cleanup(func() {
		user_svc.SetGate(nil)
		user_repo.RegisterUser(nil)
	})
	return &relayAccountGate{banned: banned, expire: func() { mini.FastForward(ttl + time.Second) }}
}

// daemon 读循环里的在线态续期必须节流。在线态 TTL 是 30 秒,而心跳的 pong 每 15 秒
// 就会走一次 OnPeerActivity 续期(见上面那个用例),于是「每收一帧再续一次」是纯冗余
// ——代价却不小:RenewDaemon 是 GET + EXPIRE 两次**串行** Redis 往返,而转发就跑在
// 这条读循环上,这两次往返原样计入每一帧的转发延迟。一次 LLM 流式回答每秒几十上百
// 个 text_delta,逐帧续期能把单条 daemon 连接的吞吐直接压掉三分之二。
//
// 保留读循环这一路(而不是删掉、只靠 pong)是因为:一条只顾发数据、pong 迟迟不来的
// 连接,读超时是 45 秒而 TTL 只有 30 秒,中间那 15 秒它会被当成离线。
func TestRelayDaemonThrottlesOnlineRenewalAcrossFrames(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	const frames = 5
	stub := &relayStub{
		daemonRoute:  relay_svc.Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"},
		registered:   make(chan struct{}, 1),
		renewed:      make(chan struct{}, frames),
		daemonFrames: make(chan struct{}, frames),
	}

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{},
		Signer: signer,
		Relay:  stub,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 9, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	conn, _, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/daemon"),
		http.Header{"Authorization": {"Bearer " + token}})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, conn.Close()) })
	go drainRelayConnection(conn)
	receiveWithin(t, stub.registered, time.Second, "daemon was never registered")

	// 连续发帧,不发 ping —— 唯一可能触发续期的就是读循环自己。
	for range frames {
		require.NoError(t, conn.WriteMessage(websocket.BinaryMessage,
			relayEnvelope("channel-id", []byte{0x08, 0x01})))
	}
	for i := range frames {
		receiveWithin(t, stub.daemonFrames, time.Second,
			"daemon frame "+strconv.Itoa(i)+" did not reach the forwarding seam")
	}

	// 登记这一步刚刚把 TTL 写满,这一串帧一次续期都不该再发。
	require.Empty(t, stub.renewed, "读循环对每一帧都续了一次在线态")
}
