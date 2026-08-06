package relay_ctr_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
	"agentre-server/internal/service/relay_svc"
)

type relayStub struct {
	daemonRoute  relay_svc.Route
	clientErr    error
	registered   chan struct{}
	renewed      chan struct{}
	daemonFrames chan struct{}
	clientFrames chan struct{}
}

func (s *relayStub) PrepareDaemon(context.Context, int64, int64, string) (relay_svc.Route, error) {
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

func (s *relayStub) AttachDaemon(context.Context, relay_svc.Route, relay_svc.FrameWriter) (func(), error) {
	return func() {}, nil
}

func (s *relayStub) AttachClient(context.Context, relay_svc.Route, relay_svc.FrameWriter) (func(), error) {
	return func() {}, nil
}

func (s *relayStub) ForwardDaemon(context.Context, relay_svc.Route, int, []byte) error {
	select {
	case s.daemonFrames <- struct{}{}:
	default:
	}
	return nil
}

func (s *relayStub) ForwardClient(context.Context, relay_svc.Route, int, []byte) error {
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
	require.NoError(t, conn.WriteMessage(websocket.TextMessage, []byte("heartbeat")))

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
	clientDevices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), daemon.Fingerprint).Return(daemon, nil)

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

	require.NoError(t, clientConn.WriteMessage(websocket.BinaryMessage, []byte("request")))
	daemonConn.SetReadDeadline(time.Now().Add(time.Second))
	messageType, frame, err := daemonConn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.BinaryMessage, messageType)
	require.Equal(t, []byte("request"), frame)

	require.NoError(t, daemonConn.WriteMessage(websocket.TextMessage, []byte("response")))
	clientConn.SetReadDeadline(time.Now().Add(time.Second))
	messageType, frame, err = clientConn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.TextMessage, messageType)
	require.Equal(t, []byte("response"), frame)
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

func wsURL(httpURL, path string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http") + path
}

var _ relay_svc.RelaySvc = (*relayStub)(nil)
