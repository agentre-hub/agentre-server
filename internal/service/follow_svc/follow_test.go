package follow_svc

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/follow_entity"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
	"agentre-server/internal/repository/follow_repo"
	"agentre-server/internal/repository/follow_repo/mock_follow_repo"
)

func setupFollowTest(t *testing.T) (
	context.Context, *mock_follow_repo.MockFollowRepo, *mock_device_repo.MockDeviceRepo, *followSvc,
) {
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	mF := mock_follow_repo.NewMockFollowRepo(ctrl)
	mD := mock_device_repo.NewMockDeviceRepo(ctrl)
	follow_repo.RegisterFollow(mF)
	device_repo.RegisterDevice(mD)
	return context.Background(), mF, mD, newFollowSvc()
}

// R12：关注把「账号 + 目标设备指纹 + 会话标识 + 关注时间」落库；账号从调用方
// 上下文来，不由入参里的任何字段覆盖。
func TestFollow_AccountScopedPointer(t *testing.T) {
	_, mF, _, svc := setupFollowTest(t)
	mF.EXPECT().Follow(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, f *follow_entity.FollowedSession) error {
			assert.Equal(t, int64(7), f.UserID)
			assert.Equal(t, "fp-daemon-1", f.DeviceFingerprint)
			assert.Equal(t, "sess-9", f.SessionID)
			assert.Positive(t, f.FollowedAt)
			return nil
		},
	)
	require.NoError(t, svc.Follow(context.Background(), FollowInput{
		UserID: 7, DeviceFingerprint: "fp-daemon-1", SessionID: "sess-9",
	}))
}

// R12：取消关注只针对这一条（账号 + 目标 + 会话），不触碰别的关注、更不触碰
// 那条会话本身。
func TestUnfollow_ScopedToEntry(t *testing.T) {
	_, mF, _, svc := setupFollowTest(t)
	mF.EXPECT().Unfollow(gomock.Any(), int64(7), "fp-daemon-1", "sess-9").Return(nil)
	require.NoError(t, svc.Unfollow(context.Background(), FollowInput{
		UserID: 7, DeviceFingerprint: "fp-daemon-1", SessionID: "sess-9",
	}))
}

// R14 + R13：名单按账号取（任一端读到同一份）；目标设备仍在账号活跃设备里时
// 该条在名单里且不标失效（机器离线不影响——服务端不按在线态过滤），目标已不存
// 在（设备被撤销 / 从未存在）时标失效。载荷里只有指向，没有内容字段——字段白
// 名单由 internal/api/follow 的守卫断言锁住。
func TestList_AccountScopedAndInvalidFlag(t *testing.T) {
	_, mF, mD, svc := setupFollowTest(t)
	mF.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*follow_entity.FollowedSession{
		{UserID: 7, DeviceFingerprint: "fp-agentred-1", SessionID: "sess-a", FollowedAt: 3000},
		{UserID: 7, DeviceFingerprint: "fp-revoked", SessionID: "sess-b", FollowedAt: 2000},
		{UserID: 7, DeviceFingerprint: "fp-agentred-1", SessionID: "sess-c", FollowedAt: 1000},
	}, nil)
	// fp-revoked 不在账号的活跃设备里：它已被撤销 / 不存在，目标已不存在。
	mD.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*device_entity.Device{
		{UserID: 7, Fingerprint: "fp-agentred-1", Kind: device_entity.KindAgentred, Status: 1},
	}, nil)

	items, err := svc.List(context.Background(), 7)
	require.NoError(t, err)
	require.Len(t, items, 3)
	// 三条都在名单里（R13：目标离线 / 不存在不把条目从名单里抹掉）；
	// 已不存在的目标被标失效（可据此移除）。
	assert.False(t, items[0].Invalid)
	assert.True(t, items[1].Invalid)
	assert.False(t, items[2].Invalid)
	assert.Equal(t, "sess-a", items[0].SessionID)
	assert.Equal(t, "fp-agentred-1", items[0].DeviceFingerprint)
	assert.Equal(t, int64(3000), items[0].FollowedAt)
}
