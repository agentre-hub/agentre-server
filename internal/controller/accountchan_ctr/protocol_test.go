package accountchan_ctr

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

func TestEncodeNotificationUsesSharedProtobufContract(t *testing.T) {
	payload, err := encodeNotification(accountchan_svc.Frame{
		Type:    accountchan_svc.FrameTypeSyncVersion,
		Version: 42,
	})

	require.NoError(t, err)
	require.Equal(t, []byte{0x0a, 0x04, 0x0a, 0x02, 0x08, 0x2a}, payload)
}
