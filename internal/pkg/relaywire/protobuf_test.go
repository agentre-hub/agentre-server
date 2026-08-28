package relaywire

import (
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

func TestEncodeRequestUsesStableMethodIDAndBinaryPayload(t *testing.T) {
	encoded, err := EncodeRequest(73, agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL,
		&agentrewire.SessionPullRequest{SessionId: 42, Cursor: 9, Limit: 200})
	require.NoError(t, err)
	require.NotEqual(t, byte('{'), encoded[0], "Protobuf frame must not be a JSON carrier")

	frame, err := DecodeFrame(encoded)
	require.NoError(t, err)
	require.Equal(t, uint64(73), frame.GetId())
	require.Equal(t, uint32(agentrewire.RpcMethod_RPC_METHOD_SESSION_PULL), frame.GetRequest().GetMethodId())

	var request agentrewire.SessionPullRequest
	require.NoError(t, proto.Unmarshal(frame.GetRequest().GetEncodedPayload(), &request))
	require.Equal(t, int64(42), request.GetSessionId())
	require.Equal(t, int64(9), request.GetCursor())
	require.Equal(t, int32(200), request.GetLimit())
}

func TestDecodeFrameRejectsMalformedBinary(t *testing.T) {
	_, err := DecodeFrame([]byte{0xff, 0xff})
	require.Error(t, err)
}
