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
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/testutils"

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
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
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

func (s *relayStub) ResolveTarget(ctx context.Context, accountID int64, target string) (relay_svc.Route, error) {
	return s.ConnectClient(ctx, accountID, target)
}

// 票据认得出账号，而目标由通道自己声明（决策 10）：URL 上不再有 daemon_fingerprint，
// 两者在通道开通那一刻汇合。
func TestRelayClientAcceptsSessionTicketFromQuery(t *testing.T) {
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	ticket, _, err := signer.Sign(jwt.Claims{UID: 7, Kind: "relay_client"}, time.Minute)
	require.NoError(t, err)

	stub := newForwardingRelayStub()
	stub.clientAccounts = make(chan int64, 1)
	stub.clientTargets = make(chan string, 1)
	server := newRelayServer(t, signer, stub)
	endpoint := wsURL(server.URL, "/v1/relay/client?access_token="+ticket)
	conn, response, err := protobufRelayDialer.Dial(endpoint, nil)
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, conn.Close()) })
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage,
		relayEnvelope("c1", []byte("machine:fp-daemon"))))
	require.Equal(t, int64(7), receiveWithin(t, stub.clientAccounts, time.Second,
		"relay ticket user id did not reach the channel target resolver"))
	require.Equal(t, "machine:fp-daemon", receiveWithin(t, stub.clientTargets, time.Second,
		"relay channel target did not reach the resolver"))
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
	testutils.Redis(t)
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

	clientConn, _, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/client"), headers)
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
	require.NoError(t, clientConn.WriteMessage(websocket.BinaryMessage,
		relayEnvelope("c1", []byte("machine:fp-daemon"))))
	require.NoError(t, clientConn.WriteMessage(websocket.BinaryMessage,
		relayEnvelope("c1", []byte("request"))))
	select {
	case <-stub.clientFrames:
	case <-time.After(time.Second):
		t.Fatal("client frame did not reach the forwarding seam")
	}
}

func TestDesktopRelayTargetCanBeAddressedThroughEndpoints(t *testing.T) {
	testutils.Redis(t)
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
		config, devices, nil, redisClient, relay_svc.NewRedisForwarder(config, redisClient),
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
		wsURL(server.URL, "/v1/relay/client"),
		http.Header{"Authorization": {"Bearer " + clientToken}},
	)
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, clientConn.Close()) })

	// 可寻址与否现在是逐通道判的，所以判据也得逐通道看：一条声明了这台桌面端的
	// 通道，其请求确实落到了它身上。
	request := []byte{0x08, 0x01, 0x12, 0x01, 0x2a}
	require.NoError(t, clientConn.WriteMessage(websocket.BinaryMessage,
		relayEnvelope("c1", []byte("machine:"+desktop.Fingerprint))))
	require.NoError(t, clientConn.WriteMessage(websocket.BinaryMessage, relayEnvelope("c1", request)))
	require.NoError(t, targetConn.SetReadDeadline(time.Now().Add(2*time.Second)))
	messageType, frame, err := targetConn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.BinaryMessage, messageType)
	_, inner := decodeRelayEnvelope(t, frame)
	require.Equal(t, request, inner)
}

func TestRelayLifecycleRejectsOversizedMessagesAndDetaches(t *testing.T) {
	testutils.Redis(t)
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
			name: "client", path: "/v1/relay/client", kind: device_entity.KindDesktop, daemonWire: true,
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
			if tc.path == "/v1/relay/client" {
				// 客户端那条链路上通道要先声明目标，之后的帧才是载荷。
				require.NoError(t, conn.WriteMessage(websocket.BinaryMessage,
					relayEnvelope("channel-id", []byte("machine:fp-daemon"))))
			}
			// 上限是**载荷**的上限，三个仓同一个数（relayws.MaxPayloadBytes）。
			// 两条链路上跑的都是信封（2 字节长度 + 通道 ID），所以读上限都要比载荷
			// 预算高出一个信封头 —— 否则一份刚好 10 MiB 的合法载荷，只因为带了信封
			// 就被 1009 打掉，而且打掉的是**整条**物理连接，上面所有虚拟通道一起陪葬。
			limit := int(relayws.MaxPayloadBytes)
			if tc.daemonWire {
				limit += int(relayws.MaxEnvelopeBytes)
			}
			require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, relayPayloadOfSize(limit, tc.daemonWire)))
			receiveWithin(t, tc.framesOf(stub), time.Second, "maximum relay message was not accepted")
			require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, relayPayloadOfSize(limit+1, tc.daemonWire)))
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

// 转发失败发生在通道开通**之后**：它同样只判死那一条通道。从前它关掉整条客户端
// 连接，那时一条连接只有一条通道，两者是同一件事；现在连接上还跑着别人的通道。
func TestRelayClientForwardingErrorFailsOnlyThatChannel(t *testing.T) {
	stub := newForwardingRelayStub()
	stub.clientForwardErrs = make(chan error, 1)
	stub.clientForwardErrs <- relay_svc.ErrForwardFailed
	server, headers := newAuthenticatedRelayServer(t, stub, "/v1/relay/client")
	conn, _, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/client"), headers)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	link := newClientLink(conn)

	link.open(t, "c-broken", "machine:fp-daemon")
	link.send(t, "c-broken", []byte("request"))
	receiveWithin(t, stub.clientFrames, time.Second, "failed client request did not reach forwarding")
	require.Equal(t, relay_svc.ChannelCodeForwardFailed,
		requireChannelError(t, link.next(t, "c-broken", "转发失败没有给出通道级错误")))
	require.Empty(t, link.next(t, "c-broken", "失败的通道必须随即关闭"))

	// 连接还在：还能开新通道、还能转发。
	link.open(t, "c-live", "machine:fp-daemon")
	link.send(t, "c-live", []byte("request"))
	receiveWithin(t, stub.clientFrames, time.Second, "一条通道转发失败连坐了整条连接")
}

// PrepareDaemon 的准入判据（本账号名下、活跃且可寻址的设备）被拒时必须走 403，
// 而且必须**在 websocket upgrade 之前**答复：不支持的设备种类拿不到升级后的连接，
// 也就没机会占住这个账号+指纹的中继路由。
func TestRelayDaemonForbiddenAnswers403BeforeUpgrading(t *testing.T) {
	testutils.Redis(t)
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

// 通道开通失败的三种理由必须互相区分得开。从前它们是三个 HTTP 状态码，那时目标在
// 连接级、判定在 upgrade 之前；目标下沉到通道之后判定在 upgrade 之后，于是同一组
// 区分改由通道级错误码承担——每个码仍对应 upgrade 前那一版的业务码与文案。
func TestRelayClientChannelFailureCodesAreDistinct(t *testing.T) {
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 4, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)

	for _, tc := range []struct {
		name string
		err  error
		code int32
	}{
		{name: "not found", err: relay_svc.ErrDaemonNotFound, code: relay_svc.ChannelCodeTargetNotFound},
		{name: "offline", err: relay_svc.ErrDaemonOffline, code: relay_svc.ChannelCodeTargetOffline},
		{name: "forward failed", err: relay_svc.ErrForwardFailed, code: relay_svc.ChannelCodeForwardFailed},
		{name: "forbidden target", err: relay_svc.ErrDaemonForbidden, code: relay_svc.ChannelCodeTargetForbidden},
		{name: "malformed target", err: relay_svc.ErrTargetInvalid, code: relay_svc.ChannelCodeTargetInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := &relayStub{
				clientErr: tc.err, registered: make(chan struct{}, 1), renewed: make(chan struct{}, 1),
				daemonFrames: make(chan struct{}, 1), clientFrames: make(chan struct{}, 1),
				clientDetached: make(chan struct{}, 1),
			}
			server := newRelayServer(t, signer, stub)
			conn, _, err := protobufRelayDialer.Dial(wsURL(server.URL, "/v1/relay/client"),
				http.Header{"Authorization": {"Bearer " + token}})
			require.NoError(t, err, "目标失败不再挡在 upgrade 之前")
			t.Cleanup(func() { _ = conn.Close() })
			link := newClientLink(conn)

			link.open(t, "c1", "machine:fp-daemon")
			require.Equal(t, tc.code, requireChannelError(t, link.next(t, "c1", "通道开通失败没有答复")))
			require.Empty(t, link.next(t, "c1", "失败的通道必须随即关闭"))
		})
	}
}

func TestRelayFramesCrossServerInstances(t *testing.T) {
	testutils.Redis(t)
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
		configA, clientDevices, nil, redisA, relay_svc.NewRedisForwarder(configA, redisA),
	))
	configB := relay_svc.Config{InstanceID: "server-b", OnlineTTL: time.Second}
	redisB := newRelayRedisClient(t, mini)
	serverB := newRelayServer(t, signer, relay_svc.New(
		configB, daemonDevices, nil, redisB, relay_svc.NewRedisForwarder(configB, redisB),
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
		wsURL(serverA.URL, "/v1/relay/client"),
		http.Header{"Authorization": {"Bearer " + clientToken}},
	)
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, clientConn.Close()) })
	otherClientConn, _, err := protobufRelayDialer.Dial(
		wsURL(serverA.URL, "/v1/relay/client"),
		http.Header{"Authorization": {"Bearer " + clientToken}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, otherClientConn.Close()) })

	link := newClientLink(clientConn)
	otherLink := newClientLink(otherClientConn)
	// 两条连接各开一条通道，都指向同一台机器：帧不能串道。
	link.open(t, "c1", "machine:"+daemon.Fingerprint)
	otherLink.open(t, "c1", "machine:"+daemon.Fingerprint)

	requestFrame := []byte{0x08, 0x01, 0x12, 0x03, 0x00, 0xff, 0x80}
	link.send(t, "c1", requestFrame)
	daemonConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	messageType, frame, err := daemonConn.ReadMessage()
	require.NoError(t, err)
	require.Equal(t, websocket.BinaryMessage, messageType)
	channelID, innerFrame := decodeRelayEnvelope(t, frame)
	require.NotEmpty(t, channelID)
	require.Equal(t, requestFrame, innerFrame, "relay must not parse or rewrite the Protobuf RpcFrame")

	responseFrame := []byte{0x08, 0x01, 0x1a, 0x04, 0xde, 0xad, 0x00, 0xbe}
	require.NoError(t, daemonConn.WriteMessage(websocket.BinaryMessage, relayEnvelope(channelID, responseFrame)))
	require.Equal(t, responseFrame, link.next(t, "c1", "跨副本的应答没有回到发起它的那条通道"),
		"relay must preserve opaque Protobuf response bytes")

	otherLink.requireQuiet(t, "c1", "另一条连接上同号的通道收到了不属于它的帧")
}

// 中继的两个 websocket 端点只在 upgrade 那一刻过一次鉴权中间件，之后不再经过任何
// 中间件。凭据在连接建好**之后**被撤销时，服务端必须自己把这条连接掐掉，否则登出与
// 设备撤销都只挡得住新连接，一条撤销前建好的连接会继续读写该账号的全部会话。
//
// 下面两个用例用「对端主动发一个 ping」逼服务端立刻复查（生产里这件事由 15s 心跳
// 承担，不依赖对端配合）。断开必须是一个真正的 websocket 关闭帧，好让对端能把它与
// 网络中断区分开：daemon 会退避重连，重连在 upgrade 处被拒才是正确结局。
func TestRelayClientClosesWhenIssuingSessionEnds(t *testing.T) {
	testutils.Redis(t)
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
	testutils.Redis(t)
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
		wsURL(server.URL, "/v1/relay/client?access_token="+ticket), nil)
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
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
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
	server, _ := newRelayServerWithDeps(t, signer, svc)
	return server
}

// newRelayServerWithDeps 额外交回装配用的 RouterDeps —— 优雅下线那条路要拿它
// 排空中继 websocket(DrainRelays)。
func newRelayServerWithDeps(
	t *testing.T, signer *jwt.Signer, svc relay_svc.RelaySvc,
) (*httptest.Server, *api.RouterDeps) {
	t.Helper()
	return newRelayServerDeps(t, signer, svc,
		accountchan_svc.New(newRelayRedisClient(t, miniredis.RunT(t))))
}

// newRelayServerWithAccountChan 换掉账号信号那一路的实现：中继客户端连接现在同时
// 承载保留通道上的账号信号（决策 13），所以它是这个端点装配的一部分。
func newRelayServerWithAccountChan(
	t *testing.T, signer *jwt.Signer, svc relay_svc.RelaySvc,
	accountChan accountchan_svc.AccountChanSvc,
) *httptest.Server {
	t.Helper()
	server, _ := newRelayServerDeps(t, signer, svc, accountChan)
	return server
}

func newRelayServerDeps(
	t *testing.T, signer *jwt.Signer, svc relay_svc.RelaySvc,
	accountChan accountchan_svc.AccountChanSvc,
) (*httptest.Server, *api.RouterDeps) {
	t.Helper()
	testMux := muxtest.NewTestMux()
	deps := &api.RouterDeps{
		Cfg:         &bootstrap.ServerConfig{},
		Signer:      signer,
		Relay:       svc,
		AccountChan: accountChan,
	}
	require.NoError(t, deps.Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server, deps
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
	testutils.Redis(t)
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
	testutils.Redis(t)
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
	testutils.Redis(t)
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

/*
优雅下线:副本要走的时候,先告诉对端再关。

不这么做的话,对端读到的是 1006 —— 与网线被拔一模一样,于是它按网络抖动退避
重试。而这一次它本该立刻重连、并落到另一个还活着的副本上(LB 已经把这个 Pod
摘出去了)。1001(Going Away)是唯一能把这两件事分开的信号。

同时 handler 必须**返回**:它的 detach 是把这条连接从帧总线上摘掉的唯一一步,
而 mux 的 Shutdown 会等 handler 返回 —— 读循环阻塞在 ReadMessage 上不返回,
整个进程就卡在停止那一步直到被 SIGKILL。
*/
func TestRelayDrainTellsPeersAndReleasesHandlers(t *testing.T) {
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	stub := &relayStub{
		daemonRoute:    relay_svc.Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"},
		registered:     make(chan struct{}, 1),
		renewed:        make(chan struct{}, 1),
		daemonFrames:   make(chan struct{}, 1),
		clientFrames:   make(chan struct{}, 1),
		daemonDetached: make(chan struct{}, 1),
		clientDetached: make(chan struct{}, 1),
	}
	server, deps := newRelayServerWithDeps(t, signer, stub)
	token, _, err := signer.Sign(
		jwt.Claims{UID: 7, DID: 9, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)
	conn, _, err := protobufRelayDialer.Dial(
		wsURL(server.URL, "/v1/relay/daemon"), http.Header{"Authorization": {"Bearer " + token}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	receiveWithin(t, stub.registered, time.Second, "daemon did not register")

	require.Positive(t, deps.DrainRelays(), "排空必须数到这条 daemon 连接")

	require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
	_, _, err = conn.ReadMessage()
	require.True(t, websocket.IsCloseError(err, websocket.CloseGoingAway),
		"daemon 必须收到 1001 而不是 1006: %v", err)
	receiveWithin(t, stub.daemonDetached, time.Second,
		"排空之后 handler 没有返回:它的 detach 一直没跑,mux 的 Shutdown 会一直等它")
}
