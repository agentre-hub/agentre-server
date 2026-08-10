package device_svc

import (
	"context"
	"testing"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/device_token_entity"
	"agentre-server/internal/pkg/jwtblacklist"
)

// RegisterWebDevice 是已登录浏览器按自己持久化的指纹换取 kind=web 设备身份的服务
// 入口（R1 / 决策 6）。同一指纹重复注册按 (user_id, fingerprint) 幂等。
func TestRegisterWebDevice(t *testing.T) {
	t.Run("正常注册：upsert 一台 kind=web 设备 + 签发 JWT + 落 token", func(t *testing.T) {
		ctx, mD, mT, _, svc, mock := setupDeviceTest(t)
		var capturedJTI string
		mD.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-web-abc").Return(nil, nil)
		mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, d *device_entity.Device) error {
				assert.Equal(t, device_entity.KindWeb, d.Kind)
				assert.Equal(t, int64(7), d.UserID)
				assert.Equal(t, "fp-web-abc", d.Fingerprint)
				assert.Equal(t, "Chrome · macOS", d.Name)
				assert.Equal(t, "macos", d.Platform)
				assert.Equal(t, 1, d.Status) // consts.ACTIVE
				assert.Positive(t, d.LastSeenAt)
				d.ID = 7
				return nil
			},
		)
		mT.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, tok *device_token_entity.DeviceToken) error {
				capturedJTI = tok.AccessJTI
				assert.Equal(t, int64(7), tok.DeviceID)
				return nil
			},
		)
		mock.ExpectBegin()
		mock.ExpectCommit()

		out, err := svc.RegisterWebDevice(ctx, RegisterWebDeviceInput{
			UserID: 7, Fingerprint: "fp-web-abc", Platform: "macos", Name: "Chrome · macOS",
		})
		require.NoError(t, err)
		require.NotEmpty(t, out.AccessToken)
		require.NotEmpty(t, out.RefreshToken)
		assert.Equal(t, int64(7), out.DeviceID)
		assert.Equal(t, out.JTI, capturedJTI)
		// 签发的设备 JWT 携带 kind=web：它在中继上是纯出站调用方（R3），
		// PrepareDaemon 据此把它挡在可寻址目标之外。
		claims, err := svc.signer.Verify(out.AccessToken)
		require.NoError(t, err)
		assert.Equal(t, device_entity.KindWeb, claims.Kind)
	})

	t.Run("同一指纹重复注册 → 同一台设备（按指纹幂等，不新增行）", func(t *testing.T) {
		ctx, mD, mT, _, svc, mock := setupDeviceTest(t)
		mD.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-web-abc").
			Return(nil, nil).Times(2)
		mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, d *device_entity.Device) error {
				d.ID = 7
				return nil
			},
		).Times(2)
		mT.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil).Times(2)
		mock.ExpectBegin()
		mock.ExpectCommit()
		mock.ExpectBegin()
		mock.ExpectCommit()

		out1, err := svc.RegisterWebDevice(ctx, RegisterWebDeviceInput{UserID: 7, Fingerprint: "fp-web-abc"})
		require.NoError(t, err)
		out2, err := svc.RegisterWebDevice(ctx, RegisterWebDeviceInput{UserID: 7, Fingerprint: "fp-web-abc"})
		require.NoError(t, err)
		// Upsert 按 (user_id, fingerprint) 命中既有行并 RETURNING 回填原 id（不新增行）。
		assert.Equal(t, out1.DeviceID, out2.DeviceID)
	})

	// R2：解除授权后「其余设备不受影响」的对偶面——被解除授权的那一个必须**留在**
	// 解除状态。Upsert 的赋值列里含 status，直接落库等于把 revoked 行翻回 ACTIVE
	// 并发一枚全新、不在黑名单里的设备 JWT：浏览器只要刷新一次页面就自己回来了，
	// 用户故事 5 的「单独把那个浏览器踢下线」形同虚设。
	t.Run("已被解除授权的指纹重新注册 → 拒绝,不复活设备行、不发新 JWT", func(t *testing.T) {
		ctx, mD, _, _, svc, _ := setupDeviceTest(t)
		mD.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-web-abc").Return(
			&device_entity.Device{ID: 42, UserID: 7, Fingerprint: "fp-web-abc", Status: consts.DELETE}, nil)
		// 拒绝发生在写之前：没有 Upsert、没有 token、连事务都不开。

		_, err := svc.RegisterWebDevice(ctx, RegisterWebDeviceInput{
			UserID: 7, Fingerprint: "fp-web-abc",
		})
		require.ErrorIs(t, err, ErrWebDeviceRevoked)
	})

	t.Run("name 缺省 → 回退到指纹前 8 位", func(t *testing.T) {
		ctx, mD, mT, _, svc, mock := setupDeviceTest(t)
		mD.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-web-abc").Return(nil, nil)
		mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, d *device_entity.Device) error {
				assert.Equal(t, "fp-web-a", d.Name)
				d.ID = 7
				return nil
			},
		)
		mT.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
		mock.ExpectBegin()
		mock.ExpectCommit()

		_, err := svc.RegisterWebDevice(ctx, RegisterWebDeviceInput{UserID: 7, Fingerprint: "fp-web-abc"})
		require.NoError(t, err)
	})
}

// R2：解除授权后浏览器的设备 JWT 失效（jti 入黑名单），其余设备不受影响。
// 设备 JWT 由 DeviceJWT 中间件逐请求校验黑名单——jti 一入黑名单，中继连接即被拒。
func TestRegisterWebDevice_RevokeBlacklistsItsJWT_OthersUnaffected(t *testing.T) {
	testutils.Redis()
	ctx, mD, mT, _, svc, mock := setupDeviceTest(t)

	var webJTI string
	mD.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "fp-web-abc").Return(nil, nil)
	mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, d *device_entity.Device) error {
			d.ID = 42
			return nil
		},
	)
	mT.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, tok *device_token_entity.DeviceToken) error {
			webJTI = tok.AccessJTI
			return nil
		},
	)
	mock.ExpectBegin()
	mock.ExpectCommit()

	out, err := svc.RegisterWebDevice(ctx, RegisterWebDeviceInput{UserID: 7, Fingerprint: "fp-web-abc"})
	require.NoError(t, err)
	require.Equal(t, int64(42), out.DeviceID)

	// 解除该浏览器的授权：它名下已签发 access token 的 jti 全部拉黑。
	mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return([]string{webJTI}, nil)
	mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
	mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
	require.NoError(t, svc.Revoke(ctx, 42))

	assert.True(t, jwtblacklist.Has(ctx, out.JTI), "浏览器的设备 JWT 必须在解除授权后失效")
	assert.False(t, jwtblacklist.Has(ctx, "jti-other-device"), "其余设备的 jti 不受影响")
}
