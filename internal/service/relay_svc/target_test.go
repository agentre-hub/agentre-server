package relay_svc

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo/mock_agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
)

// newRelayWithSaves 与 newRelayForTest 同一装配，另交出名单仓库的 mock：按对话寻址
// 要经它把 conversation_id 解析成承载机器。
func newRelayWithSaves(t *testing.T, forwarder Forwarder) (
	RelaySvc, *miniredis.Miniredis,
	*mock_device_repo.MockDeviceRepo, *mock_agent_session_repo.MockSaveRepo,
) {
	t.Helper()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	controller := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(controller)
	saves := mock_agent_session_repo.NewMockSaveRepo(controller)
	svc := New(Config{InstanceID: "server-a", OnlineTTL: time.Second}, devices, saves, client, forwarder)
	return svc, mini, devices, saves
}

func registerOnline(t *testing.T, svc RelaySvc, fingerprint string) {
	t.Helper()
	require.NoError(t, svc.RegisterDaemon(context.Background(), Route{
		AccountID: 7, Fingerprint: fingerprint, InstanceID: "server-a",
	}))
}

// 已保存的对话只声明 conversation:<uuid>：承载它的机器由服务端查名单解析，客户端
// 全程不知道也不需要知道那是哪一台。
func TestResolveTarget_GivenASavedConversation_ThenRoutesToTheMachineCarryingIt(t *testing.T) {
	ctx := context.Background()
	svc, _, devices, saves := newRelayWithSaves(t, fakeForwarder{})
	saves.EXPECT().FindByIdentity(gomock.Any(), int64(7), "11111111-1111-7111-8111-111111111111").
		Return(&agent_session_entity.SessionSave{
			UserID: 7, ConversationID: "11111111-1111-7111-8111-111111111111",
			DeviceFingerprint: "fp-daemon", PeerFingerprint: "fp-web",
		}, nil)
	devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(activeDaemon(), nil)
	registerOnline(t, svc, "fp-daemon")

	route, err := svc.ResolveTarget(ctx, 7, "conversation:11111111-1111-7111-8111-111111111111")
	require.NoError(t, err)
	require.Equal(t, Route{AccountID: 7, Fingerprint: "fp-daemon", InstanceID: "server-a"}, route)
}

// 机器轴不消失：machine:<fingerprint> 直接解析，与 conversation: 共用同一条连接。
func TestResolveTarget_GivenAMachineForm_ThenRoutesToThatMachine(t *testing.T) {
	ctx := context.Background()
	svc, _, devices, _ := newRelayWithSaves(t, fakeForwarder{})
	devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-desktop").Return(activeDesktop(), nil)
	registerOnline(t, svc, "fp-desktop")

	route, err := svc.ResolveTarget(ctx, 7, "machine:fp-desktop")
	require.NoError(t, err)
	require.Equal(t, Route{AccountID: 7, Fingerprint: "fp-desktop", InstanceID: "server-a"}, route)
}

// isAddressableKind 是这道闸的**唯一**否决理由：目标设备存在、活跃、在线登记也
// 写了，只有 kind 不是 agentred / desktop，因此拒绝只可能出自那一次重查。
//
// 两种目标形式各查一遍：conversation: 解析出来的机器与 machine: 直接点名的机器
// 都要过。漏掉任一条等于把这道授权闸删掉。
func TestResolveTarget_GivenANonAddressableKind_ThenRefusesBothTargetForms(t *testing.T) {
	browser := func() *device_entity.Device {
		return &device_entity.Device{
			ID: 11, UserID: 7, Kind: device_entity.KindWeb, Fingerprint: "fp-web", Status: 1,
		}
	}
	require.True(t, browser().IsActive(), "前提：这台设备是活跃的，拒绝不能出自状态")

	t.Run("machine 形式", func(t *testing.T) {
		ctx := context.Background()
		svc, _, devices, _ := newRelayWithSaves(t, fakeForwarder{})
		devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-web").Return(browser(), nil)
		registerOnline(t, svc, "fp-web")

		_, err := svc.ResolveTarget(ctx, 7, "machine:fp-web")
		require.ErrorIs(t, err, ErrDaemonNotFound)
	})

	t.Run("conversation 形式", func(t *testing.T) {
		ctx := context.Background()
		svc, _, devices, saves := newRelayWithSaves(t, fakeForwarder{})
		saves.EXPECT().FindByIdentity(gomock.Any(), int64(7), "22222222-2222-7222-8222-222222222222").
			Return(&agent_session_entity.SessionSave{
				UserID: 7, ConversationID: "22222222-2222-7222-8222-222222222222",
				DeviceFingerprint: "fp-web",
			}, nil)
		devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-web").Return(browser(), nil)
		registerOnline(t, svc, "fp-web")

		_, err := svc.ResolveTarget(ctx, 7, "conversation:22222222-2222-7222-8222-222222222222")
		require.ErrorIs(t, err, ErrDaemonNotFound)
	})
}

// 账号里没有这条对话：解析不出承载机器，是「目标不存在」而不是「离线」。
func TestResolveTarget_GivenAnUnsavedConversation_ThenTargetNotFound(t *testing.T) {
	ctx := context.Background()
	svc, _, _, saves := newRelayWithSaves(t, fakeForwarder{})
	saves.EXPECT().FindByIdentity(gomock.Any(), int64(7), "33333333-3333-7333-8333-333333333333").
		Return(nil, nil)

	_, err := svc.ResolveTarget(ctx, 7, "conversation:33333333-3333-7333-8333-333333333333")
	require.ErrorIs(t, err, ErrDaemonNotFound)
}

// 承载机器还没连上来：这条通道拿到的是离线，与「不存在」区分得开。
func TestResolveTarget_GivenTheCarryingMachineIsOffline_ThenOffline(t *testing.T) {
	ctx := context.Background()
	svc, _, devices, _ := newRelayWithSaves(t, fakeForwarder{})
	devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-daemon").Return(activeDaemon(), nil)

	_, err := svc.ResolveTarget(ctx, 7, "machine:fp-daemon")
	require.ErrorIs(t, err, ErrDaemonOffline)
}

func TestResolveTarget_GivenAnUnknownForm_ThenInvalid(t *testing.T) {
	ctx := context.Background()
	svc, _, _, _ := newRelayWithSaves(t, fakeForwarder{})

	for _, target := range []string{"", "fp-daemon", "session:12", "conversation:", "machine:"} {
		_, err := svc.ResolveTarget(ctx, 7, target)
		require.ErrorIsf(t, err, ErrTargetInvalid, "target %q", target)
	}
}

// 决策 14：服务端分配的通道号取自 base64url，保留前缀由构造撞不上，因此保留号
// 不需要重试或注册表。
func TestNewChannelID_NeverCollidesWithTheReservedPrefix(t *testing.T) {
	for range 256 {
		id, err := newChannelID()
		require.NoError(t, err)
		require.NotEmpty(t, id)
		require.NotContains(t, id, ReservedChannelPrefix)
	}
}
