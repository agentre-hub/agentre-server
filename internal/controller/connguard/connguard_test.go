package connguard

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/controller/relay_ctr/relayws"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

type stubGate struct{ err error }

func (g stubGate) Check(context.Context, int64) error { return g.err }

func watchReturning(v bool) auth_svc.RelayCredentialWatch {
	return func(context.Context) bool { return v }
}

// 两条判据都放行时连接继续。
func TestCheck_AllowsWhenNeitherRejects(t *testing.T) {
	assert.NoError(t, check(context.Background(), 7, watchReturning(false), stubGate{}))
}

// 凭据已撤销 → 断开。中继 websocket 只在 upgrade 那一刻过一次鉴权中间件，登出与
// 设备撤销只有靠这条逐次复查才落得到一条已经建好的连接上。
func TestCheck_BreaksWhenCredentialRevoked(t *testing.T) {
	err := check(context.Background(), 7, watchReturning(true), stubGate{})
	assert.ErrorIs(t, err, relayws.ErrCredentialRevoked)
}

// 账号闸门拒绝 → 断开。封禁同样只有这条路径能落到已建连接上。
func TestCheck_BreaksWhenAccountGateRejects(t *testing.T) {
	err := check(context.Background(), 7, watchReturning(false), stubGate{err: errors.New("banned")})
	assert.ErrorIs(t, err, relayws.ErrCredentialRevoked)
}

// 两条判据的失败方向刻意相反，合并成一份实现时必须原样保住：
// 撤销判不出来（watch 为 nil）时**不**断开——那只是一次早已生效的撤销的收尾；
// 闸门判不出来（gate 为 nil，装配不全）时也不断开——装配不全不该让连接建不起来。
func TestCheck_UnwiredDependenciesFailOpen(t *testing.T) {
	assert.NoError(t, check(context.Background(), 7, nil, stubGate{}), "撤销判定缺席不该断开")
	assert.NoError(t, check(context.Background(), 7, watchReturning(false), nil), "闸门缺席不该断开")
	assert.NoError(t, check(context.Background(), 7, nil, nil))
}

// 闸门是每次复查现取的，不是建连时定死的：一条长连接跨过装配完成的那一刻之后，
// 后续复查必须开始受闸门管辖。
func TestNew_ReadsGateOnEveryCheck(t *testing.T) {
	auth_svc.SetDefault(nil)
	user_svc.SetGate(nil)
	t.Cleanup(func() { auth_svc.SetDefault(nil); user_svc.SetGate(nil) })

	guard := New(context.Background(), 7, "jti-1")
	require.NoError(t, guard(), "闸门未装配时放行")

	user_svc.SetGate(stubGate{err: errors.New("banned")})
	assert.ErrorIs(t, guard(), relayws.ErrCredentialRevoked, "装配后同一条连接必须开始受管辖")
}

// auth_svc 未装配、或这条连接没带 jti 时，取不到撤销判定，按不撤销处理。
func TestNew_NoCredentialWatchWithoutAuthSvcOrJTI(t *testing.T) {
	auth_svc.SetDefault(nil)
	user_svc.SetGate(nil)
	t.Cleanup(func() { auth_svc.SetDefault(nil); user_svc.SetGate(nil) })

	assert.Nil(t, watch(context.Background(), "jti-1"), "auth_svc 未装配")
	assert.Nil(t, watch(context.Background(), ""), "连接没带 jti")
}
