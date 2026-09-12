package auth_svc

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

type deviceResolverFunc func(ctx context.Context, token string) (*device_svc.Principal, error)

func (f deviceResolverFunc) ResolveBearer(ctx context.Context, token string) (*device_svc.Principal, error) {
	return f(ctx, token)
}

// knownDevice 认一枚设备 access token，其余一律答 ErrBearerInvalid。
func knownDevice(token string, p device_svc.Principal) deviceResolverFunc {
	return func(_ context.Context, got string) (*device_svc.Principal, error) {
		if got != token {
			return nil, device_svc.ErrBearerInvalid
		}
		return &p, nil
	}
}

// 核验入口认三种凭据：设备 access token 由设备服务解析，浏览器票据与 server 自用凭据由
// 短效凭据存储解析；各自带着自己的类型出来，谁也冒充不了谁。
func TestCredentialResolver_ResolvesEveryCredentialKind(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	auth := newSvc()
	sid, _, err := auth.StartSession(ctx, 7)
	require.NoError(t, err)
	ticket, err := auth.IssueRelayTicket(ctx, sid, 7)
	require.NoError(t, err)

	resolver := NewCredentialResolver(
		knownDevice("device-token", device_svc.Principal{AccountID: 7, DeviceID: 42, Kind: "desktop", Handle: "11"}),
		auth)

	device, err := resolver.ResolveBearer(ctx, "device-token")
	require.NoError(t, err)
	assert.Equal(t, int64(42), device.DeviceID)
	assert.Equal(t, "desktop", device.Kind)

	browser, err := resolver.ResolveBearer(ctx, ticket.Token)
	require.NoError(t, err)
	assert.Zero(t, browser.DeviceID)
	assert.Equal(t, credstore.KindRelayClient, browser.Kind)
	assert.Equal(t, credstore.AccountPeerFingerprint(7), browser.PeerFingerprint)

	_, err = resolver.ResolveBearer(ctx, "unknown")
	assert.ErrorIs(t, err, device_svc.ErrBearerInvalid)
	_, err = resolver.ResolveBearer(ctx, "")
	assert.ErrorIs(t, err, device_svc.ErrBearerInvalid)
}

// 设备服务判不出来（查库失败）不是「凭据无效」，原样上交，不拿同一串去问第二个存储。
func TestCredentialResolver_DeviceResolverFailureIsPassedThrough(t *testing.T) {
	testutils.Redis(t)
	boom := errors.New("database unavailable")
	resolver := NewCredentialResolver(deviceResolverFunc(
		func(context.Context, string) (*device_svc.Principal, error) { return nil, boom }), newSvc())

	_, err := resolver.ResolveBearer(context.Background(), "any-token")
	assert.ErrorIs(t, err, boom)
}

// 装配不全（没有设备服务或没有 auth_svc）时各自那一半一律无效，而不是 panic。
func TestCredentialResolver_MissingHalvesAreInvalid(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	auth := newSvc()
	sid, _, err := auth.StartSession(ctx, 7)
	require.NoError(t, err)
	ticket, err := auth.IssueRelayTicket(ctx, sid, 7)
	require.NoError(t, err)

	got, err := NewCredentialResolver(nil, auth).ResolveBearer(ctx, ticket.Token)
	require.NoError(t, err)
	assert.Equal(t, credstore.KindRelayClient, got.Kind)

	_, err = NewCredentialResolver(knownDevice("device-token", device_svc.Principal{DeviceID: 42}), nil).
		ResolveBearer(ctx, ticket.Token)
	assert.ErrorIs(t, err, device_svc.ErrBearerInvalid)
}
