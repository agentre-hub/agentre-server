// Package relaywire encodes the typed Protobuf RPC frames carried as opaque
// binary payloads by relay_svc. It owns no relay routing or WebSocket logic.
package relaywire

import (
	"errors"
	"fmt"

	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

const (
	CodeMethodNotFound int32 = -32601

	SessionLifecycleRunning     = "running"
	SessionLifecycleIdle        = "idle"
	SessionLifecycleInterrupted = "interrupted"

	DefaultSessionPullLimit = 200
)

var ErrResponseType = errors.New("relaywire: response type mismatch")

// Error is a transport-neutral typed RPC failure. Details contains
// method-specific Protobuf bytes when that method defines them.
type Error struct {
	Code    int32
	Message string
	Details []byte
}

func (e *Error) Error() string { return e.Message }

func EncodeRequest(id uint64, method agentrewire.RpcMethod, payload proto.Message) ([]byte, error) {
	encodedPayload, err := proto.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("relaywire: encode method %d payload: %w", method, err)
	}
	return EncodeFrame(&agentrewire.RpcFrame{Id: id, Body: &agentrewire.RpcFrame_Request{
		Request: &agentrewire.Request{MethodId: uint32(method), EncodedPayload: encodedPayload},
	}})
}

func EncodeCancel(requestID uint64) ([]byte, error) {
	return EncodeFrame(&agentrewire.RpcFrame{Body: &agentrewire.RpcFrame_Cancel{
		Cancel: &agentrewire.Cancel{RequestId: requestID},
	}})
}

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
