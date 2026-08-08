package bootstrap

import (
	"context"
	"testing"
	"time"

	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/configs/memory"
	"github.com/stretchr/testify/assert"
)

func TestLoadServerConfig_AccessTTLDefaultIsMinuteLevel(t *testing.T) {
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(map[string]interface{}{
		"server": map[string]interface{}{},
	})))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, 15*time.Minute, got.JWT.AccessTTL)
	assert.Less(t, got.JWT.AccessTTL, time.Hour, "R4 要求访问凭据为分钟级短有效期")
	assert.Equal(t, 90*24*time.Hour, got.JWT.RefreshTTL)
}
