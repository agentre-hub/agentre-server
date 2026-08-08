package device_svc

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	goredis "github.com/redis/go-redis/v9"
	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/device_flow_entity"
	"agentre-server/internal/model/entity/device_token_entity"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/repository/device_flow_repo"
	"agentre-server/internal/repository/device_flow_repo/mock_device_flow_repo"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
	"agentre-server/internal/repository/device_token_repo"
	"agentre-server/internal/repository/device_token_repo/mock_device_token_repo"
	"agentre-server/internal/service/relay_svc"
	hubtest "agentre-server/internal/testutils"
)

func setupDeviceTest(t *testing.T) (
	context.Context, *mock_device_repo.MockDeviceRepo,
	*mock_device_token_repo.MockDeviceTokenRepo,
	*mock_device_flow_repo.MockDeviceFlowRepo,
	*deviceSvc,
	sqlmock.Sqlmock,
) {
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	mD := mock_device_repo.NewMockDeviceRepo(ctrl)
	mT := mock_device_token_repo.NewMockDeviceTokenRepo(ctrl)
	mF := mock_device_flow_repo.NewMockDeviceFlowRepo(ctrl)
	device_repo.RegisterDevice(mD)
	device_token_repo.RegisterDeviceToken(mT)
	device_flow_repo.RegisterDeviceFlow(mF)

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	if err != nil {
		t.Fatal(err)
	}

	cfg := Config{
		UserCodeTTL: 10 * time.Minute, PollInterval: 5 * time.Second,
		AccessTTL: time.Hour, RefreshTTL: 90 * 24 * time.Hour,
		VerificationURI: "https://server/device",
	}
	ctx, _, mock := hubtest.DatabasePG(t)
	return ctx, mD, mT, mF, newDeviceSvc(cfg, signer), mock
}

func TestAuthorize_ReturnsUserCode(t *testing.T) {
	convey.Convey("Authorize", t, func() {
		ctx, _, _, mF, svc, _ := setupDeviceTest(t)
		mF.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, code *device_flow_entity.DeviceFlowCode) error {
				assert.Equal(t, "agentred", code.DeviceKind)
				return nil
			},
		)

		out, err := svc.Authorize(ctx, AuthorizeInput{
			DeviceKind: "agentred", Fingerprint: "fp-aaaaaaaa", Platform: "linux/amd64", Version: "0.5.0",
		})
		assert.NoError(t, err)
		assert.NotEmpty(t, out.DeviceCode)
		assert.NotEmpty(t, out.UserCode)
		assert.Contains(t, out.VerificationURIComplete, "user_code="+out.UserCode)
		assert.Equal(t, 5, out.Interval)
		assert.Equal(t, 600, out.ExpiresIn)
	})
}

func TestExchangeToken(t *testing.T) {
	convey.Convey("ExchangeToken", t, func() {
		convey.Convey("device_code 不存在 → invalid_grant", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(nil, nil)
			_, err := svc.ExchangeToken(ctx, "dc-x")
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "invalid_grant")
		})
		convey.Convey("已过期 → expired_token", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
				&device_flow_entity.DeviceFlowCode{DeviceCode: "dc-x", ExpiresAt: 1}, nil,
			)
			_, err := svc.ExchangeToken(ctx, "dc-x")
			assert.Contains(t, err.Error(), "expired_token")
		})
		convey.Convey("已 denied → access_denied", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
				&device_flow_entity.DeviceFlowCode{DeviceCode: "dc-x", ExpiresAt: time.Now().Add(time.Hour).UnixMilli(), DeniedAt: 100}, nil,
			)
			_, err := svc.ExchangeToken(ctx, "dc-x")
			assert.Contains(t, err.Error(), "access_denied")
		})
		convey.Convey("未授权 → authorization_pending（更新 last_polled）", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
				&device_flow_entity.DeviceFlowCode{
					DeviceCode: "dc-x", IntervalSeconds: 5,
					ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
				}, nil,
			)
			mF.EXPECT().UpdateLastPolled(gomock.Any(), "dc-x", gomock.Any()).Return(nil)
			_, err := svc.ExchangeToken(ctx, "dc-x")
			assert.Contains(t, err.Error(), "authorization_pending")
		})
		convey.Convey("已授权 → 颁发 token + 标 consumed + upsert device", func() {
			ctx, mD, mT, mF, svc, mock := setupDeviceTest(t)
			var capturedJTI string
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
				&device_flow_entity.DeviceFlowCode{
					DeviceCode: "dc-x", IntervalSeconds: 5,
					ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
					AuthorizedUserID: 42, ApprovedAt: time.Now().UnixMilli(),
					DeviceKind: "agentred", ClientFingerprint: "fp-xxxxxxx",
				}, nil,
			)
			mF.EXPECT().UpdateLastPolled(gomock.Any(), "dc-x", gomock.Any()).Return(nil)
			mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, d *device_entity.Device) error {
					assert.Equal(t, "agentred", d.Kind)
					d.ID = 7
					return nil
				},
			)
			mT.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, tok *device_token_entity.DeviceToken) error {
					capturedJTI = tok.AccessJTI
					return nil
				},
			)
			mF.EXPECT().MarkConsumed(gomock.Any(), "dc-x", gomock.Any()).Return(int64(1), nil)

			mock.ExpectBegin()
			mock.ExpectCommit()

			out, err := svc.ExchangeToken(ctx, "dc-x")
			assert.NoError(t, err)
			assert.NotEmpty(t, out.AccessToken)
			assert.NotEmpty(t, out.RefreshToken)
			assert.Equal(t, int64(7), out.DeviceID)
			assert.Equal(t, out.JTI, capturedJTI)
		})
		convey.Convey("并发竞败（MarkConsumed 命中 0 行）→ invalid_grant，且在写 device 之前就出局", func() {
			ctx, mD, mT, mF, svc, mock := setupDeviceTest(t)
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
				&device_flow_entity.DeviceFlowCode{
					DeviceCode: "dc-x", IntervalSeconds: 5,
					ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
					AuthorizedUserID: 42, ApprovedAt: time.Now().UnixMilli(),
					DeviceKind: "agentred", ClientFingerprint: "fp-xxxxxxx",
				}, nil,
			)
			mF.EXPECT().UpdateLastPolled(gomock.Any(), "dc-x", gomock.Any()).Return(nil)
			// 赢家已经把这一行标为 consumed，竞败方的 UPDATE 一行也改不到
			mF.EXPECT().MarkConsumed(gomock.Any(), "dc-x", gomock.Any()).Return(int64(0), nil)
			// 消费判定必须排在写 devices / device_tokens 之前：竞败方在这里出局，
			// 一行也不写，不必靠回滚去擦掉已经落到 WAL 上的设备行和 token 行。
			mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).Times(0)
			mT.EXPECT().Create(gomock.Any(), gomock.Any()).Times(0)

			mock.ExpectBegin()
			mock.ExpectRollback()

			out, err := svc.ExchangeToken(ctx, "dc-x")
			assert.Nil(t, out)
			assert.Error(t, err)
			assert.Contains(t, err.Error(), ErrInvalidGrant)
			// 回滚落到数据库上：设备行与 token 行都不留下
			assert.NoError(t, mock.ExpectationsWereMet())
		})
	})
}

func TestRefresh(t *testing.T) {
	convey.Convey("Refresh", t, func() {
		convey.Convey("token 不存在 → invalid_grant", func() {
			ctx, _, mT, _, svc, _ := setupDeviceTest(t)
			mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(nil, nil)
			_, err := svc.Refresh(ctx, "missing")
			assert.Contains(t, err.Error(), "invalid_grant")
		})
		convey.Convey("token 已 revoked → 重放 → RevokeChain", func() {
			ctx, _, mT, _, svc, _ := setupDeviceTest(t)
			mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
				&device_token_entity.DeviceToken{ID: 1, DeviceID: 42, RevokedAt: 5000}, nil,
			)
			mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			_, err := svc.Refresh(ctx, "stolen")
			assert.Contains(t, err.Error(), "invalid_grant")
		})
		convey.Convey("正常轮换 → 新 refresh + 旧 revoke + touch device", func() {
			ctx, mD, mT, _, svc, mock := setupDeviceTest(t)
			var capturedJTI string
			mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
				&device_token_entity.DeviceToken{
					ID: 1, DeviceID: 42, RefreshExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
				}, nil,
			)
			mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
				&device_entity.Device{ID: 42, UserID: 7, Kind: "agentred", Status: 1}, nil,
			)
			mT.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, tok *device_token_entity.DeviceToken) error {
					capturedJTI = tok.AccessJTI
					return nil
				},
			)
			mT.EXPECT().Revoke(gomock.Any(), int64(1), gomock.Any()).Return(int64(1), nil)
			mD.EXPECT().Touch(gomock.Any(), int64(42), gomock.Any()).Return(nil)

			mock.ExpectBegin()
			mock.ExpectCommit()

			out, err := svc.Refresh(ctx, "good")
			assert.NoError(t, err)
			assert.NotEmpty(t, out.AccessToken)
			assert.NotEmpty(t, out.RefreshToken)
			assert.Equal(t, int64(42), out.DeviceID)
			assert.Equal(t, out.JTI, capturedJTI)
		})
	})
}

func TestRevoke(t *testing.T) {
	convey.Convey("Revoke", t, func() {
		convey.Convey("把被撤设备已签发的 access jti 全部写入黑名单（在线设备立即失效）", func() {
			testutils.Redis()
			ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
			mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return([]string{"jti-aaa", "jti-bbb"}, nil)
			mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)

			err := svc.Revoke(ctx, 42)
			convey.So(err, convey.ShouldBeNil)

			for _, jti := range []string{"jti-aaa", "jti-bbb"} {
				v, gerr := redis.Default().Get(ctx, "jwt_blacklist:"+jti).Result()
				convey.So(gerr, convey.ShouldBeNil)
				convey.So(v, convey.ShouldEqual, "1")
			}
		})

		// 黑名单条目必须活得比 access token 还久一点。Verify 带 jwt.Leeway 的时钟
		// 偏移,一个 12:00 签发的 token 到 12:00+AccessTTL+Leeway 都还验得过;而
		// TTL 只取 AccessTTL 时,它从吊销那一刻起算,12:00:05 撤销的话黑名单
		// 12:00:05+AccessTTL 就到期 —— 中间那 55s 里被撤销的设备又能用了。
		convey.Convey("黑名单 TTL 覆盖到 token 真正失效为止（含验签时钟偏移）", func() {
			testutils.Redis()
			ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
			mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return([]string{"jti-aaa"}, nil)
			mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)

			convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)

			ttl, gerr := redis.Default().TTL(ctx, "jwt_blacklist:jti-aaa").Result()
			convey.So(gerr, convey.ShouldBeNil)
			convey.So(ttl, convey.ShouldBeGreaterThan, svc.cfg.AccessTTL)
			convey.So(ttl, convey.ShouldBeLessThanOrEqualTo, svc.cfg.AccessTTL+jwt.Leeway)
		})

		// R19「解除授权」的可观察后果：撤销后该设备无法再刷新。黑名单只覆盖已签发
		// access token 的 AccessTTL 窗口，真正让设备回不来的是 devices 行被置为
		// 已撤销后 Refresh 的这道判定 —— 少了它，撤销一台设备只是让它等 15 分钟。
		convey.Convey("撤销后该设备手上未过期的 refresh token 也换不到新凭据", func() {
			testutils.Redis()
			ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
			dev := &device_entity.Device{ID: 42, UserID: 7, Kind: device_entity.KindAgentred, Status: consts.ACTIVE}

			mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return(nil, nil)
			mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).DoAndReturn(
				func(_ context.Context, _, _ int64) error {
					dev.Status = consts.DELETE // device_repo.Revoke 的落库效果
					return nil
				},
			)
			convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)

			// refresh token 本身既没被重放也没过期，唯一变的是设备已被解除授权。
			mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
				&device_token_entity.DeviceToken{
					ID: 1, DeviceID: 42,
					RefreshExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
				}, nil,
			)
			mD.EXPECT().Find(gomock.Any(), int64(42)).Return(dev, nil)

			_, err := svc.Refresh(ctx, "still-unexpired")
			convey.So(err, convey.ShouldNotBeNil)
			convey.So(err.Error(), convey.ShouldContainSubstring, "invalid_grant")
			convey.So(err.Error(), convey.ShouldContainSubstring, "device revoked")
		})
	})
}

func TestListRevokedJTI(t *testing.T) {
	convey.Convey("ListRevokedJTI", t, func() {
		convey.Convey("按账号（非调用设备）取吊销列表，窗口起点=now-AccessTTL", func() {
			ctx, _, mT, _, svc, _ := setupDeviceTest(t)
			var capturedWindowStart int64
			mT.EXPECT().ListRevokedJTIByUser(gomock.Any(), int64(7), gomock.Any()).DoAndReturn(
				func(_ context.Context, userID, windowStartMs int64) ([]string, error) {
					capturedWindowStart = windowStartMs
					return []string{"jti-revoked-1", "jti-revoked-2"}, nil
				},
			)

			// 窗口必须覆盖到 token 真正不再验签为止 —— Verify 带 jwt.Leeway 的时钟
			// 偏移,exp 之后还会接受 Leeway 那么久。只减 AccessTTL 会让 jti 在最后
			// Leeway 秒里既不在吊销列表上、又仍然验得过。
			window := svc.cfg.AccessTTL + jwt.Leeway
			before := time.Now().Add(-window).UnixMilli()
			got, err := svc.ListRevokedJTI(ctx, 7)
			after := time.Now().Add(-window).UnixMilli()

			assert.NoError(t, err)
			assert.Equal(t, []string{"jti-revoked-1", "jti-revoked-2"}, got)
			assert.GreaterOrEqual(t, capturedWindowStart, before)
			assert.LessOrEqual(t, capturedWindowStart, after)
		})

		convey.Convey("repo 报错时原样返回", func() {
			ctx, _, mT, _, svc, _ := setupDeviceTest(t)
			wantErr := errors.New("boom")
			mT.EXPECT().ListRevokedJTIByUser(gomock.Any(), int64(7), gomock.Any()).Return(nil, wantErr)

			_, err := svc.ListRevokedJTI(ctx, 7)
			assert.ErrorIs(t, err, wantErr)
		})
		convey.Convey("并发竞败（Revoke 命中 0 行）→ invalid_grant、回滚、且不整链撤销", func() {
			ctx, mD, mT, _, svc, mock := setupDeviceTest(t)
			mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
				&device_token_entity.DeviceToken{
					ID: 1, DeviceID: 42, RefreshExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
				}, nil,
			)
			mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
				&device_entity.Device{ID: 42, UserID: 7, Kind: "agentred", Status: 1}, nil,
			)
			// 赢家刚轮换完这条 token，竞败方的 UPDATE 一行也改不到
			mT.EXPECT().Revoke(gomock.Any(), int64(1), gomock.Any()).Return(int64(0), nil)
			// 判定必须排在写 device_tokens 之前：竞败方在这里出局，一行也不写。
			// 这是 architecture.md「事务里先做带条件的 UPDATE，再做依赖胜出的写」
			// 那条规则在 Refresh 上的落点，和 ExchangeToken 保持一致。
			mT.EXPECT().Create(gomock.Any(), gomock.Any()).Times(0)
			// 竞败不是重放：链是健康的，撤了会误伤只是重试的客户端
			mT.EXPECT().RevokeChain(gomock.Any(), gomock.Any(), gomock.Any()).Times(0)

			mock.ExpectBegin()
			mock.ExpectRollback()

			out, err := svc.Refresh(ctx, "good")
			assert.Nil(t, out)
			assert.Error(t, err)
			assert.Contains(t, err.Error(), ErrInvalidGrant)
			assert.NoError(t, mock.ExpectationsWereMet())
		})
	})
}

func TestListUserDevices(t *testing.T) {
	convey.Convey("ListUserDevices marks caller and reports real relay presence", t, func() {
		ctx, mD, _, _, svc, _ := setupDeviceTest(t)
		callerDev := int64(42)
		userID := int64(7)

		// 在线态来自 Redis 中继登记（R20），而非 devices.status：用 miniredis 支撑真实 relay_svc。
		mini := miniredis.RunT(t)
		redisClient := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
		t.Cleanup(func() { require.NoError(t, redisClient.Close()) })
		relay := relay_svc.New(
			relay_svc.Config{InstanceID: "server-a", OnlineTTL: time.Second},
			nil, redisClient, relay_svc.NewUnavailableForwarder(),
		)
		relay_svc.SetDefault(relay)
		t.Cleanup(func() { relay_svc.SetDefault(nil) })

		mD.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{
			{ID: 42, UserID: 7, Name: "mac-pro-m4", Kind: "desktop", Platform: "darwin/arm64", Version: "v0.4.1", Fingerprint: "fp-a", LastSeenAt: 1000, Status: 1},
			{ID: 43, UserID: 7, Name: "agentred-1", Kind: "agentred", Platform: "linux/amd64", Version: "v0.4.1", Fingerprint: "fp-b", LastSeenAt: 999, Status: 1},
		}, nil)

		// 只为 agentred-1（fp-b）登记在线态；mac-pro-m4 无登记 → 离线。
		require.NoError(t, relay.RegisterDaemon(ctx, relay_svc.Route{
			AccountID: userID, Fingerprint: "fp-b", InstanceID: "server-a",
		}))

		items, err := svc.ListUserDevices(ctx, userID, callerDev)

		convey.So(err, convey.ShouldBeNil)
		convey.So(len(items), convey.ShouldEqual, 2)
		convey.So(items[0].ID, convey.ShouldEqual, int64(42))
		convey.So(items[0].IsThisDevice, convey.ShouldBeTrue)
		convey.So(items[1].IsThisDevice, convey.ShouldBeFalse)
		// 在线态 = Redis 中继登记存在，与 devices.status 无关（R20）
		convey.So(items[1].Online, convey.ShouldBeTrue)
		convey.So(items[0].Online, convey.ShouldBeFalse)
	})
}

// 复现集成测试里观测到的崩溃：device_svc.New() 构造出的 deviceSvc 在调用方从未
// 注册 relay_svc.Default()（比如只装配了 device flow 而没有整套 bootstrap 的测试/调用方）
// 时，ListUserDevices 不能 panic——在线态只是增强列，必须 fail-open 为离线。
func TestListUserDevices_RelayNotConfigured(t *testing.T) {
	convey.Convey("relay_svc 未注册时 ListUserDevices 不 panic，在线态 fail-open 为 false", t, func() {
		ctx, mD, _, _, svc, _ := setupDeviceTest(t)
		relay_svc.SetDefault(nil)
		t.Cleanup(func() { relay_svc.SetDefault(nil) })

		mD.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*device_entity.Device{
			{ID: 42, UserID: 7, Name: "mac-pro-m4", Kind: "desktop", Platform: "darwin/arm64", Fingerprint: "fp-a", Status: 1},
		}, nil)

		items, err := svc.ListUserDevices(ctx, 7, 42)

		convey.So(err, convey.ShouldBeNil)
		convey.So(len(items), convey.ShouldEqual, 1)
		convey.So(items[0].Online, convey.ShouldBeFalse)
	})
}

func TestApprove(t *testing.T) {
	convey.Convey("Approve", t, func() {
		convey.Convey("不存在 → user_code_invalid", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().FindPendingByUserCode(gomock.Any(), "A4F-7Q2").Return(nil, nil)
			_, err := svc.Approve(ctx, "A4F-7Q2", 42)
			assert.Error(t, err)
		})
		convey.Convey("成功 → 返回 device_kind", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().FindPendingByUserCode(gomock.Any(), "A4F-7Q2").Return(
				&device_flow_entity.DeviceFlowCode{
					UserCode: "A4F-7Q2", DeviceKind: "agentred",
					ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
				}, nil,
			)
			mF.EXPECT().Approve(gomock.Any(), "A4F-7Q2", int64(42), gomock.Any()).Return(int64(1), nil)

			kind, err := svc.Approve(ctx, "A4F-7Q2", 42)
			assert.NoError(t, err)
			assert.Equal(t, "agentred", kind)
		})
		convey.Convey("并发竞败（Approve 命中 0 行）→ user_code_invalid", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().FindPendingByUserCode(gomock.Any(), "A4F-7Q2").Return(
				&device_flow_entity.DeviceFlowCode{
					UserCode: "A4F-7Q2", DeviceKind: "agentred",
					ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
				}, nil,
			)
			// 另一个请求已抢先批准/拒绝/换取，UPDATE 一行也改不到
			mF.EXPECT().Approve(gomock.Any(), "A4F-7Q2", int64(42), gomock.Any()).Return(int64(0), nil)

			kind, err := svc.Approve(ctx, "A4F-7Q2", 42)
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "user_code_invalid")
			assert.Empty(t, kind)
		})
	})
}

func TestDeny(t *testing.T) {
	convey.Convey("Deny", t, func() {
		convey.Convey("命中 1 行 → 成功", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().Deny(gomock.Any(), "A4F-7Q2", gomock.Any()).Return(int64(1), nil)
			assert.NoError(t, svc.Deny(ctx, "A4F-7Q2"))
		})
		convey.Convey("命中 0 行（不存在/已换取/已拒绝）→ user_code_invalid，不再假成功", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().Deny(gomock.Any(), "A4F-7Q2", gomock.Any()).Return(int64(0), nil)
			err := svc.Deny(ctx, "A4F-7Q2")
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "user_code_invalid")
		})
		convey.Convey("格式非法 → user_code_invalid", func() {
			ctx, _, _, _, svc, _ := setupDeviceTest(t)
			err := svc.Deny(ctx, "!!!")
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "user_code_invalid")
		})
	})
}
