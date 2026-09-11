package credstore_test

import (
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
)

func newStore(t *testing.T) (*credstore.Store, *miniredis.Miniredis) {
	t.Helper()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return credstore.New(client), mini
}

// S1：浏览器票据是随机串，server 记下账号、类型与由账号派生的对端指纹，有效期 2 分钟。
// Redis 里只有摘要，没有明文。
func TestIssueRelayClient_RecordsAccountKindAndPeerForTwoMinutes(t *testing.T) {
	store, mini := newStore(t)
	ctx := t.Context()

	token, err := store.IssueRelayClient(ctx, 7, "sid-a")
	require.NoError(t, err)
	another, err := store.IssueRelayClient(ctx, 7, "sid-a")
	require.NoError(t, err)
	assert.NotEqual(t, token, another, "每张票都是新的随机串")
	assert.NotContains(t, token, ".", "不是 JWT 那种可解析的分段结构")
	assert.GreaterOrEqual(t, len(token), 43)

	before := time.Now()
	got, err := store.Resolve(ctx, token)
	require.NoError(t, err)
	assert.Equal(t, int64(7), got.AccountID)
	assert.Equal(t, credstore.KindRelayClient, got.Kind)
	assert.Equal(t, credstore.AccountPeerFingerprint(7), got.PeerFingerprint)
	assert.Equal(t, "sid-a", got.SessionID)
	assert.WithinDuration(t, before.Add(2*time.Minute), time.UnixMilli(got.ExpiresAt), 5*time.Second)
	assert.NotEmpty(t, got.Handle)
	assert.NotEqual(t, token, got.Handle, "句柄推不回凭据本身")

	for _, key := range mini.Keys() {
		assert.NotContains(t, key, token, "Redis 键里不能出现明文凭据")
		if value, getErr := mini.Get(key); getErr == nil {
			assert.NotContains(t, value, token, "Redis 值里不能出现明文凭据")
		}
		assert.Equal(t, 2*time.Minute, mini.TTL(key))
	}
}

// S1：server 自用的镜像 / 端口转发凭据是另一种类型，对端指纹由调用方（本副本）给出，
// 不挂在任何浏览器会话上。
func TestIssueServerMirror_RecordsTheGivenPeerUnderItsOwnKind(t *testing.T) {
	store, _ := newStore(t)
	ctx := t.Context()

	token, err := store.IssueServerMirror(ctx, 7, "server-mirror:abc")
	require.NoError(t, err)

	got, err := store.Resolve(ctx, token)
	require.NoError(t, err)
	assert.Equal(t, int64(7), got.AccountID)
	assert.Equal(t, credstore.KindServerMirror, got.Kind)
	assert.Equal(t, "server-mirror:abc", got.PeerFingerprint)
	assert.Empty(t, got.SessionID)
}

// S3：有效期内一张凭据可以被任意次解析；过期之后解析不到，记录与连接记号都不留在 Redis 里。
func TestResolve_RepeatableUntilExpiry(t *testing.T) {
	store, mini := newStore(t)
	ctx := t.Context()

	token, err := store.IssueRelayClient(ctx, 7, "sid-a")
	require.NoError(t, err)
	first, err := store.Resolve(ctx, token)
	require.NoError(t, err)
	claimed, err := store.ClaimRelayConnect(ctx, first.Handle)
	require.NoError(t, err)
	require.True(t, claimed)
	for range 3 {
		got, resolveErr := store.Resolve(ctx, token)
		require.NoError(t, resolveErr, "连过一次中继之后照样解析得到")
		assert.Equal(t, first.Handle, got.Handle)
	}
	byHandle, err := store.Lookup(ctx, first.Handle)
	require.NoError(t, err)
	assert.Equal(t, first, byHandle)

	mini.FastForward(2*time.Minute + time.Second)
	_, err = store.Resolve(ctx, token)
	assert.ErrorIs(t, err, credstore.ErrNotFound)
	_, err = store.Lookup(ctx, first.Handle)
	assert.ErrorIs(t, err, credstore.ErrNotFound)
	assert.Empty(t, mini.Keys(), "凭据过期后 Redis 里什么都不剩")
}

// S3：连接中继的认领只成功一次，逐凭据独立。
func TestClaimRelayConnect_SucceedsOncePerCredential(t *testing.T) {
	store, _ := newStore(t)
	ctx := t.Context()

	first, err := store.IssueRelayClient(ctx, 7, "sid-a")
	require.NoError(t, err)
	second, err := store.IssueRelayClient(ctx, 7, "sid-a")
	require.NoError(t, err)
	firstCred, err := store.Resolve(ctx, first)
	require.NoError(t, err)
	secondCred, err := store.Resolve(ctx, second)
	require.NoError(t, err)

	claimed, err := store.ClaimRelayConnect(ctx, firstCred.Handle)
	require.NoError(t, err)
	assert.True(t, claimed)
	claimed, err = store.ClaimRelayConnect(ctx, firstCred.Handle)
	require.NoError(t, err)
	assert.False(t, claimed, "同一张票第二次连接中继必须被拒")
	claimed, err = store.ClaimRelayConnect(ctx, secondCred.Handle)
	require.NoError(t, err)
	assert.True(t, claimed, "另一张票不受牵连")

	_, err = store.ClaimRelayConnect(ctx, "")
	assert.Error(t, err)
}

func TestResolve_UnknownOrEmptyIsNotFound(t *testing.T) {
	store, _ := newStore(t)
	ctx := t.Context()

	_, err := store.Resolve(ctx, "never-issued")
	assert.ErrorIs(t, err, credstore.ErrNotFound)
	_, err = store.Resolve(ctx, "")
	assert.ErrorIs(t, err, credstore.ErrNotFound)
	_, err = store.Lookup(ctx, "")
	assert.ErrorIs(t, err, credstore.ErrNotFound)
}

// 票据的撤销挂在签发它的浏览器会话上，没有会话的票就是一张登出撤不掉的票，不发。
// 镜像凭据的对端身份由调用方说了算，给不出就不发。
func TestIssue_RejectsCredentialsWithoutTheirBinding(t *testing.T) {
	store, mini := newStore(t)
	ctx := t.Context()

	_, err := store.IssueRelayClient(ctx, 7, "")
	assert.Error(t, err)
	_, err = store.IssueRelayClient(ctx, 0, "sid-a")
	assert.Error(t, err)
	_, err = store.IssueServerMirror(ctx, 7, "")
	assert.Error(t, err)
	_, err = store.IssueServerMirror(ctx, 0, "server-mirror:abc")
	assert.Error(t, err)
	assert.Empty(t, mini.Keys())
}

// Redis 不可用时签发、解析与认领都报错（fail-closed），解析的错误不能冒充「查无此票」。
func TestStore_FailsClosedWhenRedisIsUnavailable(t *testing.T) {
	store, mini := newStore(t)
	ctx := t.Context()
	token, err := store.IssueRelayClient(ctx, 7, "sid-a")
	require.NoError(t, err)
	cred, err := store.Resolve(ctx, token)
	require.NoError(t, err)

	mini.Close()

	_, err = store.IssueRelayClient(ctx, 7, "sid-a")
	assert.Error(t, err)
	_, err = store.IssueServerMirror(ctx, 7, "server-mirror:abc")
	assert.Error(t, err)
	_, err = store.Resolve(ctx, token)
	require.Error(t, err)
	assert.NotErrorIs(t, err, credstore.ErrNotFound)
	claimed, err := store.ClaimRelayConnect(ctx, cred.Handle)
	assert.Error(t, err)
	assert.False(t, claimed)
}

// 账号的网页对端身份迁出 pkg/jwt 时值不能变：变一次等于全账号的网页对端集体换人，
// 此前从网页发起的对话在镜像里当场成为孤儿。
func TestAccountPeerFingerprint_KeepsItsValue(t *testing.T) {
	assert.Equal(t, "sha256:877365ac4443ed41bd25b19d25108ddc23ca4debacc1c6f8cb35230201a84db1",
		credstore.AccountPeerFingerprint(7))
	assert.Equal(t, credstore.AccountPeerFingerprint(7), credstore.AccountPeerFingerprint(7))
	assert.NotEqual(t, credstore.AccountPeerFingerprint(7), credstore.AccountPeerFingerprint(8))
	assert.True(t, strings.HasPrefix(credstore.AccountPeerFingerprint(8), "sha256:"))
}
