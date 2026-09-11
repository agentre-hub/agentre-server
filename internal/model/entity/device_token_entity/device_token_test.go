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

// access token 的有效期从签发那一刻（行的 createtime）起算，长度是 AccessTTL。
func TestDeviceToken_AccessExpiresAt(t *testing.T) {
	tok := &DeviceToken{Createtime: 1_000_000}
	assert.Equal(t, int64(1_000_000+15*60*1000), tok.AccessExpiresAt(15*time.Minute))
}

// 到点即失效：server 自己的时钟说了算，不再有验签那种时钟容差。
// 行上的 revoked_at 不参与判定——刷新轮换会置位它，而轮换出的旧令牌照常用到过期。
func TestDeviceToken_AccessValidAt(t *testing.T) {
	tok := &DeviceToken{Createtime: 1_000_000, RevokedAt: 1_000_500}
	assert.True(t, tok.AccessValidAt(1_000_000+59_999, time.Minute), "轮换过的行在过期前仍有效")
	assert.False(t, tok.AccessValidAt(1_000_000+60_000, time.Minute), "到点即失效")
	assert.False(t, (*DeviceToken)(nil).AccessValidAt(1_000_000, time.Minute), "没有行就没有令牌")
}
