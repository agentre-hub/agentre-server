package mirror_svc

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/pkg/wireversion"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

type forwardedFrame struct {
	messageType int
	data        []byte
}

type recordingDialer struct {
	frames   chan forwardedFrame
	detached int
	mu       sync.Mutex
}

func newRecordingDialer() *recordingDialer {
	return &recordingDialer{frames: make(chan forwardedFrame, 16)}
}

func (d *recordingDialer) ConnectClient(
	context.Context, int64, string,
) (relay_svc.Route, error) {
	return relay_svc.Route{}, nil
}

func (d *recordingDialer) AttachClient(
	context.Context, relay_svc.Route, relay_svc.FrameWriter,
) (string, func(), error) {
	return "channel-1", func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		d.detached++
	}, nil
}

func (d *recordingDialer) ForwardClient(
	_ context.Context, _ relay_svc.Route, _ string, messageType int, frame []byte,
) error {
	d.frames <- forwardedFrame{messageType: messageType, data: append([]byte(nil), frame...)}
	return nil
}

func (d *recordingDialer) IsDaemonOnline(context.Context, int64, string) (bool, error) {
	return true, nil
}

func (d *recordingDialer) DaemonConnID(context.Context, int64, string) (string, error) {
	return "conn-1", nil
}

func (d *recordingDialer) detachCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.detached
}

func newMachineConnForTest(dialer RelayDialer, onNotify func(*agentrewire.RpcNotification)) *machineConn {
	return &machineConn{
		relay: dialer, channelID: "channel-1", timeout: time.Second, onNotify: onNotify,
		pending: map[uint64]chan rpcResult{},
	}
}

func decodeForwardedRequest(t *testing.T, forwarded forwardedFrame) *agentrewire.RpcFrame {
	t.Helper()
	assert.Equal(t, websocket.BinaryMessage, forwarded.messageType)
	assert.NotEqual(t, byte('{'), forwarded.data[0], "内部 RPC carrier 不应退回 JSON object")
	frame, err := relaywire.DecodeFrame(forwarded.data)
	require.NoError(t, err)
	require.NotNil(t, frame.GetRequest())
	return frame
}

func writeResponse(t *testing.T, conn *machineConn, request *agentrewire.RpcFrame, response proto.Message) {
	t.Helper()
	payload, err := proto.Marshal(response)
	require.NoError(t, err)
	encoded, err := relaywire.EncodeFrame(&agentrewire.RpcFrame{Id: request.GetId(), Body: &agentrewire.RpcFrame_Response{
		Response: &agentrewire.Response{
			MethodId: request.GetRequest().GetMethodId(), EncodedPayload: payload,
		},
	}})
	require.NoError(t, err)
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, encoded))
}

func TestMachineConn_ConcurrentCallsCorrelateOutOfOrderBinaryResponses(t *testing.T) {
	dialer := newRecordingDialer()
	conn := newMachineConnForTest(dialer, nil)

	listResult := make(chan *agentrewire.SessionListResponse, 1)
	listErr := make(chan error, 1)
	go func() {
		response, err := conn.SessionList(context.Background(), &agentrewire.SessionListRequest{})
		listResult <- response
		listErr <- err
	}()
	pullResult := make(chan *agentrewire.SessionPullResponse, 1)
	pullErr := make(chan error, 1)
	go func() {
		response, err := conn.SessionPull(context.Background(), &agentrewire.SessionPullRequest{
			ConversationId: conv42, Cursor: 7,
		})
		pullResult <- response
		pullErr <- err
	}()

	requests := map[agentrewire.RpcMethod]*agentrewire.RpcFrame{}
	for range 2 {
		frame := decodeForwardedRequest(t, <-dialer.frames)
		requests[agentrewire.RpcMethod(frame.GetRequest().GetMethodId())] = frame
	}
	require.Len(t, requests, 2)
	pullRequest := &agentrewire.SessionPullRequest{}
	require.NoError(t, proto.Unmarshal(
		requests[agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL].GetRequest().GetEncodedPayload(), pullRequest,
	))
	assert.Equal(t, conv42, pullRequest.GetConversationId())
	assert.Equal(t, int64(7), pullRequest.GetCursor())

	writeResponse(t, conn, requests[agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL],
		&agentrewire.SessionPullResponse{Cursor: 9})
	writeResponse(t, conn, requests[agentrewire.RpcMethod_RPC_METHOD_SESSION_LIST],
		&agentrewire.SessionListResponse{Sessions: []*agentrewire.SessionSummary{{ConversationId: conv101}}})

	require.NoError(t, <-pullErr)
	assert.Equal(t, int64(9), (<-pullResult).GetCursor())
	require.NoError(t, <-listErr)
	// 认出的是**这一条应答自己的载荷**：两个应答乱序回来时，list 那一路必须拿到
	// list 的会话号，而不是 pull 的游标。
	list := <-listResult
	require.Len(t, list.GetSessions(), 1)
	assert.Equal(t, conv101, list.GetSessions()[0].GetConversationId())
}

func TestMachineConn_ContextCancellationSendsTypedCancel(t *testing.T) {
	dialer := newRecordingDialer()
	conn := newMachineConnForTest(dialer, nil)
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := conn.SessionList(ctx, &agentrewire.SessionListRequest{})
		errCh <- err
	}()

	request := decodeForwardedRequest(t, <-dialer.frames)
	cancel()
	require.ErrorIs(t, <-errCh, context.Canceled)
	cancelFrame, err := relaywire.DecodeFrame((<-dialer.frames).data)
	require.NoError(t, err)
	require.NotNil(t, cancelFrame.GetCancel())
	assert.Equal(t, request.GetId(), cancelFrame.GetCancel().GetRequestId())
}

func TestMachineConn_CloseWakesPendingAndRejectsNewCalls(t *testing.T) {
	dialer := newRecordingDialer()
	conn := newMachineConnForTest(dialer, nil)
	conn.detach = func() {
		dialer.mu.Lock()
		defer dialer.mu.Unlock()
		dialer.detached++
	}
	errCh := make(chan error, 1)
	go func() {
		_, err := conn.SessionList(context.Background(), &agentrewire.SessionListRequest{})
		errCh <- err
	}()

	_ = decodeForwardedRequest(t, <-dialer.frames)
	conn.Close()
	conn.Close()
	require.ErrorIs(t, <-errCh, ErrConnClosed)
	_, err := conn.SessionList(context.Background(), &agentrewire.SessionListRequest{})
	require.ErrorIs(t, err, ErrConnClosed)
	assert.Equal(t, 1, dialer.detachCount())
}

func TestMachineConn_TypedErrorsAndNotificationsRemainLossless(t *testing.T) {
	notifications := make(chan *agentrewire.RpcNotification, 1)
	dialer := newRecordingDialer()
	conn := newMachineConnForTest(dialer, func(note *agentrewire.RpcNotification) {
		notifications <- note
	})
	errCh := make(chan error, 1)
	go func() {
		_, err := conn.SessionDelete(context.Background(), &agentrewire.SessionDeleteRequest{ConversationId: conv42})
		errCh <- err
	}()
	request := decodeForwardedRequest(t, <-dialer.frames)
	details := []byte{0x0a, 0x01, 0xff}
	encodedError, err := relaywire.EncodeFrame(&agentrewire.RpcFrame{Id: request.GetId(), Body: &agentrewire.RpcFrame_Error{
		Error: &agentrewire.RpcError{Code: 409, Message: "already gone", Details: details},
	}})
	require.NoError(t, err)
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, encodedError))

	var rpcErr *relaywire.Error
	require.ErrorAs(t, <-errCh, &rpcErr)
	assert.Equal(t, int32(409), rpcErr.Code)
	assert.Equal(t, "already gone", rpcErr.Message)
	assert.Equal(t, details, rpcErr.Details)

	note := notification(conv42, 8, "typed")
	encodedNote, err := relaywire.EncodeFrame(&agentrewire.RpcFrame{Body: &agentrewire.RpcFrame_Notification{
		Notification: note,
	}})
	require.NoError(t, err)
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, encodedNote))
	assert.True(t, proto.Equal(note, <-notifications))
}

func TestMachineConn_MalformedFrameDoesNotPoisonTheNextResponse(t *testing.T) {
	dialer := newRecordingDialer()
	conn := newMachineConnForTest(dialer, nil)
	result := make(chan *agentrewire.SessionListResponse, 1)
	errCh := make(chan error, 1)
	go func() {
		response, err := conn.SessionList(context.Background(), &agentrewire.SessionListRequest{})
		result <- response
		errCh <- err
	}()
	request := decodeForwardedRequest(t, <-dialer.frames)

	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, []byte{0xff, 0xff}))
	writeResponse(t, conn, request,
		&agentrewire.SessionListResponse{Sessions: []*agentrewire.SessionSummary{{ConversationId: conv202}}})

	require.NoError(t, <-errCh)
	// 坏帧之后那一条应答要**原样**送到，载荷一格不少。
	response := <-result
	require.Len(t, response.GetSessions(), 1)
	assert.Equal(t, conv202, response.GetSessions()[0].GetConversationId())
}

func TestMachineConn_ResponseMethodMustMatchRequest(t *testing.T) {
	dialer := newRecordingDialer()
	conn := newMachineConnForTest(dialer, nil)
	errCh := make(chan error, 1)
	go func() {
		_, err := conn.SessionList(context.Background(), &agentrewire.SessionListRequest{})
		errCh <- err
	}()
	request := decodeForwardedRequest(t, <-dialer.frames)
	payload, err := proto.Marshal(&agentrewire.SessionListResponse{})
	require.NoError(t, err)
	encoded, err := relaywire.EncodeFrame(&agentrewire.RpcFrame{Id: request.GetId(), Body: &agentrewire.RpcFrame_Response{
		Response: &agentrewire.Response{
			MethodId: uint32(agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL), EncodedPayload: payload,
		},
	}})
	require.NoError(t, err)
	require.NoError(t, conn.WriteMessage(websocket.BinaryMessage, encoded))

	require.ErrorIs(t, <-errCh, relaywire.ErrResponseType)
}

var _ RelayDialer = (*recordingDialer)(nil)

// TestMachineConn_TranscriptImportCallsCarryTheirOwnMethodID 守的是这一族四个
// 包装最容易出的那个错：照着上一个方法复制下来、方法 ID 忘了改。四个都用
// 「发出去的那一帧带的是哪个 method」和「应答按哪个类型解」两件事一起断言——
// 只断言不报错的话，一个把 turns 发成 open 的包装照样绿。
func TestMachineConn_TranscriptImportCallsCarryTheirOwnMethodID(t *testing.T) {
	dialer := newRecordingDialer()
	conn := newMachineConnForTest(dialer, nil)

	scanCh := make(chan *agentrewire.TranscriptImportScanResponse, 1)
	go func() {
		response, err := conn.TranscriptImportScan(context.Background(),
			&agentrewire.TranscriptImportScanRequest{Backends: []string{"claudecode"}})
		assert.NoError(t, err)
		scanCh <- response
	}()
	scanRequest := decodeForwardedRequest(t, <-dialer.frames)
	require.Equal(t, uint32(agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_SCAN),
		scanRequest.GetRequest().GetMethodId())
	scanParams := &agentrewire.TranscriptImportScanRequest{}
	require.NoError(t, proto.Unmarshal(scanRequest.GetRequest().GetEncodedPayload(), scanParams))
	assert.Equal(t, []string{"claudecode"}, scanParams.GetBackends())
	writeResponse(t, conn, scanRequest, &agentrewire.TranscriptImportScanResponse{
		Backends: []*agentrewire.TranscriptImportBackendResult{{Backend: "claudecode", Status: "ok"}},
	})
	require.Equal(t, "claudecode", (<-scanCh).GetBackends()[0].GetBackend())

	openCh := make(chan *agentrewire.TranscriptImportOpenResponse, 1)
	go func() {
		response, err := conn.TranscriptImportOpen(context.Background(),
			&agentrewire.TranscriptImportOpenRequest{Backend: "codex", Locator: "loc-1"})
		assert.NoError(t, err)
		openCh <- response
	}()
	openRequest := decodeForwardedRequest(t, <-dialer.frames)
	require.Equal(t, uint32(agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_OPEN),
		openRequest.GetRequest().GetMethodId())
	writeResponse(t, conn, openRequest, &agentrewire.TranscriptImportOpenResponse{
		Meta: &agentrewire.TranscriptImportMeta{ProviderSessionId: "prov-1"},
	})
	require.Equal(t, "prov-1", (<-openCh).GetMeta().GetProviderSessionId())

	turnsCh := make(chan *agentrewire.TranscriptImportTurnsResponse, 1)
	go func() {
		response, err := conn.TranscriptImportTurns(context.Background(),
			&agentrewire.TranscriptImportTurnsRequest{Backend: "codex", Locator: "loc-1", MaxTurns: 3})
		assert.NoError(t, err)
		turnsCh <- response
	}()
	turnsRequest := decodeForwardedRequest(t, <-dialer.frames)
	require.Equal(t, uint32(agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_TURNS),
		turnsRequest.GetRequest().GetMethodId())
	writeResponse(t, conn, turnsRequest, &agentrewire.TranscriptImportTurnsResponse{NextIndex: 3, HasMore: true})
	turnsResponse := <-turnsCh
	assert.Equal(t, int32(3), turnsResponse.GetNextIndex())
	assert.True(t, turnsResponse.GetHasMore())

	executeCh := make(chan *agentrewire.TranscriptImportExecuteResponse, 1)
	go func() {
		response, err := conn.TranscriptImportExecute(context.Background(),
			&agentrewire.TranscriptImportExecuteRequest{ConversationId: conv42, PeerFingerprint: "fp-1"})
		assert.NoError(t, err)
		executeCh <- response
	}()
	executeRequest := decodeForwardedRequest(t, <-dialer.frames)
	require.Equal(t, uint32(agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_EXECUTE),
		executeRequest.GetRequest().GetMethodId())
	executeParams := &agentrewire.TranscriptImportExecuteRequest{}
	require.NoError(t, proto.Unmarshal(executeRequest.GetRequest().GetEncodedPayload(), executeParams))
	assert.Equal(t, "fp-1", executeParams.GetPeerFingerprint(),
		"发起端指纹必须原样过线：它决定导出来的会话归谁")
	writeResponse(t, conn, executeRequest, &agentrewire.TranscriptImportExecuteResponse{
		ConversationId: conv42, Turns: 8,
	})
	assert.Equal(t, int32(8), (<-executeCh).GetTurns())
}

// TestMachineConn_ActivityRollup_CarriesTheWindowAndZone 覆盖活跃统计的拉取调用。
//
// 两个入参都不能丢:since_day 丢了就每次都全量回填,一台跑了一年的机器每轮上报几千个
// 桶;time_zone 丢了对端会按 UTC 切日界,而一个账号下的机器可能分散在不同时区 —— 日界
// 只能有一套,否则同一天的活动被劈到两格上。
func TestMachineConn_ActivityRollup_CarriesTheWindowAndZone(t *testing.T) {
	dialer := newRecordingDialer()
	conn := newMachineConnForTest(dialer, nil)

	result := make(chan *agentrewire.ActivityRollupResponse, 1)
	callErr := make(chan error, 1)
	go func() {
		response, err := conn.ActivityRollup(context.Background(), &agentrewire.ActivityRollupRequest{
			SinceDay: "2026-08-20", TimeZone: "Asia/Shanghai",
		})
		result <- response
		callErr <- err
	}()

	frame := decodeForwardedRequest(t, <-dialer.frames)
	require.Equal(t, uint32(agentrewire.RpcMethod_RPC_METHOD_ACTIVITY_ROLLUP), frame.GetRequest().GetMethodId())
	sent := &agentrewire.ActivityRollupRequest{}
	require.NoError(t, proto.Unmarshal(frame.GetRequest().GetEncodedPayload(), sent))
	assert.Equal(t, "2026-08-20", sent.GetSinceDay())
	assert.Equal(t, "Asia/Shanghai", sent.GetTimeZone())

	writeResponse(t, conn, frame, &agentrewire.ActivityRollupResponse{
		Buckets: []*agentrewire.ActivityDailyBucket{{Day: "2026-08-28", AgentSyncId: "a1", SessionCount: 3}},
	})

	require.NoError(t, <-callErr)
	buckets := (<-result).GetBuckets()
	require.Len(t, buckets, 1)
	assert.Equal(t, "2026-08-28", buckets[0].GetDay())
	assert.Equal(t, int32(3), buckets[0].GetSessionCount())
}

// Given 对端在 auth.account 上按精确匹配校验协议版本，proto3 下缺字段与显式空串同为
// 零值——一个空的 min_supported_protocol_version 从今往后会被对端判成「这一跳不具备
// 窗口能力」，只能继续保守推断（spec「协议：版本窗口与自报版本」一节，决策 3）；
// When 本副本握手；Then 请求里带出的 min_supported_protocol_version 必须是
// wireversion.MinSupported，而不是零值。
func TestDialMachine_HandshakeAdvertisesTheMinSupportedProtocolVersion(t *testing.T) {
	dialer := newRecordingDialer()

	done := make(chan struct{})
	go func() {
		defer close(done)
		// 没有人应答这次握手,c.call 会在 timeout 后带着 ctx.Err() 收尾——测试只关心
		// 发出去的请求长什么样,不需要等它真正建立连接。
		_, _, _ = dialMachine(context.Background(), dialer, "cred-1",
			machineKey{userID: 1, fingerprint: "fp-1"}, 50*time.Millisecond, nil)
	}()

	frame := decodeForwardedRequest(t, <-dialer.frames)
	require.Equal(t, uint32(agentrewire.RpcMethod_RPC_METHOD_AUTH_ACCOUNT), frame.GetRequest().GetMethodId())
	request := &agentrewire.AuthAccountRequest{}
	require.NoError(t, proto.Unmarshal(frame.GetRequest().GetEncodedPayload(), request))

	assert.Equal(t, wireversion.Protocol, request.GetProtocolVersion())
	assert.Equal(t, wireversion.MinSupported, request.GetMinSupportedProtocolVersion())
	assert.NotEmpty(t, request.GetMinSupportedProtocolVersion(),
		"空版本会被对端判成「这一跳不具备窗口能力」")

	<-done
}
