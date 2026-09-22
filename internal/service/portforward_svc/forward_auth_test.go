package portforward_svc

import (
	"context"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

const (
	faUserID = int64(7)
	faPrefix = "abcdefghijkl"
	faOther  = "mnopqrstuvwx"
)

// newForwardAuthForTest 用真实的 session.Store（miniredis 背后）当控制台会话的存活
// 判据：转发会话「依附控制台会话」这一条要在真实的删除语义上成立，不是替身说了算。
func newForwardAuthForTest(t *testing.T) (*ForwardAuth, *session.Store, func(time.Duration)) {
	t.Helper()
	mini := testutils.Redis(t)
	store := session.New(redis.Default(), 86400)
	return NewForwardAuth(redis.Default(), store, time.Hour), store, mini.FastForward
}

func consoleSession(t *testing.T, store *session.Store) string {
	t.Helper()
	sid, _, err := store.Create(context.Background(), faUserID, session.Client{})
	require.NoError(t, err)
	return sid
}

func TestForwardAuth_CodeRedeemsOnceIntoASessionForThatPrefix(t *testing.T) {
	a, store, _ := newForwardAuthForTest(t)
	ctx := context.Background()
	sid := consoleSession(t, store)

	code, err := a.IssueCode(ctx, faUserID, faPrefix, sid)
	require.NoError(t, err)
	require.NotEmpty(t, code)

	token, err := a.Redeem(ctx, code, faPrefix)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	got, err := a.Resolve(ctx, token, faPrefix)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, faUserID, got.UserID)
	assert.Equal(t, faPrefix, got.Prefix)

	// 只能用一次：第二次兑换同一枚码失败。
	_, err = a.Redeem(ctx, code, faPrefix)
	assert.ErrorIs(t, err, ErrCodeInvalid)
}

func TestForwardAuth_CodeExpiresAfterSixtySeconds(t *testing.T) {
	a, store, fastForward := newForwardAuthForTest(t)
	ctx := context.Background()
	code, err := a.IssueCode(ctx, faUserID, faPrefix, consoleSession(t, store))
	require.NoError(t, err)

	fastForward(61 * time.Second)

	_, err = a.Redeem(ctx, code, faPrefix)
	assert.ErrorIs(t, err, ErrCodeInvalid)
}

func TestForwardAuth_CodeIssuedForOnePrefixIsRejectedOnAnother(t *testing.T) {
	a, store, _ := newForwardAuthForTest(t)
	ctx := context.Background()
	code, err := a.IssueCode(ctx, faUserID, faPrefix, consoleSession(t, store))
	require.NoError(t, err)

	_, err = a.Redeem(ctx, code, faOther)
	assert.ErrorIs(t, err, ErrCodeInvalid)
	// 拿错前缀试过一次也算用掉了：码不能被拿去各个前缀上挨个试。
	_, err = a.Redeem(ctx, code, faPrefix)
	assert.ErrorIs(t, err, ErrCodeInvalid)
}

func TestForwardAuth_UnknownCodeIsInvalid(t *testing.T) {
	a, _, _ := newForwardAuthForTest(t)
	_, err := a.Redeem(context.Background(), "never-issued", faPrefix)
	assert.ErrorIs(t, err, ErrCodeInvalid)
	_, err = a.Redeem(context.Background(), "", faPrefix)
	assert.ErrorIs(t, err, ErrCodeInvalid)
}

func TestForwardAuth_SessionForPrefixAIsNotValidOnPrefixB(t *testing.T) {
	a, store, _ := newForwardAuthForTest(t)
	ctx := context.Background()
	code, err := a.IssueCode(ctx, faUserID, faPrefix, consoleSession(t, store))
	require.NoError(t, err)
	token, err := a.Redeem(ctx, code, faPrefix)
	require.NoError(t, err)

	got, err := a.Resolve(ctx, token, faOther)
	require.NoError(t, err)
	assert.Nil(t, got)
}

func TestForwardAuth_SessionDiesWithItsConsoleSession(t *testing.T) {
	a, store, _ := newForwardAuthForTest(t)
	ctx := context.Background()
	sid := consoleSession(t, store)
	code, err := a.IssueCode(ctx, faUserID, faPrefix, sid)
	require.NoError(t, err)
	token, err := a.Redeem(ctx, code, faPrefix)
	require.NoError(t, err)

	require.NoError(t, store.Delete(ctx, sid))

	got, err := a.Resolve(ctx, token, faPrefix)
	require.NoError(t, err)
	assert.Nil(t, got, "控制台登出之后转发会话必须当场失效")
}

func TestForwardAuth_UnknownOrEmptyTokenResolvesToNothing(t *testing.T) {
	a, _, _ := newForwardAuthForTest(t)
	for _, token := range []string{"", "never-issued"} {
		got, err := a.Resolve(context.Background(), token, faPrefix)
		require.NoError(t, err)
		assert.Nil(t, got)
	}
}
