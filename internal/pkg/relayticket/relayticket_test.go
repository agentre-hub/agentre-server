package relayticket

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// 票据记号只落在构造时交给它的那台 Redis 上。
//
// 顺带钉住一次性语义：同一张票认领两次，第二次必须报「不是第一次」——记号写到了
// 别的地方，这条就会退化成「每次都是第一次」，重放防护整个失效。
func TestTickets_UsesOnlyTheInjectedRedis(t *testing.T) {
	global := testutils.Redis(t)
	own := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: own.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	tickets := New(client)
	ctx := context.Background()

	first, err := tickets.Consume(ctx, "jti-1", time.Minute)
	require.NoError(t, err)
	assert.True(t, first, "第一次认领应当成功")

	again, err := tickets.Consume(ctx, "jti-1", time.Minute)
	require.NoError(t, err)
	assert.False(t, again, "同一张票的第二次认领必须被拒")

	assert.Empty(t, global.Keys(),
		"焚毁记号写到了全局默认那台 Redis 上，说明没用注入的客户端")
}
