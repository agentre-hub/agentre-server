package device_token_entity

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestDeviceToken_IsRevoked(t *testing.T) {
	assert.False(t, (&DeviceToken{}).IsRevoked())
	assert.True(t, (&DeviceToken{RevokedAt: 12345}).IsRevoked())
}

func TestDeviceToken_IsExpired(t *testing.T) {
	now := time.Now().UnixMilli()
	assert.False(t, (&DeviceToken{RefreshExpiresAt: now + 1000}).IsExpired(now))
	assert.True(t, (&DeviceToken{RefreshExpiresAt: now - 1}).IsExpired(now))
}
