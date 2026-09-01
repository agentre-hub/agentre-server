package mirror_svc

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/pkg/wireversion"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

var ErrConnClosed = errors.New("mirror relay connection is closed")

const (
	relayClientKind = "relay_client"
	credentialTTL   = 2 * time.Minute
)

type CredentialSigner interface {
	Sign(c jwt.Claims, ttl time.Duration) (string, string, error)
}

// RelayDialer 只负责定位通道并透传 opaque binary payload，不理解 RpcFrame。
type RelayDialer interface {
	ConnectClient(ctx context.Context, accountID int64, fingerprint string) (relay_svc.Route, error)
	AttachClient(ctx context.Context, target relay_svc.Route, writer relay_svc.FrameWriter) (string, func(), error)
	ForwardClient(ctx context.Context, target relay_svc.Route, channelID string, messageType int, frame []byte) error
	IsDaemonOnline(ctx context.Context, accountID int64, fingerprint string) (bool, error)
}

type rpcResult struct {
	response *agentrewire.Response
	rpcErr   *agentrewire.RpcError
}

// machineConn 是 server mirror 的 typed Protobuf RPC client。公开给业务层的只有
// 具体方法；method ID 与 encoded payload 的通用调用留在这个传输实现内部。
type machineConn struct {
	ctx       context.Context
	relay     RelayDialer
	route     relay_svc.Route
	channelID string
	detach    func()
	timeout   time.Duration
	onNotify  func(*agentrewire.RpcNotification)

	mu      sync.Mutex
	nextID  uint64
	pending map[uint64]chan rpcResult
	closed  bool
}

// dialMachine 不再收「本副本的对端指纹」:决策 8 之后身份不在请求体里,它由对端从
// 已验签凭据的 pfp claim 取,所以本副本出示什么身份完全取决于 Supervisor.dial 往
// 凭据里签了什么(见下面 AuthAccount 处的注释)。
func dialMachine(
	ctx context.Context, relay RelayDialer, credential string,
	m machineKey, timeout time.Duration, onNotify func(*agentrewire.RpcNotification),
) (*machineConn, error) {
	route, err := relay.ConnectClient(ctx, m.userID, m.fingerprint)
	if err != nil {
		return nil, fmt.Errorf("connect relay client: %w", err)
	}
	c := &machineConn{
		ctx: ctx, relay: relay, route: route, timeout: timeout, onNotify: onNotify,
		pending: map[uint64]chan rpcResult{},
	}
	channelID, detach, err := relay.AttachClient(ctx, route, c)
	if err != nil {
		return nil, fmt.Errorf("attach relay client: %w", err)
	}
	c.channelID, c.detach = channelID, detach
	// ProtocolVersion 是握手的必填项:对端按**精确匹配**校验,并且把空版本判成
	// 「对端太旧」(proto3 下缺字段与显式空串同为零值)。不带它 = 每一台机器都在
	// auth.account 上被拒 = 一条会话都镜像不下来。
	// 对端身份**不在请求体里**：它由对端从已验签凭据的 pfp claim 取
	// （2026-08-31-conversation-centric-addressing.md 决策 8，AuthAccountRequest 的
	// device_fingerprint 字段已删）。本副本出示什么身份，因此完全取决于
	// Supervisor.dial 往凭据里签了什么。
	if _, err := c.AuthAccount(ctx, &agentrewire.AuthAccountRequest{
		Credential: credential, ProtocolVersion: wireversion.Protocol,
	}); err != nil {
		c.Close()
		return nil, fmt.Errorf("relay account handshake: %w", err)
	}
	return c, nil
}

func (c *machineConn) AuthAccount(ctx context.Context, request *agentrewire.AuthAccountRequest) (*agentrewire.AuthAccountResponse, error) {
	response := &agentrewire.AuthAccountResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_AUTH_ACCOUNT, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (c *machineConn) SessionList(ctx context.Context, request *agentrewire.SessionListRequest) (*agentrewire.SessionListResponse, error) {
	response := &agentrewire.SessionListResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_SESSION_LIST, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

// ActivityRollup 拉这台机器上按 (天 × 维度组合) 的会话计数。
//
// 它与镜像那几个方法住在同一条连接上,但答的是完全不同的东西:回包里只有天、几个不透
// 明标识和一个计数,没有标题、路径与对话内容。消费它的服务因此单独声明一个只含这一个
// 方法的窄接口 —— 别把它并进 RelaySession,那会让镜像也够得着滚存。
func (c *machineConn) ActivityRollup(ctx context.Context, request *agentrewire.ActivityRollupRequest) (*agentrewire.ActivityRollupResponse, error) {
	response := &agentrewire.ActivityRollupResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_ACTIVITY_ROLLUP, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (c *machineConn) SessionAttach(ctx context.Context, request *agentrewire.SessionAttachRequest) (*agentrewire.SessionAttachResponse, error) {
	response := &agentrewire.SessionAttachResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_SESSION_ATTACH, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (c *machineConn) SessionPull(ctx context.Context, request *agentrewire.SessionPullRequest) (*agentrewire.SessionPullResponse, error) {
	response := &agentrewire.SessionPullResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (c *machineConn) SessionDelete(ctx context.Context, request *agentrewire.SessionDeleteRequest) (*agentrewire.SessionDeleteResponse, error) {
	response := &agentrewire.SessionDeleteResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_SESSION_DELETE, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

// ── transcriptimport.*（导入本地会话，规格 2026-08-26）─────────────────────
//
// 不认识这一族的 agentred 回 -32601，业务层据此说「这台机器的协议错误」，而不是
// 把它折成「这台机器上没有会话」。错误由业务层直接上交，这里只管把 typed 请求
// 送出去、把 typed 应答解回来。

func (c *machineConn) TranscriptImportScan(ctx context.Context, request *agentrewire.TranscriptImportScanRequest) (*agentrewire.TranscriptImportScanResponse, error) {
	response := &agentrewire.TranscriptImportScanResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_SCAN, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (c *machineConn) TranscriptImportOpen(ctx context.Context, request *agentrewire.TranscriptImportOpenRequest) (*agentrewire.TranscriptImportOpenResponse, error) {
	response := &agentrewire.TranscriptImportOpenResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_OPEN, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (c *machineConn) TranscriptImportTurns(ctx context.Context, request *agentrewire.TranscriptImportTurnsRequest) (*agentrewire.TranscriptImportTurnsResponse, error) {
	response := &agentrewire.TranscriptImportTurnsResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_TURNS, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (c *machineConn) TranscriptImportExecute(ctx context.Context, request *agentrewire.TranscriptImportExecuteRequest) (*agentrewire.TranscriptImportExecuteResponse, error) {
	response := &agentrewire.TranscriptImportExecuteResponse{}
	if err := c.call(ctx, agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_EXECUTE, request, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (c *machineConn) call(
	ctx context.Context, method agentrewire.RpcMethod, request, response proto.Message,
) error {
	id, reply, err := c.register()
	if err != nil {
		return err
	}
	defer c.forget(id)

	frame, err := relaywire.EncodeRequest(id, method, request)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	if err := c.relay.ForwardClient(ctx, c.route, c.channelID, websocket.BinaryMessage, frame); err != nil {
		return fmt.Errorf("forward method %d request: %w", method, err)
	}
	select {
	case result, ok := <-reply:
		if !ok {
			return ErrConnClosed
		}
		if result.rpcErr != nil {
			return &relaywire.Error{Code: result.rpcErr.GetCode(), Message: result.rpcErr.GetMessage(), Details: result.rpcErr.GetDetails()}
		}
		if result.response.GetMethodId() != uint32(method) {
			return relaywire.ErrResponseType
		}
		if err := proto.Unmarshal(result.response.GetEncodedPayload(), response); err != nil {
			return fmt.Errorf("decode method %d response: %w", method, err)
		}
		return nil
	case <-ctx.Done():
		c.sendCancel(id)
		return fmt.Errorf("await method %d response: %w", method, ctx.Err())
	}
}

func (c *machineConn) sendCancel(requestID uint64) {
	frame, err := relaywire.EncodeCancel(requestID)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	_ = c.relay.ForwardClient(ctx, c.route, c.channelID, websocket.BinaryMessage, frame)
}

func (c *machineConn) WriteMessage(_ int, data []byte) error {
	ctx := c.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	if len(data) == 0 {
		return nil
	}
	frame, err := relaywire.DecodeFrame(data)
	if err != nil {
		logger.Ctx(ctx).Warn("mirror relay Protobuf frame undecodable",
			zap.String("channelId", c.channelID), zap.Error(err))
		return nil
	}
	switch body := frame.GetBody().(type) {
	case *agentrewire.RpcFrame_Response:
		c.deliver(frame.GetId(), rpcResult{response: body.Response})
	case *agentrewire.RpcFrame_Error:
		c.deliver(frame.GetId(), rpcResult{rpcErr: body.Error})
	case *agentrewire.RpcFrame_Notification:
		if body.Notification != nil {
			c.onNotify(body.Notification)
		}
	default:
		logger.Ctx(ctx).Warn("mirror relay frame is not a response or notification",
			zap.String("channelId", c.channelID), zap.Uint64("requestId", frame.GetId()))
	}
	return nil
}

func (c *machineConn) deliver(id uint64, result rpcResult) {
	c.mu.Lock()
	defer c.mu.Unlock()
	reply, waiting := c.pending[id]
	if !waiting {
		return
	}
	select {
	case reply <- result:
	default:
	}
}

func (c *machineConn) register() (uint64, chan rpcResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return 0, nil, ErrConnClosed
	}
	c.nextID++
	reply := make(chan rpcResult, 1)
	c.pending[c.nextID] = reply
	return c.nextID, reply, nil
}

func (c *machineConn) forget(id uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.pending, id)
}

func (c *machineConn) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	for _, reply := range c.pending {
		close(reply)
	}
	c.pending = map[uint64]chan rpcResult{}
	c.mu.Unlock()
	if c.detach != nil {
		c.detach()
	}
}

var (
	_ RelaySession          = (*machineConn)(nil)
	_ relay_svc.FrameWriter = (*machineConn)(nil)
	_ RelayDialer           = (relay_svc.RelaySvc)(nil)
	_ CredentialSigner      = (*jwt.Signer)(nil)
)
