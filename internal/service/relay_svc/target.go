package relay_svc

import (
	"context"
	"strings"
)

// 一条虚拟通道声明目标的两种形式（决策 11 的入口分流）。
//
// 已保存的对话走 TargetPrefixConversation：服务端查名单解析出承载它的机器，
// 客户端全程不知道那是哪一台。机器轴（目录选择器、引擎设置、session.list、
// 新建对话、未保存的对话）走 TargetPrefixMachine：那条路上机器是用户刚选的，
// 本来就在上下文里，而服务端也解析不出未保存对话的承载机器。
const (
	TargetPrefixConversation = "conversation:"
	TargetPrefixMachine      = "machine:"
)

// ReservedChannelPrefix 是保留通道号的前缀（决策 14）。通道 id 两端各自生成，
// 服务端取 base64url（newChannelID）、daemon 侧取 hex，两套字母表都不含它，
// 所以保留号由构造不可能与随机分配的通道相撞，不需要重试或注册表。
//
// 保留通道不指向任何一台机器，因此它**不经过 AttachClient**——那条路径在客户端
// 走人时会往通道上发一帧空载荷（「通道关了」）给 daemon，而保留通道压根没有
// 对端 daemon 可通知。客户端也不许自己开保留号，见 relay_ctr。
const ReservedChannelPrefix = "~"

// SignalChannelID 是账号信号那条保留通道（决策 13）。一条中继客户端连接上只有
// 这一条：普通通道承载 RPC，它承载 sync_version / mirror_changed / device_presence。
//
// 它**只出不进**：服务端开、服务端写，客户端往它写任何东西（包括普通通道上表示
// 「关掉这条」的空载荷）都按协议错误处理，见 relay_ctr。
const SignalChannelID = ReservedChannelPrefix + "signal"

// ResolveTarget 把一条通道声明的目标解析成路由。
//
// 两种形式最终都汇到 ConnectClient，那是有意的：那里握着这个账号能不能寻址这台
// 机器的全部判据（归属、活跃、isAddressableKind、在线登记、帧总线可达）。目标从
// 连接级降到通道级之后，这些判据必须**逐通道**重跑一遍——conversation: 解析出来的
// 机器同样要过，否则「浏览器 device kind 不得成为中继目标」这道闸就等于删掉了。
func (s *relaySvc) ResolveTarget(ctx context.Context, accountID int64, target string) (Route, error) {
	switch {
	case strings.HasPrefix(target, TargetPrefixConversation):
		conversationID := strings.TrimPrefix(target, TargetPrefixConversation)
		if conversationID == "" {
			return Route{}, ErrTargetInvalid
		}
		save, err := s.saves.FindByIdentity(ctx, accountID, conversationID)
		if err != nil {
			return Route{}, err
		}
		// 账号里没有这条对话：解析不出承载机器。这不是「机器离线」，客户端据此
		// 知道重试也没有用。
		if save == nil {
			return Route{}, ErrDaemonNotFound
		}
		return s.ConnectClient(ctx, accountID, save.DeviceFingerprint)
	case strings.HasPrefix(target, TargetPrefixMachine):
		fingerprint := strings.TrimPrefix(target, TargetPrefixMachine)
		if fingerprint == "" {
			return Route{}, ErrTargetInvalid
		}
		return s.ConnectClient(ctx, accountID, fingerprint)
	default:
		return Route{}, ErrTargetInvalid
	}
}

// 通道级失败的错误码。目标从连接级降到通道级之后（决策 10），这些失败不再能用
// HTTP 状态码作答——upgrade 早就发生过了，而整条连接上还跑着别的通道。它们改由
// 通道自己收到一帧 RpcFrame.error，客户端据此只把那一条通道标为不可达。
//
// 取值落在客户端 RPC 层的同一个码空间里（桌面仓 internal/pkg/rpcerror 的
// -32001…-32006 与 JSON-RPC 保留段），另开 -3201x 一段，因此与既有码不相撞。
// 每个码都配一个业务码，文案由 internal/pkg/code 的中英语言包给出。
const (
	// ChannelCodeTargetNotFound 目标解析不出机器：账号里没有这条对话，或指纹
	// 不属于这个账号 / 不是可寻址的 kind（isAddressableKind）。
	ChannelCodeTargetNotFound int32 = -32010
	// ChannelCodeTargetOffline 目标机器在册但此刻没有中继连接。
	ChannelCodeTargetOffline int32 = -32011
	// ChannelCodeForwardFailed 目标在线，但帧转发不可用。
	ChannelCodeForwardFailed int32 = -32012
	// ChannelCodeTargetInvalid 通道声明的目标不成形（既不是 conversation: 也
	// 不是 machine:）。
	ChannelCodeTargetInvalid int32 = -32013
	// ChannelCodeTargetForbidden 目标存在但这个账号不许把它当中继目标。
	ChannelCodeTargetForbidden int32 = -32016
	// ChannelCodeSignalUnavailable 保留通道（账号信号，决策 13）建不起来。
	ChannelCodeSignalUnavailable int32 = -32014
	// ChannelCodeReserved 客户端试图自己开一个保留号（决策 14）。保留号归服务端。
	ChannelCodeReserved int32 = -32015
	// ChannelCodeInternal 与桌面仓 rpcerror.CodeInternal 同值：客户端已经认得它。
	ChannelCodeInternal int32 = -32603
)
