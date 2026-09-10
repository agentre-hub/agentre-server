package auth_svc

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// auth_svc 必须只用构造时交给它的那台 Redis。
//
// 这条钉的是依赖方向，不是「Redis 能不能读写」：service 伸手够 redis.Default()
// 全局单例时，它就没法在不改全局状态的前提下被测——今天 auth_svc 的 oauth state、
// relay ticket 集合与反向索引全走全局单例，只有 session.Store 那部分是注入的。
//
// 装置刻意让两台 Redis 不是同一台：注入的那台收所有写，全局那台必须自始至终是空的。
func TestAuthSvc_WritesOnlyToTheInjectedRedis(t *testing.T) {
	global := testutils.Redis(t)
	own := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: own.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	s := New(client, session.New(client, "server_session", 86400))
	ctx := context.Background()

	state, err := s.CreateOAuthState(ctx, OAuthStatePayload{Next: "/device", IP: "1.2.3.4"})
	require.NoError(t, err)
	got, err := s.ConsumeOAuthState(ctx, state)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "/device", got.Next)

	assert.Empty(t, global.Keys(),
		"oauth state 落到了全局默认那台 Redis 上，说明 auth_svc 没用注入的客户端")
}
