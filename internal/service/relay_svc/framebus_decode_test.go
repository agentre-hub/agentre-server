package relay_svc

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDecodeFrameRejectsMissingAcknowledgementDestination(t *testing.T) {
	_, _, _, _, _, _, err := decodeFrame(map[string]any{
		"peer": "client", "channel": "channel-1", "type": "2", "frame": "cmVxdWVzdA", "ack": "ack-1",
	})

	require.ErrorContains(t, err, "acknowledgement destination")
}
