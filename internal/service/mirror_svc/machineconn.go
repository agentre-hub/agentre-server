package mirror_svc

import (
	"context"
	"fmt"
	"time"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/protorpc"

	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/pkg/wireversion"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"

	"github.com/agentre-hub/agentre/pkg/wire/wirecall"
)

// CredentialIssuer 为 server 自己连向某账号机器的一条连接签发短效凭据。类型由签发入口
// 定死为 server_mirror：它与浏览器换的中继票据分开，连不了 /v1/relay/client。
type CredentialIssuer interface {
	IssueServerMirror(ctx context.Context, accountID int64, peerFingerprint string) (string, error)
}

// RelayDialer 只负责定位通道并透传 opaque binary payload,不理解 RpcFrame。
type RelayDialer interface {
	ConnectClient(ctx context.Context, accountID int64, fingerprint string) (relay_svc.Route, error)
	AttachClient(ctx context.Context, target relay_svc.Route, writer relay_svc.FrameWriter) (string, func(), error)
	ForwardClient(ctx context.Context, target relay_svc.Route, channelID string, messageType int, frame []byte) error
	IsDaemonOnline(ctx context.Context, accountID int64, fingerprint string) (bool, error)
	DaemonConnID(ctx context.Context, accountID int64, fingerprint string) (string, error)
}

// machineConn 是 server mirror 的 typed Protobuf RPC client。公开给业务层的只有
// 具体方法;method ID 与 encoded payload 的通用调用留在这个传输实现内部。
//
// 帧编解码、请求 ID 关联、cancel、超时与通知派发都由共享协议引擎
// (github.com/agentre-hub/agentre/pkg/wire/protorpc) 负责 —— 那份实现由桌面仓
// 拥有、两仓共用,本仓只提供一个把中继通道适配成 FrameConn 的接缝
// (relayframeconn.go)。
type machineConn struct {
	conn      *protorpc.Conn
	transport *relayFrameConn
}

// dialMachine 不收「本副本的对端指纹」:身份不在请求体里(决策 8),它由对端核验
// 凭据时从 server 的记录里取,所以本副本出示什么身份完全取决于 Supervisor.dial 为
// 凭据记下了什么(见下面 AuthAccount 处的注释)。
// dialMachine 的第二个返回值是握手应答本身：调用方（Supervisor.dial）据此把这台机器
// 自报的构建版本刷回 devices.version（spec「控制台呈现与 latest 来源」一节，决策 14）。
func dialMachine(
	ctx context.Context, relay RelayDialer, credential string,
	m machineKey, timeout time.Duration, onNotify func(*agentrewire.RpcNotification),
) (*machineConn, *agentrewire.AuthAccountResponse, error) {
	route, err := relay.ConnectClient(ctx, m.userID, m.fingerprint)
	if err != nil {
		return nil, nil, fmt.Errorf("connect relay client: %w", err)
	}
	transport := newRelayFrameConn(ctx, relay, route, timeout)
	registry := protorpc.NewRegistry()
	if onNotify != nil {
		registry.RegisterNotification(func(_ context.Context, notification *agentrewire.RpcNotification) {
			onNotify(notification)
		})
	}
	channelID, detach, err := relay.AttachClient(ctx, route, transport)
	if err != nil {
		return nil, nil, fmt.Errorf("attach relay client: %w", err)
	}
	transport.channelID, transport.detach = channelID, detach

	c := &machineConn{transport: transport, conn: protorpc.NewConn(transport, registry, protorpc.WithCallTimeout(timeout))}
	go c.conn.Serve(ctx)

	// ProtocolVersion 是握手的必填项:对端按**精确匹配**校验,并且把空版本判成
	// 「对端太旧」(proto3 下缺字段与显式空串同为零值)。不带它 = 每一台机器都在
	// auth.account 上被拒 = 一条会话都镜像不下来。
	// MinSupportedProtocolVersion 与 ProtocolVersion 相等,不产生宽限窗口;带上它,
	// daemon 收到的握手里这个字段就不是空串(spec「协议：版本窗口与自报版本」一节，决策 3)。
	// 对端身份**不在请求体里**：它由对端核验凭据时从 server 的记录里取
	// （2026-08-31-conversation-centric-addressing.md 决策 8）。本副本出示什么身份，因此
	// 完全取决于 Supervisor.dial 为凭据记下了什么。
	response, err := c.AuthAccount(ctx, &agentrewire.AuthAccountRequest{
		Credential: credential, ProtocolVersion: wireversion.Protocol,
		MinSupportedProtocolVersion: wireversion.MinSupported,
	})
	if err != nil {
		c.Close()
		return nil, nil, fmt.Errorf("relay account handshake: %w", err)
	}
	return c, response, nil
}

func (c *machineConn) AuthAccount(ctx context.Context, request *agentrewire.AuthAccountRequest) (*agentrewire.AuthAccountResponse, error) {
	return wirecall.AuthAccount(ctx, c, request)
}

func (c *machineConn) SessionList(ctx context.Context, request *agentrewire.SessionListRequest) (*agentrewire.SessionListResponse, error) {
	return wirecall.SessionList(ctx, c, request)
}

// ActivityRollup 拉这台机器上按 (天 × 维度组合) 的会话计数。
//
// 它与镜像那几个方法住在同一条连接上,但答的是完全不同的东西:回包里只有天、几个不透
// 明标识和一个计数,没有标题、路径与对话内容。消费它的服务因此单独声明一个只含这一个
// 方法的窄接口 —— 别把它并进 RelaySession,那会让镜像也够得着滚存。
func (c *machineConn) ActivityRollup(ctx context.Context, request *agentrewire.ActivityRollupRequest) (*agentrewire.ActivityRollupResponse, error) {
	return wirecall.ActivityRollup(ctx, c, request)
}

func (c *machineConn) SessionAttach(ctx context.Context, request *agentrewire.SessionAttachRequest) (*agentrewire.SessionAttachResponse, error) {
	return wirecall.SessionAttach(ctx, c, request)
}

func (c *machineConn) SessionPull(ctx context.Context, request *agentrewire.SessionPullRequest) (*agentrewire.SessionPullResponse, error) {
	return wirecall.SessionPull(ctx, c, request)
}

func (c *machineConn) SessionDelete(ctx context.Context, request *agentrewire.SessionDeleteRequest) (*agentrewire.SessionDeleteResponse, error) {
	return wirecall.SessionDelete(ctx, c, request)
}

// AgentredSelfUpdate 让那台机器把自己换成新版本（规格 2026-09-03「远程一键升级」）。
//
// 应答只说「受理了没有」：受理之后 daemon 就会重启，这条连接随即断开，升级过程本身
// 在 wire 上不可观察。因此这里没有、也不该有「等它升完」的语义。
func (c *machineConn) AgentredSelfUpdate(
	ctx context.Context, request *agentrewire.AgentredSelfUpdateRequest,
) (*agentrewire.AgentredSelfUpdateResponse, error) {
	return wirecall.AgentredSelfUpdate(ctx, c, request)
}

// ── transcriptimport.*（导入本地会话，规格 2026-08-26）─────────────────────
//
// 不认识这一族的 agentred 回 -32601，业务层据此说「这台机器的协议错误」，而不是
// 把它折成「这台机器上没有会话」。错误由业务层直接上交，这里只管把 typed 请求
// 送出去、把 typed 应答解回来。

func (c *machineConn) TranscriptImportScan(ctx context.Context, request *agentrewire.TranscriptImportScanRequest) (*agentrewire.TranscriptImportScanResponse, error) {
	return wirecall.TranscriptImportScan(ctx, c, request)
}

func (c *machineConn) TranscriptImportOpen(ctx context.Context, request *agentrewire.TranscriptImportOpenRequest) (*agentrewire.TranscriptImportOpenResponse, error) {
	return wirecall.TranscriptImportOpen(ctx, c, request)
}

func (c *machineConn) TranscriptImportTurns(ctx context.Context, request *agentrewire.TranscriptImportTurnsRequest) (*agentrewire.TranscriptImportTurnsResponse, error) {
	return wirecall.TranscriptImportTurns(ctx, c, request)
}

func (c *machineConn) TranscriptImportExecute(ctx context.Context, request *agentrewire.TranscriptImportExecuteRequest) (*agentrewire.TranscriptImportExecuteResponse, error) {
	return wirecall.TranscriptImportExecute(ctx, c, request)
}

// Conn 让这条连接满足 wirecall.Caller。上面那些方法因此只剩「本仓要不要暴露它」这
// 一个决定 —— 方法 ID 与消息类型的配对在 pkg/wire/wirecall 里,两个仓库共用一份。
func (c *machineConn) Conn() *protorpc.Conn { return c.conn }

// Close 关掉这条连接:引擎收掉在飞的调用,传输层摘掉中继订阅。可重复调用。
func (c *machineConn) Close() {
	if c.conn != nil {
		_ = c.conn.Close()
	}
	if c.transport != nil {
		_ = c.transport.Close()
	}
}

var (
	_ RelaySession     = (*machineConn)(nil)
	_ RelayDialer      = (relay_svc.RelaySvc)(nil)
	_ CredentialIssuer = (*credstore.Store)(nil)
)
