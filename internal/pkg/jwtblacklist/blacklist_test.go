package jwtblacklist

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// 黑名单只用构造时交给它的那台 Redis。
//
// 装置刻意让两台不是同一台：注入的那台收写入并答得出，全局默认那台必须自始至终为空。
func TestBlacklist_UsesOnlyTheInjectedRedis(t *testing.T) {
	global := testutils.Redis(t)
	own := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: own.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	bl := New(client)
	ctx := context.Background()

	require.NoError(t, bl.Add(ctx, "jti-1", 60))
	assert.True(t, bl.Has(ctx, "jti-1"), "注入那台上刚写的 jti 应当查得到")
	assert.False(t, bl.Has(ctx, "jti-never-added"))

	assert.Empty(t, global.Keys(),
		"黑名单写到了全局默认那台 Redis 上，说明没用注入的客户端")
}
