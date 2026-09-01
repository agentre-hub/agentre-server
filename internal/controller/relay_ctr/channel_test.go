package relay_ctr_test

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo/mock_agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// channelHarness 是「一条中继连接、多条通道、多台机器」这组用例的公共装配：真的
// relay_svc + 真的 Redis 帧总线，daemon 与客户端都是真的 websocket。桩件只在
// 仓库那一层。
type channelHarness struct {
	server      *httptest.Server
	signer      *jwt.Signer
	devices     *mock_device_repo.MockDeviceRepo
	saves       *mock_agent_session_repo.MockSaveRepo
	accountChan accountchan_svc.AccountChanSvc
}

func newChannelHarness(t *testing.T) *channelHarness {
	t.Helper()
	testutils.Redis()
	return newSignalHarnessWith(t, accountchan_svc.New(newRelayRedisClient(t, miniredis.RunT(t))))
}

// newSignalHarnessWith 换掉账号信号那一路的实现：保留通道的用例按它驱动订阅失败、
// 订阅缓慢与信号源中断三种形态。
func newSignalHarnessWith(t *testing.T, accountChan accountchan_svc.AccountChanSvc) *channelHarness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	mini := miniredis.RunT(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	controller := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(controller)
	saves := mock_agent_session_repo.NewMockSaveRepo(controller)
	config := relay_svc.Config{InstanceID: "server-a", OnlineTTL: time.Minute}
	redisClient := newRelayRedisClient(t, mini)
	svc := relay_svc.New(config, devices, saves, redisClient, relay_svc.NewRedisForwarder(config, redisClient))
	return &channelHarness{
		server:      newRelayServerWithAccountChan(t, signer, svc, accountChan),
		signer:      signer,
		devices:     devices,
		saves:       saves,
		accountChan: accountChan,
	}
}

// machine 让一台机器可寻址：设备查得到，且它自己连着一条 daemon 中继。
func (h *channelHarness) machine(t *testing.T, id int64, fingerprint, kind string) *websocket.Conn {
	t.Helper()
	device := &device_entity.Device{ID: id, UserID: 7, Kind: kind, Fingerprint: fingerprint, Status: 1}
	h.devices.EXPECT().Find(gomock.Any(), id).Return(device, nil).AnyTimes()
	h.devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), fingerprint).Return(device, nil).AnyTimes()
	token, _, err := h.signer.Sign(jwt.Claims{UID: 7, DID: id, Kind: kind}, time.Hour)
	require.NoError(t, err)
	conn, _, err := protobufRelayDialer.Dial(wsURL(h.server.URL, "/v1/relay/daemon"),
		http.Header{"Authorization": {"Bearer " + token}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// offlineMachine 是一台登记过、但此刻没有中继连接的机器。
func (h *channelHarness) offlineMachine(t *testing.T, id int64, fingerprint string) {
	t.Helper()
	device := &device_entity.Device{
		ID: id, UserID: 7, Kind: device_entity.KindAgentred, Fingerprint: fingerprint, Status: 1,
	}
	h.devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), fingerprint).Return(device, nil).AnyTimes()
}

// client 开一条**账号级**中继连接：URL 上没有目标，目标由每条通道各自声明。
func (h *channelHarness) client(t *testing.T) *clientLink {
	t.Helper()
	token, _, err := h.signer.Sign(jwt.Claims{UID: 7, DID: 4, Kind: device_entity.KindDesktop}, time.Hour)
	require.NoError(t, err)
	conn, response, err := protobufRelayDialer.Dial(wsURL(h.server.URL, "/v1/relay/client"),
		http.Header{"Authorization": {"Bearer " + token}})
	if response != nil {
		t.Cleanup(func() { require.NoError(t, response.Body.Close()) })
	}
	require.NoError(t, err, "账号级中继连接必须建得起来：URL 上不再有目标，鉴权之外没有别的准入判据")
	t.Cleanup(func() { _ = conn.Close() })
	return newClientLink(conn)
}

// clientLink 按通道拆开服务端发回来的帧。一条连接上现在跑着多条通道，读的顺序
// 不再等于写的顺序，逐条 ReadMessage 会互相偷帧。
type clientLink struct {
	conn *websocket.Conn

	mu     sync.Mutex
	frames map[string]chan []byte
}

func newClientLink(conn *websocket.Conn) *clientLink {
	link := &clientLink{conn: conn, frames: map[string]chan []byte{}}
	go link.read()
	return link
}

func (l *clientLink) read() {
	for {
		messageType, payload, err := l.conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		channelID, frame, decodeErr := relay_svc.UnwrapEnvelope(payload)
		if decodeErr != nil {
			continue
		}
		l.channel(channelID) <- append([]byte(nil), frame...)
	}
}

func (l *clientLink) channel(channelID string) chan []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.frames[channelID] == nil {
		l.frames[channelID] = make(chan []byte, 16)
	}
	return l.frames[channelID]
}

// open 声明一条通道的目标。目标是这条通道的第一帧（决策 10）。
func (l *clientLink) open(t *testing.T, channelID, target string) {
	t.Helper()
	l.send(t, channelID, []byte(target))
}

func (l *clientLink) send(t *testing.T, channelID string, frame []byte) {
	t.Helper()
	envelope, err := relay_svc.WrapEnvelope(channelID, frame)
	require.NoError(t, err)
	require.NoError(t, l.conn.WriteMessage(websocket.BinaryMessage, envelope))
}

func (l *clientLink) next(t *testing.T, channelID, failure string) []byte {
	t.Helper()
	return receiveWithin(t, l.channel(channelID), 2*time.Second, failure)
}

func (l *clientLink) requireQuiet(t *testing.T, channelID, failure string) {
	t.Helper()
	select {
	case frame := <-l.channel(channelID):
		t.Fatalf("%s: 收到 %x", failure, frame)
	case <-time.After(200 * time.Millisecond):
	}
}

// requireChannelError 断言这条通道拿到的是一个通道级 RPC 错误，并交回错误码。
func requireChannelError(t *testing.T, frame []byte) int32 {
	t.Helper()
	decoded, err := relaywire.DecodeFrame(frame)
	require.NoError(t, err, "通道级失败必须是客户端 RPC 层认得的一帧")
	require.NotNil(t, decoded.GetError(), "通道级失败必须走 RpcFrame.error")
	require.NotEmpty(t, decoded.GetError().GetMessage(), "错误码必须带文案")
	return decoded.GetError().GetCode()
}

// readDaemonEnvelope 读一帧 daemon 侧的信封。
func readDaemonEnvelope(t *testing.T, conn *websocket.Conn, failure string) (string, []byte) {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(2*time.Second)))
	messageType, payload, err := conn.ReadMessage()
	require.NoError(t, err, failure)
	require.Equal(t, websocket.BinaryMessage, messageType)
	return decodeRelayEnvelope(t, payload)
}

// 目标下沉到通道：同一条中继连接上的两条通道落在两台不同的机器上，一条按对话
// 寻址（服务端查名单解析出承载机器），另一条按机器寻址。
func TestRelayClient_GivenTwoChannelsOnOneConnection_ThenEachLandsOnItsOwnMachine(t *testing.T) {
	harness := newChannelHarness(t)
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)
	beta := harness.machine(t, 10, "fp-beta", device_entity.KindDesktop)
	const conversationID = "11111111-1111-7111-8111-111111111111"
	harness.saves.EXPECT().FindByIdentity(gomock.Any(), int64(7), conversationID).
		Return(&agent_session_entity.SessionSave{
			UserID: 7, ConversationID: conversationID, DeviceFingerprint: "fp-beta",
		}, nil)

	link := harness.client(t)
	link.open(t, "c-alpha", "machine:fp-alpha")
	link.open(t, "c-beta", "conversation:"+conversationID)

	requestAlpha := []byte{0x08, 0x01, 0x12, 0x02, 0xff, 0x00}
	requestBeta := []byte{0x08, 0x02, 0x12, 0x02, 0x00, 0xff}
	link.send(t, "c-alpha", requestAlpha)
	link.send(t, "c-beta", requestBeta)

	alphaChannel, alphaFrame := readDaemonEnvelope(t, alpha, "第一条通道的请求没有到达它的机器")
	require.Equal(t, requestAlpha, alphaFrame)
	betaChannel, betaFrame := readDaemonEnvelope(t, beta, "第二条通道的请求没有到达承载那条对话的机器")
	require.Equal(t, requestBeta, betaFrame, "按对话寻址的通道必须落在名单指出的那台机器上")

	// 回程各回各家：客户端按自己开通道时用的号收帧。
	responseAlpha := []byte{0x08, 0x01, 0x1a, 0x02, 0xde, 0xad}
	responseBeta := []byte{0x08, 0x02, 0x1a, 0x02, 0xbe, 0xef}
	require.NoError(t, alpha.WriteMessage(websocket.BinaryMessage, relayEnvelope(alphaChannel, responseAlpha)))
	require.NoError(t, beta.WriteMessage(websocket.BinaryMessage, relayEnvelope(betaChannel, responseBeta)))
	require.Equal(t, responseAlpha, link.next(t, "c-alpha", "第一台机器的应答没有回到它那条通道"))
	require.Equal(t, responseBeta, link.next(t, "c-beta", "第二台机器的应答没有回到它那条通道"))
}

// 失败按通道隔离：一条通道的目标离线只让那条通道拿到通道级错误码，同一连接上
// 其它通道照常收发，整条连接不关。
func TestRelayClient_GivenOneChannelTargetIsOffline_ThenOnlyThatChannelFails(t *testing.T) {
	harness := newChannelHarness(t)
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)
	harness.offlineMachine(t, 11, "fp-sleeping")

	link := harness.client(t)
	link.open(t, "c-alpha", "machine:fp-alpha")
	link.open(t, "c-dead", "machine:fp-sleeping")

	require.Equal(t, relay_svc.ChannelCodeTargetOffline,
		requireChannelError(t, link.next(t, "c-dead", "离线的目标没有给出通道级错误")))
	require.Empty(t, link.next(t, "c-dead", "失败的通道必须随即关闭"),
		"空载荷是「这条通道关了」的信号")

	// 兄弟通道毫发无损：还能发，也还能收。
	request := []byte{0x08, 0x01, 0x12, 0x01, 0x7f}
	link.send(t, "c-alpha", request)
	channelID, frame := readDaemonEnvelope(t, alpha, "同连接另一条通道的请求被那条失败的通道连坐了")
	require.Equal(t, request, frame)
	response := []byte{0x08, 0x01, 0x1a, 0x01, 0x2a}
	require.NoError(t, alpha.WriteMessage(websocket.BinaryMessage, relayEnvelope(channelID, response)))
	require.Equal(t, response, link.next(t, "c-alpha", "同连接另一条通道收不到应答了"))
}

// isAddressableKind 逐通道重查：两种目标形式解析出来的机器都要过它。
//
// 这里的设备存在、活跃、指纹也对得上，唯一不合格的是 kind，因此拒绝只可能出自
// 那一次重查；而重查发生在 upgrade **之后**，所以它是通道级的，连接还活着。
func TestRelayClient_GivenTheResolvedMachineIsNotAddressable_ThenTheChannelIsRefused(t *testing.T) {
	harness := newChannelHarness(t)
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)
	browser := &device_entity.Device{
		ID: 12, UserID: 7, Kind: device_entity.KindWeb, Fingerprint: "fp-browser", Status: 1,
	}
	harness.devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-browser").
		Return(browser, nil).AnyTimes()
	const conversationID = "22222222-2222-7222-8222-222222222222"
	harness.saves.EXPECT().FindByIdentity(gomock.Any(), int64(7), conversationID).
		Return(&agent_session_entity.SessionSave{
			UserID: 7, ConversationID: conversationID, DeviceFingerprint: "fp-browser",
		}, nil)

	link := harness.client(t)
	link.open(t, "c-machine", "machine:fp-browser")
	link.open(t, "c-conversation", "conversation:"+conversationID)

	require.Equal(t, relay_svc.ChannelCodeTargetNotFound,
		requireChannelError(t, link.next(t, "c-machine", "machine: 指定的浏览器没有被这道闸拦下")))
	require.Equal(t, relay_svc.ChannelCodeTargetNotFound,
		requireChannelError(t, link.next(t, "c-conversation",
			"conversation: 解析出来的浏览器没有被这道闸拦下")))

	// 连接照旧：被拒的是两条通道，不是这条连接。
	link.open(t, "c-alpha", "machine:fp-alpha")
	request := []byte{0x08, 0x03, 0x12, 0x01, 0x01}
	link.send(t, "c-alpha", request)
	_, frame := readDaemonEnvelope(t, alpha, "两条通道被拒之后这条连接不该再能开新通道")
	require.Equal(t, request, frame)
}

// 目标写不成形是这一条通道的事，同样不牵连整条连接。
func TestRelayClient_GivenAMalformedTarget_ThenOnlyThatChannelIsRefused(t *testing.T) {
	harness := newChannelHarness(t)
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)

	link := harness.client(t)
	link.open(t, "c-bad", "fp-alpha")

	require.Equal(t, relay_svc.ChannelCodeTargetInvalid,
		requireChannelError(t, link.next(t, "c-bad", "不成形的目标没有给出通道级错误")))

	link.open(t, "c-alpha", "machine:fp-alpha")
	link.send(t, "c-alpha", []byte{0x08, 0x04})
	_, frame := readDaemonEnvelope(t, alpha, "一条通道声明错目标不该让同连接其它通道开不起来")
	require.Equal(t, []byte{0x08, 0x04}, frame)
}

// 保留通道号由服务端专用（决策 13/14）：客户端自己开一个只能被拒，而且**不能**
// 走 AttachClient —— 那条路径在通道结束时会往通道上发一帧空载荷通知 daemon，
// 而保留通道压根没有对端 daemon。
func TestRelayClient_GivenAReservedChannelID_ThenTheClientCannotOpenIt(t *testing.T) {
	harness := newChannelHarness(t)
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)

	link := harness.client(t)
	link.open(t, relay_svc.ReservedChannelPrefix+"signal", "machine:fp-alpha")

	require.Equal(t, relay_svc.ChannelCodeReserved, requireChannelError(t,
		link.next(t, relay_svc.ReservedChannelPrefix+"signal", "客户端开保留号必须被拒")))

	// 那台机器上不该出现任何通道：被拒的通道从未附着过。
	link.open(t, "c-alpha", "machine:fp-alpha")
	link.send(t, "c-alpha", []byte{0x08, 0x05})
	_, frame := readDaemonEnvelope(t, alpha, "保留号被拒之后这条连接不该受影响")
	require.Equal(t, []byte{0x08, 0x05}, frame)
}

// 通道关闭是逐通道的：客户端关掉一条通道，daemon 收到那条通道的关闭帧，
// 同连接其它通道不受影响。
func TestRelayClient_GivenOneChannelIsClosed_ThenOnlyItsDaemonChannelCloses(t *testing.T) {
	harness := newChannelHarness(t)
	alpha := harness.machine(t, 9, "fp-alpha", device_entity.KindAgentred)

	link := harness.client(t)
	link.open(t, "c-one", "machine:fp-alpha")
	link.open(t, "c-two", "machine:fp-alpha")
	link.send(t, "c-one", []byte{0x08, 0x01})
	one, _ := readDaemonEnvelope(t, alpha, "第一条通道没有到达机器")
	link.send(t, "c-two", []byte{0x08, 0x02})
	two, _ := readDaemonEnvelope(t, alpha, "第二条通道没有到达机器")
	require.NotEqual(t, one, two, "同一台机器上的两条通道必须是两个通道号")

	link.send(t, "c-one", nil)
	closedChannel, closedFrame := readDaemonEnvelope(t, alpha, "关掉的通道没有通知到机器")
	require.Equal(t, one, closedChannel)
	require.Empty(t, closedFrame)

	link.send(t, "c-two", []byte{0x08, 0x03})
	stillOpen, frame := readDaemonEnvelope(t, alpha, "关掉一条通道连坐了同连接的另一条")
	require.Equal(t, two, stillOpen)
	require.Equal(t, []byte{0x08, 0x03}, frame)
}
