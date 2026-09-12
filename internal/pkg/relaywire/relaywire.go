// Package relaywire 编码 relay_svc 以不透明二进制载荷承载的 RPC 帧。它不拥有任何
// 中继路由或 WebSocket 逻辑。
//
// 错误类型与错误码不在这里定义:它们由共享 module 的 pkg/wire/rpcerror 一份供两仓
// 使用。请求/取消帧的编码同理,由 pkg/wire/protorpc 负责;这里只有会话生命周期字面量
// 与两个给中继自己用的帧编解码助手(relay_ctr 要在通道级失败时自己合成一帧错误)。
package relaywire

import (
	"errors"
	"fmt"

	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

const (
	SessionLifecycleRunning = "running"
	SessionLifecycleIdle    = "idle"
	// SessionLifecycleFailed 是「上一轮以故障收场」。它与 Interrupted 是两件事：
	// Interrupted 是自锁终态（本站据它一律不去 attach，见 lib/relayClient），
	// Failed 只是一个关于上一轮的事实——会话照旧接得上、发得出下一轮。
	SessionLifecycleFailed      = "failed"
	SessionLifecycleInterrupted = "interrupted"

	DefaultSessionPullLimit = 200
)

func EncodeFrame(frame *agentrewire.RpcFrame) ([]byte, error) {
	if frame == nil || frame.GetBody() == nil {
		return nil, errors.New("relaywire: frame has no body")
	}
	encoded, err := proto.Marshal(frame)
	if err != nil {
		return nil, fmt.Errorf("relaywire: encode frame: %w", err)
	}
	return encoded, nil
}

func DecodeFrame(data []byte) (*agentrewire.RpcFrame, error) {
	frame := &agentrewire.RpcFrame{}
	if err := proto.Unmarshal(data, frame); err != nil {
		return nil, fmt.Errorf("relaywire: decode frame: %w", err)
	}
	if frame.GetBody() == nil {
		return nil, errors.New("relaywire: frame has no body")
	}
	return frame, nil
}
