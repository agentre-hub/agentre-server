package relay_svc

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
)

type fakeForwarder struct{ err error }

func (f fakeForwarder) Check(context.Context, Route) error { return f.err }

func (f fakeForwarder) Forward(context.Context, Route, Peer, int, []byte) error { return f.err }

func newRelayForTest(t *testing.T, forwarder Forwarder) (RelaySvc, *miniredis.Miniredis, *mock_device_repo.MockDeviceRepo) {
	t.Helper()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	controller := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(controller)
	return New(Config{InstanceID: "server-a", OnlineTTL: time.Second}, devices, client, forwarder), mini, devices
}

func activeDaemon() *device_entity.Device {
	return &device_entity.Device{
		ID: 9, UserID: 7, Kind: device_entity.KindAgentred,
		Fingerprint: "fp-daemon", Status: 1,
	}
}

func TestRelayDaemonRegistrationExpiresAfterServerStopsRenewing(t *testing.T) {
	svc, mini, devices := newRelayForTest(t, fakeForwarder{})
	devices.EXPECT().Find(gomock.Any(), int64(9)).Return(activeDaemon(), nil)
	devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(activeDaemon(), nil).Times(2)

	route, err := svc.PrepareDaemon(context.Background(), 7, 9, device_entity.KindAgentred)
	require.NoError(t, err)
	require.Equal(t, "server-a", route.InstanceID)
	require.NoError(t, svc.RegisterDaemon(context.Background(), route))

	resolved, err := svc.ConnectClient(context.Background(), 7, "fp-daemon")
	require.NoError(t, err)
	require.Equal(t, route, resolved)

	// 模拟注册此 daemon 的 server 实例崩溃：没有任何续期，TTL 必须清除在线态。
	mini.FastForward(2 * time.Second)
	_, err = svc.ConnectClient(context.Background(), 7, "fp-daemon")
	require.ErrorIs(t, err, ErrDaemonOffline)
}

func TestRelayClientFailuresAreDistinguishable(t *testing.T) {
	ctx := context.Background()

	t.Run("daemon is not registered to this account", func(t *testing.T) {
		svc, _, devices := newRelayForTest(t, fakeForwarder{})
		devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-unknown").Return(nil, nil)

		_, err := svc.ConnectClient(ctx, 7, "fp-unknown")
		require.ErrorIs(t, err, ErrDaemonNotFound)
	})

	t.Run("registered daemon is offline", func(t *testing.T) {
		svc, _, devices := newRelayForTest(t, fakeForwarder{})
		devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(activeDaemon(), nil)

		_, err := svc.ConnectClient(ctx, 7, "fp-daemon")
		require.ErrorIs(t, err, ErrDaemonOffline)
	})

	t.Run("online daemon cannot be forwarded to", func(t *testing.T) {
		svc, _, devices := newRelayForTest(t, fakeForwarder{err: errors.New("frame bus unavailable")})
		devices.EXPECT().Find(gomock.Any(), int64(9)).Return(activeDaemon(), nil)
		devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(activeDaemon(), nil)
		route, err := svc.PrepareDaemon(ctx, 7, 9, device_entity.KindAgentred)
		require.NoError(t, err)
		require.NoError(t, svc.RegisterDaemon(ctx, route))

		_, err = svc.ConnectClient(ctx, 7, "fp-daemon")
		require.ErrorIs(t, err, ErrForwardFailed)
	})
}
