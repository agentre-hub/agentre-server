package accountchan_ctr_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
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
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

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
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

// 通道是**账号级**且**跨副本**的：同一个账号连在两个不同 server 实例上的两条
// websocket，都要收到任一副本发出的那一次广播。进程内的扇出会让第二条连接永远
// 等不到帧，按账号隔离没做对则会让别的账号收到不属于它的信号。
func TestAccountChannelDeliversOneBroadcastToConnectionsOnTwoReplicas(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer := newChannelSigner(t)
	mini := miniredis.RunT(t)
	replicaA := accountchan_svc.New(newChannelRedis(t, mini))
	replicaB := accountchan_svc.New(newChannelRedis(t, mini))
	serverA := newChannelServer(t, signer, replicaA)
	serverB := newChannelServer(t, signer, replicaB)

	onA := dialChannelWithToken(t, serverA, deviceToken(t, signer, 7, 9))
	onB := dialChannelWithToken(t, serverB, deviceToken(t, signer, 7, 10))
	otherAccount := dialChannelWithToken(t, serverB, deviceToken(t, signer, 8, 11))

	require.NoError(t, replicaA.Broadcast(context.Background(), 7,
		accountchan_svc.Frame{Type: accountchan_svc.FrameTypeSyncVersion, Version: 42}))

	require.Equal(t, accountchan_svc.Frame{Type: accountchan_svc.FrameTypeSyncVersion, Version: 42},
		readChannelFrame(t, onA, "发起广播的那个副本上的连接没收到信号"))
	require.Equal(t, accountchan_svc.Frame{Type: accountchan_svc.FrameTypeSyncVersion, Version: 42},
		readChannelFrame(t, onB, "另一个副本上的连接没收到信号：扇出没有跨副本"))
	requireChannelSilent(t, otherAccount, "另一个账号的连接收到了不属于它的信号")
}

// 两种凭据都能建连：桌面端用 Device JWT 走请求头，浏览器不能给原生 WebSocket 设头，
// 沿用中继既有的 query 搬运（queryTokenBridge）带一张短效票据。没有凭据的一律 401。
func TestAccountChannelAcceptsDeviceJWTAndBrowserTicket(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	ctx := context.Background()
	signer := newChannelSigner(t)
	auth := auth_svc.New(session.New(redis.Default(), "server_session", 86400))
	auth_svc.SetDefault(auth)
	svc := accountchan_svc.New(newChannelRedis(t, miniredis.RunT(t)))
	server := newChannelServer(t, signer, svc)

	anonymous, err := http.NewRequest(http.MethodGet, server.URL+"/v1/account/channel", nil)
	require.NoError(t, err)
	response, err := http.DefaultClient.Do(anonymous)
	require.NoError(t, err)
	require.Equal(t, http.StatusUnauthorized, response.StatusCode, "没有凭据不能建连")
	require.NoError(t, response.Body.Close())

	desktop := dialChannelWithToken(t, server, deviceToken(t, signer, 7, 9))
	browser := dialChannelWithTicket(t, server, browserTicket(t, signer, auth, 7))

	require.NoError(t, svc.Broadcast(ctx, 7,
		accountchan_svc.Frame{Type: accountchan_svc.FrameTypeSyncVersion, Version: 7}))

	require.Equal(t, accountchan_svc.Frame{Type: accountchan_svc.FrameTypeSyncVersion, Version: 7},
		readChannelFrame(t, desktop, "Device JWT 建的连接没收到信号"))
	require.Equal(t, accountchan_svc.Frame{Type: accountchan_svc.FrameTypeSyncVersion, Version: 7},
		readChannelFrame(t, browser, "浏览器票据建的连接没收到信号"))
}

func TestAccountChannelEncodesEverySignalAsWireNotification(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer := newChannelSigner(t)
	svc := accountchan_svc.New(newChannelRedis(t, miniredis.RunT(t)))
	server := newChannelServer(t, signer, svc)
	conn := dialChannelWithToken(t, server, deviceToken(t, signer, 7, 9))

	tests := []struct {
		frame  accountchan_svc.Frame
		method string
	}{
		{accountchan_svc.Frame{Type: accountchan_svc.FrameTypeSyncVersion, Version: 42}, "account.sync_version"},
		{accountchan_svc.Frame{Type: accountchan_svc.FrameTypeMirrorChanged}, "account.mirror_changed"},
		{accountchan_svc.Frame{Type: accountchan_svc.FrameTypeDevicePresence}, "account.device_presence"},
	}
	for _, tt := range tests {
		require.NoError(t, svc.Broadcast(context.Background(), 7, tt.frame))
		method, version := readChannelNotification(t, conn, "账号信号没有编码成 wire notification")
		require.Equal(t, tt.method, method)
		require.Equal(t, tt.frame.Version, version)
	}
}

// 通道只在 upgrade 那一刻过一次鉴权中间件，之后不再经过任何中间件。凭据在连接建好
// **之后**被撤销时服务端必须自己掐掉这条连接——与中继两条连接同一条判据，也是同一
// 种可辨认的关闭帧（1008），好让对端把它与网络中断区分开。
func TestAccountChannelClosesWhenCredentialRevoked(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	ctx := context.Background()
	signer := newChannelSigner(t)
	auth := auth_svc.New(session.New(redis.Default(), "server_session", 86400))
	auth_svc.SetDefault(auth)
	server := newChannelServer(t, signer, accountchan_svc.New(newChannelRedis(t, miniredis.RunT(t))))

	revokedToken, revokedJTI, err := signer.Sign(
		jwt.Claims{UID: 7, DID: 9, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)
	revokedDevice := dialChannelWithToken(t, server, revokedToken)
	keptDevice := dialChannelWithToken(t, server, deviceToken(t, signer, 7, 10))

	sid, _, err := auth.StartSession(ctx, 7)
	require.NoError(t, err)
	ticket, jti, err := signer.Sign(jwt.Claims{UID: 7, Kind: "relay_client"}, 2*time.Minute)
	require.NoError(t, err)
	require.NoError(t, auth.TrackRelayTicket(ctx, sid, jti, 2*time.Minute))
	browser := dialChannelWithTicket(t, server, ticket)

	// device_svc.Revoke 的既有动作：把该设备已签发的 access token jti 全部拉黑。
	require.NoError(t, jwtblacklist.Add(ctx, revokedJTI, int(15*time.Minute/time.Second)))
	// 浏览器登出的既有动作：删掉 session（并连带拉黑它签发的票）。
	require.NoError(t, auth.EndSession(ctx, sid))

	requireChannelClosed(t, revokedDevice, "设备撤销后它已经建好的通道连接必须被断开")
	requireChannelClosed(t, browser, "登出后这次会话建好的通道连接必须被断开")
	requireChannelAlive(t, keptDevice, "撤销一台设备不能踢掉同账号另一台设备的通道连接")
}

// 账号被封时活连接也要断开：闸门（user_svc.Gate）与中继心跳共用同一处判定。
// 封禁只能改库，所以生效路径只有一条——复查时闸门缓存到期、重新查库、判出封禁。
func TestAccountChannelClosesWhenAccountBanned(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	const gateTTL = time.Minute
	gate := installChannelAccountGate(t, gateTTL)
	signer := newChannelSigner(t)
	server := newChannelServer(t, signer, accountchan_svc.New(newChannelRedis(t, miniredis.RunT(t))))

	banned := dialChannelWithToken(t, server, deviceToken(t, signer, 7, 9))
	kept := dialChannelWithToken(t, server, deviceToken(t, signer, 8, 10))

	gate.ban()

	requireChannelClosed(t, banned, "账号被封后它已经建好的通道连接必须被断开")
	requireChannelAlive(t, kept, "封一个账号不能踢掉另一个账号的通道连接")
}

func newChannelSigner(t *testing.T) *jwt.Signer {
	t.Helper()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	return signer
}

func newChannelRedis(t *testing.T, mini *miniredis.Miniredis) *goredis.Client {
	t.Helper()
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	return client
}

func newChannelServer(
	t *testing.T, signer *jwt.Signer, svc accountchan_svc.AccountChanSvc,
) *httptest.Server {
	t.Helper()
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:         &bootstrap.ServerConfig{},
		Signer:      signer,
		AccountChan: svc,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server
}

func deviceToken(t *testing.T, signer *jwt.Signer, accountID, deviceID int64) string {
	t.Helper()
	token, _, err := signer.Sign(
		jwt.Claims{UID: accountID, DID: deviceID, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)
	return token
}

func browserTicket(t *testing.T, signer *jwt.Signer, auth auth_svc.AuthSvc, accountID int64) string {
	t.Helper()
	ctx := context.Background()
	sid, _, err := auth.StartSession(ctx, accountID)
	require.NoError(t, err)
	ticket, jti, err := signer.Sign(jwt.Claims{UID: accountID, Kind: "relay_client"}, 2*time.Minute)
	require.NoError(t, err)
	require.NoError(t, auth.TrackRelayTicket(ctx, sid, jti, 2*time.Minute))
	return ticket
}

func dialChannelWithToken(t *testing.T, server *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	return dialChannel(t, server, "/v1/account/channel",
		http.Header{"Authorization": {"Bearer " + token}})
}

func dialChannelWithTicket(t *testing.T, server *httptest.Server, ticket string) *websocket.Conn {
	t.Helper()
	return dialChannel(t, server, "/v1/account/channel?access_token="+ticket, nil)
}

func dialChannel(
	t *testing.T, server *httptest.Server, path string, header http.Header,
) *websocket.Conn {
	t.Helper()
	conn, response, err := channelDialer().Dial(
		"ws"+strings.TrimPrefix(server.URL, "http")+path, header)
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	require.Equal(t, relayws.ProtobufSubprotocol, conn.Subprotocol())
	return conn
}

func channelDialer() *websocket.Dialer {
	return &websocket.Dialer{Subprotocols: []string{relayws.ProtobufSubprotocol}}
}

func readChannelFrame(t *testing.T, conn *websocket.Conn, failure string) accountchan_svc.Frame {
	t.Helper()
	method, version := readChannelNotification(t, conn, failure)
	require.Equal(t, "account.sync_version", method)
	return accountchan_svc.Frame{Type: accountchan_svc.FrameTypeSyncVersion, Version: version}
}

func readChannelNotification(t *testing.T, conn *websocket.Conn, failure string) (string, int64) {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(2*time.Second)))
	messageType, payload, err := conn.ReadMessage()
	require.NoError(t, err, failure)
	require.Equal(t, websocket.BinaryMessage, messageType, "账号通道统一使用二进制 wire 帧")
	var envelope agentrewire.WireFrame
	require.NoError(t, proto.Unmarshal(payload, &envelope), failure)
	notification := envelope.GetNotification()
	require.NotNil(t, notification, failure)
	switch notification.Payload.(type) {
	case *agentrewire.Notification_AccountSyncVersion:
		return "account.sync_version", int64(notification.GetAccountSyncVersion().GetVersion())
	case *agentrewire.Notification_AccountMirrorChanged:
		return "account.mirror_changed", 0
	case *agentrewire.Notification_AccountDevicePresence:
		return "account.device_presence", 0
	default:
		t.Fatalf("%s: 未知账号通知 %T", failure, notification.Payload)
		return "", 0
	}
}

func requireChannelSilent(t *testing.T, conn *websocket.Conn, failure string) {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(300*time.Millisecond)))
	_, _, err := conn.ReadMessage()
	require.Error(t, err, failure)
	var networkErr net.Error
	require.ErrorAs(t, err, &networkErr, "%s: %v", failure, err)
	require.True(t, networkErr.Timeout(), "%s: %v", failure, err)
}

// requireChannelClosed 先发一个 ping 逼服务端立刻复查凭据（生产里这件事由 15s 心跳
// 承担，不依赖对端配合），再要求读到一个真正的关闭帧，而不是只能看见 EOF 的 1006。
func requireChannelClosed(t *testing.T, conn *websocket.Conn, failure string) {
	t.Helper()
	// 服务端可能已经先一步关掉了连接，写 ping 失败本身不是断言对象。
	_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second))
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(2*time.Second)))
	_, _, err := conn.ReadMessage()
	require.Error(t, err, failure)
	require.True(t, websocket.IsCloseError(err, websocket.ClosePolicyViolation), "%s: %v", failure, err)
}

func requireChannelAlive(t *testing.T, conn *websocket.Conn, failure string) {
	t.Helper()
	require.NoError(t, conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)))
	requireChannelSilent(t, conn, failure)
}

// channelAccountGate 是封禁开关：ban() 之后既翻转库里的状态，也把闸门已缓存的
// 「可用」结论快进到过期——否则封禁最多要等一个 TTL 才可观察，用例就得真的睡。
type channelAccountGate struct {
	banned *atomic.Bool
	expire func()
}

func (g *channelAccountGate) ban() {
	g.banned.Store(true)
	g.expire()
}

func installChannelAccountGate(t *testing.T, ttl time.Duration) *channelAccountGate {
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
	user_svc.SetGate(user_svc.NewGate(newChannelRedis(t, mini), ttl))
	t.Cleanup(func() {
		user_svc.SetGate(nil)
		user_repo.RegisterUser(nil)
	})
	return &channelAccountGate{banned: banned, expire: func() { mini.FastForward(ttl + time.Second) }}
}

// 通道建不起来时要在 upgrade **之前**以 HTTP 如实作答：客户端据此当场退回 30 秒
// 轮询，而不是拿到一条握手成功、却永远收不到信号的连接。
func TestAccountChannelAnswersHTTPWhenSubscriptionCannotBeOpened(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer := newChannelSigner(t)
	server := newChannelServer(t, signer, unavailableChannelSvc{})

	_, response, err := channelDialer().Dial(
		"ws"+strings.TrimPrefix(server.URL, "http")+"/v1/account/channel",
		http.Header{"Authorization": {"Bearer " + deviceToken(t, signer, 7, 9)}})
	require.Error(t, err)
	require.NotNil(t, response)
	t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	require.Equal(t, http.StatusServiceUnavailable, response.StatusCode)
	var body struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&body))
	require.Equal(t, code.AccountChannelUnavailable, body.Code)
	require.NotEmpty(t, body.Msg)
}

// 信号源没了（Redis 订阅彻底断掉）时不能留一条再也收不到信号的假活连接：断开它，
// 客户端重连时会主动 Pull 一次，断线期间的变更由那一次补齐。
func TestAccountChannelClosesWhenSignalsStop(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer := newChannelSigner(t)
	svc := &stallingChannelSvc{signals: make(chan accountchan_svc.Frame)}
	server := newChannelServer(t, signer, svc)

	conn := dialChannelWithToken(t, server, deviceToken(t, signer, 7, 9))
	close(svc.signals)

	require.NoError(t, conn.SetReadDeadline(time.Now().Add(2*time.Second)))
	_, _, err := conn.ReadMessage()
	require.Error(t, err, "订阅没了之后连接必须断开")
	var networkErr net.Error
	require.False(t, errors.As(err, &networkErr) && networkErr.Timeout(),
		"连接还活着：客户端会以为通道在，既收不到信号也不会退回轮询")
}

// unavailableChannelSvc 模拟订阅后端不可用（Redis 连不上）。
type unavailableChannelSvc struct{}

func (unavailableChannelSvc) Broadcast(context.Context, int64, accountchan_svc.Frame) error {
	return errors.New("account channel is unavailable")
}

func (unavailableChannelSvc) Subscribe(context.Context, int64) (accountchan_svc.Subscription, error) {
	return nil, errors.New("account channel is unavailable")
}

// stallingChannelSvc 给出一份订阅上去就不再有信号的通道，用来驱动「信号源没了」。
type stallingChannelSvc struct{ signals chan accountchan_svc.Frame }

func (s *stallingChannelSvc) Broadcast(context.Context, int64, accountchan_svc.Frame) error {
	return nil
}

func (s *stallingChannelSvc) Subscribe(
	context.Context, int64,
) (accountchan_svc.Subscription, error) {
	return stalledSubscription{signals: s.signals}, nil
}

type stalledSubscription struct{ signals chan accountchan_svc.Frame }

func (s stalledSubscription) Signals() <-chan accountchan_svc.Frame { return s.signals }

func (s stalledSubscription) Close() {}
