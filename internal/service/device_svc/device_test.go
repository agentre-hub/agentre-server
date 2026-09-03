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
	goredis "github.com/redis/go-redis/v9"
	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_flow_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_token_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/repository/device_flow_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_flow_repo/mock_device_flow_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo/mock_device_token_repo"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
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
	ctx, _, mock := hubtest.Database(t)
	return ctx, mD, mT, mF, newDeviceSvc(cfg, signer), mock
}

func TestAuthorize_ReturnsUserCode(t *testing.T) {
	convey.Convey("Authorize", t, func() {
		ctx, _, _, mF, svc, _ := setupDeviceTest(t)
		mF.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, code *device_flow_entity.DeviceFlowCode) error {
				assert.Equal(t, "agentred", code.DeviceKind)
				// 自报名字必须落进 flow 行：换取 token 时 devices.name 只认它。
				assert.Equal(t, "coding", code.ClientName)
				return nil
			},
		)

		out, err := svc.Authorize(ctx, AuthorizeInput{
			DeviceKind: "agentred", Fingerprint: "fp-aaaaaaaa", Platform: "linux/amd64", Version: "0.5.0",
			Name: "coding",
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
		// 设备流的显示名：客户端自报优先，缺省回退到指纹缩写。回退**必须**剥掉
		// sha256: 前缀 —— 直接截前 8 个字符得到的是 "sha256:" 加一个十六进制字符，
		// 整个账号下的机器最多只有 16 种名字。
		exchangeNamed := func(t *testing.T, reported string) string {
			ctx, mD, mT, mF, svc, mock := setupDeviceTest(t)
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
				&device_flow_entity.DeviceFlowCode{
					DeviceCode: "dc-x", IntervalSeconds: 5,
					ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
					AuthorizedUserID: 42, ApprovedAt: time.Now().UnixMilli(),
					DeviceKind:        "agentred",
					ClientFingerprint: "sha256:475776c61078781c9fda7b3345d232e32d5f176a7220ce2d129c5e39ac2db3de",
					ClientName:        reported,
				}, nil,
			)
			mF.EXPECT().UpdateLastPolled(gomock.Any(), "dc-x", gomock.Any()).Return(nil)
			var name string
			mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, d *device_entity.Device) error {
					name = d.Name
					d.ID = 7
					return nil
				},
			)
			mT.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
			mF.EXPECT().MarkConsumed(gomock.Any(), "dc-x", gomock.Any()).Return(int64(1), nil)
			mock.ExpectBegin()
			mock.ExpectCommit()

			_, err := svc.ExchangeToken(ctx, "dc-x")
			assert.NoError(t, err)
			return name
		}
		convey.Convey("设备名取客户端自报的主机名", func() {
			assert.Equal(t, "coding", exchangeNamed(t, "coding"))
		})
		convey.Convey("客户端没自报名字时回退到指纹缩写", func() {
			assert.Equal(t, "475776c6", exchangeNamed(t, ""))
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
			hubtest.Redis(t)
			ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
			mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return([]string{"jti-aaa", "jti-bbb"}, nil)
			mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			expectRevokedDeviceLookup(mD)

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
			hubtest.Redis(t)
			ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
			mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return([]string{"jti-aaa"}, nil)
			mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			expectRevokedDeviceLookup(mD)

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
			hubtest.Redis(t)
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
			// 两次：Revoke 自己要拿这台设备的账号与指纹，Refresh 之后还要再查一次。
			mD.EXPECT().Find(gomock.Any(), int64(42)).Return(dev, nil).Times(2)
			convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)

			// refresh token 本身既没被重放也没过期，唯一变的是设备已被解除授权。
			mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
				&device_token_entity.DeviceToken{
					ID: 1, DeviceID: 42,
					RefreshExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
				}, nil,
			)

			_, err := svc.Refresh(ctx, "still-unexpired")
			convey.So(err, convey.ShouldNotBeNil)
			convey.So(err.Error(), convey.ShouldContainSubstring, "invalid_grant")
			convey.So(err.Error(), convey.ShouldContainSubstring, "device revoked")
		})
	})
}

// expectRevokedDeviceLookup 备好 Revoke 解析「这台设备属于哪个账号、指纹是什么」的
// 那一次读——账号级同步对象按（账号, 指纹）圈定，deviceID 本身回答不了这个问题。
func expectRevokedDeviceLookup(mD *mock_device_repo.MockDeviceRepo) {
	mD.EXPECT().Find(gomock.Any(), int64(42)).Return(&device_entity.Device{
		ID: 42, UserID: 7, Fingerprint: "sha256:aaaa", Kind: device_entity.KindAgentred,
	}, nil)
}

// purgeCall 是 stubDeviceDataPurger 记下的一次调用。
type purgeCall struct {
	userID      int64
	deviceID    int64
	fingerprint string
}

// stubDeviceDataPurger 记下每一次清理；err 非 nil 时模拟落库失败。
type stubDeviceDataPurger struct {
	localPaths  []purgeCall
	syncObjects []purgeCall
	deleteTodos []purgeCall
	err         error
}

func (s *stubDeviceDataPurger) PurgeDeviceLocalPaths(_ context.Context, deviceID int64) error {
	s.localPaths = append(s.localPaths, purgeCall{deviceID: deviceID})
	return s.err
}

func (s *stubDeviceDataPurger) PurgeDeviceSyncObjects(_ context.Context, userID int64, fingerprint string) error {
	s.syncObjects = append(s.syncObjects, purgeCall{userID: userID, fingerprint: fingerprint})
	return s.err
}

func (s *stubDeviceDataPurger) PurgeDeviceDeleteTodos(_ context.Context, userID int64, fingerprint string) error {
	s.deleteTodos = append(s.deleteTodos, purgeCall{userID: userID, fingerprint: fingerprint})
	return s.err
}

// TestRevoke_ClearsImpossibleSessionDeleteTodos 会话镜像决策 7：删除一条对话时那台
// 机器要是离线，server 那份当场清掉、给机器留一条待办；设备一旦被撤销，那条指令
// 永远执行不了——它随撤销一并消失。账号里那些对话本身不受影响：留着、读得到、只读。
func TestRevoke_ClearsImpossibleSessionDeleteTodos(t *testing.T) {
	convey.Convey("撤销设备时清掉挂在它上面、永远执行不了的删除待办（决策 7）", t, func() {
		hubtest.Redis(t)
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return(nil, nil)
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		expectRevokedDeviceLookup(mD)

		purger := &stubDeviceDataPurger{}
		SetDeviceDataPurger(purger)
		t.Cleanup(func() { SetDeviceDataPurger(nil) })

		convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
		// 待办按（账号, 那台机器的指纹）圈定，与账号级同步对象同一维度。
		convey.So(purger.deleteTodos, convey.ShouldResemble,
			[]purgeCall{{userID: 7, fingerprint: "sha256:aaaa"}})
	})

	convey.Convey("清待办失败不回滚已经生效的撤销（fail-open，只记日志）", t, func() {
		hubtest.Redis(t)
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return(nil, nil)
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		expectRevokedDeviceLookup(mD)

		purger := &stubDeviceDataPurger{err: errors.New("boom")}
		SetDeviceDataPurger(purger)
		t.Cleanup(func() { SetDeviceDataPurger(nil) })

		convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
		convey.So(purger.deleteTodos, convey.ShouldResemble,
			[]purgeCall{{userID: 7, fingerprint: "sha256:aaaa"}})
	})

	// 设备行查不到就没有账号与指纹可用——待办按（账号, 指纹）圈定，与账号级同步
	// 对象同一处境：跳过，绝不能拿空指纹去删。
	convey.Convey("设备行查不到时跳过待办清理，撤销照常成功", t, func() {
		hubtest.Redis(t)
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return(nil, nil)
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(nil, nil)

		purger := &stubDeviceDataPurger{}
		SetDeviceDataPurger(purger)
		t.Cleanup(func() { SetDeviceDataPurger(nil) })

		convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
		convey.So(purger.deleteTodos, convey.ShouldBeEmpty)
	})
}

// TestRevoke_PurgesReportedLocalPaths 工作区多端同步 R18：用户在 web 端删除
// （撤销）一台设备时，该设备上报的本机路径清单一并消失。
func TestRevoke_PurgesReportedLocalPaths(t *testing.T) {
	convey.Convey("撤销设备时清掉它上报的本机路径清单（R18）", t, func() {
		hubtest.Redis(t)
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return(nil, nil)
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		expectRevokedDeviceLookup(mD)

		purger := &stubDeviceDataPurger{}
		SetDeviceDataPurger(purger)
		t.Cleanup(func() { SetDeviceDataPurger(nil) })

		convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
		convey.So(purger.localPaths, convey.ShouldResemble, []purgeCall{{deviceID: 42}})
	})

	convey.Convey("purger 落库失败不回滚已经生效的撤销（fail-open，只记日志）", t, func() {
		hubtest.Redis(t)
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return(nil, nil)
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		expectRevokedDeviceLookup(mD)

		purger := &stubDeviceDataPurger{err: errors.New("boom")}
		SetDeviceDataPurger(purger)
		t.Cleanup(func() { SetDeviceDataPurger(nil) })

		convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
		convey.So(purger.localPaths, convey.ShouldResemble, []purgeCall{{deviceID: 42}})
		// 两件清理互不牵连：本机路径清单失败之后，账号级那半照样要发生。
		convey.So(purger.syncObjects, convey.ShouldResemble,
			[]purgeCall{{userID: 7, fingerprint: "sha256:aaaa"}})
	})
}

// TestRevoke_TombstonesDeviceScopedSyncObjects 一台设备离开账号时，账号级同步数据里
// 只属于它的那两类行跟着消失（指向它的 backend、它上面的项目路径）。控制台「解除
// 授权」与机器上 `agentred logout` 走的是同一条服务端路径，因此这一条同时覆盖两者。
func TestRevoke_TombstonesDeviceScopedSyncObjects(t *testing.T) {
	convey.Convey("撤销设备时把只属于它的账号级同步对象落墓碑", t, func() {
		hubtest.Redis(t)
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return(nil, nil)
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		expectRevokedDeviceLookup(mD)

		purger := &stubDeviceDataPurger{}
		SetDeviceDataPurger(purger)
		t.Cleanup(func() { SetDeviceDataPurger(nil) })

		convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
		convey.So(purger.syncObjects, convey.ShouldResemble,
			[]purgeCall{{userID: 7, fingerprint: "sha256:aaaa"}})
	})

	// 设备行查不到就没有账号与指纹可用——按（账号, 指纹）圈定的清理无从下手。
	// 撤销本身已经生效，这里只能跳过并记日志，绝不能拿一个空指纹去清（那会命中
	// 账号下每一个「本机」backend）。
	convey.Convey("设备行查不到时跳过账号级清理，撤销照常成功", t, func() {
		hubtest.Redis(t)
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return(nil, nil)
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(nil, nil)

		purger := &stubDeviceDataPurger{}
		SetDeviceDataPurger(purger)
		t.Cleanup(func() { SetDeviceDataPurger(nil) })

		convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
		convey.So(purger.syncObjects, convey.ShouldBeEmpty)
		// 上报组按 device_id 归属，不需要指纹，因此它照清不误。
		convey.So(purger.localPaths, convey.ShouldResemble, []purgeCall{{deviceID: 42}})
	})
}

// TestRevoke_GivenNoPurgerConfigured_DoesNotPanic 复现「只装配了 device flow、
// 没有整套 bootstrap」的调用方：从未 SetDeviceDataPurger 过，Revoke 仍要正常成功，
// 而不是对 nil 接口调用方法 panic（与 relay_svc.Default() 的既有安全占位同一模式）。
func TestRevoke_GivenNoPurgerConfigured_DoesNotPanic(t *testing.T) {
	convey.Convey("未装配 purger 时 Revoke 不 panic（默认空操作）", t, func() {
		hubtest.Redis(t)
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().ListAccessJTIByDevice(gomock.Any(), int64(42)).Return(nil, nil)
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		expectRevokedDeviceLookup(mD)

		convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
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
			nil, nil, redisClient, relay_svc.NewUnavailableForwarder(),
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

// Given 镜像握手记下了「这台机器上一次握手被协议拒绝」的共享状态(mirror_svc 决策 14 /
// spec「控制台呈现与 latest 来源」一节最后一段);When 列出设备;
// Then 那台机器的这一行透出这件事,没被记录的机器不受影响 —— 这是设备读端点让协议
// 不匹配「读得到」的地方,渲染留给后续任务。
func TestListUserDevices_ReportsProtocolMismatch(t *testing.T) {
	convey.Convey("ListUserDevices 透出镜像记下的协议不匹配状态", t, func() {
		ctx, mD, _, _, svc, _ := setupDeviceTest(t)
		userID := int64(7)

		mini := miniredis.RunT(t)
		redisClient := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
		t.Cleanup(func() { require.NoError(t, redisClient.Close()) })
		sup := mirror_svc.NewSupervisor(mirror_svc.Config{InstanceID: "server-a"}, nil, nil, redisClient)
		mirror_svc.SetDefault(sup)
		t.Cleanup(func() { mirror_svc.SetDefault(nil) })
		sup.RecordProtocolMismatch(ctx, userID, "fp-a")

		mD.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{
			{ID: 42, UserID: 7, Kind: "agentred", Fingerprint: "fp-a", Status: 1},
			{ID: 43, UserID: 7, Kind: "agentred", Fingerprint: "fp-b", Status: 1},
		}, nil)

		items, err := svc.ListUserDevices(ctx, userID, 0)

		convey.So(err, convey.ShouldBeNil)
		convey.So(items[0].ProtocolMismatch, convey.ShouldBeTrue)
		convey.So(items[1].ProtocolMismatch, convey.ShouldBeFalse)
	})
}

// Given 镜像握手记下了这台机器自报的短 commit(spec「协议：版本窗口与自报版本」：
// 「短 commit 为空 = 非发布构建」，决策 5 据此判定「显示为开发构建，永不劝升」);
// When 列出设备;Then 那一行既带出 commit 本身，也带出「server 到底知不知道这台机器
// 的构建」—— 两者必须分开：没记录过的机器不能被当成「commit 为空」，那会把一台正式版
// 机器说成开发构建。
func TestListUserDevices_ReportsTheDaemonBuildTheHandshakeRecorded(t *testing.T) {
	convey.Convey("ListUserDevices 透出镜像握手记下的短 commit 与「知不知道」", t, func() {
		ctx, mD, _, _, svc, _ := setupDeviceTest(t)
		userID := int64(7)

		mini := miniredis.RunT(t)
		redisClient := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
		t.Cleanup(func() { require.NoError(t, redisClient.Close()) })
		sup := mirror_svc.NewSupervisor(mirror_svc.Config{InstanceID: "server-a"}, nil, nil, redisClient)
		mirror_svc.SetDefault(sup)
		t.Cleanup(func() { mirror_svc.SetDefault(nil) })
		sup.RecordDaemonBuild(ctx, userID, "fp-a", "a1b2c3d")
		// 本地构建：握过手、报的 commit 就是空串。它与「没握过手」在库里长得一样,
		// 只有 known 分得开。
		sup.RecordDaemonBuild(ctx, userID, "fp-b", "")

		mD.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{
			{ID: 42, UserID: 7, Kind: "agentred", Fingerprint: "fp-a", Status: 1},
			{ID: 43, UserID: 7, Kind: "agentred", Fingerprint: "fp-b", Status: 1},
			{ID: 44, UserID: 7, Kind: "agentred", Fingerprint: "fp-c", Status: 1},
		}, nil)

		items, err := svc.ListUserDevices(ctx, userID, 0)

		convey.So(err, convey.ShouldBeNil)
		convey.So(items[0].DaemonCommit, convey.ShouldEqual, "a1b2c3d")
		convey.So(items[0].DaemonBuildKnown, convey.ShouldBeTrue)
		convey.So(items[1].DaemonCommit, convey.ShouldEqual, "")
		convey.So(items[1].DaemonBuildKnown, convey.ShouldBeTrue)
		// 从没握过手的那台：不知道就是不知道,不能借「commit 为空」冒充开发构建。
		convey.So(items[2].DaemonBuildKnown, convey.ShouldBeFalse)
	})
}

// Given 没有装配镜像(mirror_svc.Default() 为 nil,例如只跑 device flow 的测试/调用方);
// When 列出设备;Then 不 panic,协议不匹配一律 fail-open 为 false —— 与在线态同一习惯。
func TestListUserDevices_MirrorNotConfigured(t *testing.T) {
	convey.Convey("mirror_svc 未装配时 ListUserDevices 不 panic，协议不匹配 fail-open 为 false", t, func() {
		ctx, mD, _, _, svc, _ := setupDeviceTest(t)
		mirror_svc.SetDefault(nil)
		t.Cleanup(func() { mirror_svc.SetDefault(nil) })

		mD.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*device_entity.Device{
			{ID: 42, UserID: 7, Kind: "agentred", Fingerprint: "fp-a", Status: 1},
		}, nil)

		items, err := svc.ListUserDevices(ctx, 7, 0)

		convey.So(err, convey.ShouldBeNil)
		convey.So(items[0].ProtocolMismatch, convey.ShouldBeFalse)
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

// 吊销列表的窗口起点必须正好是 now-(AccessTTL+Leeway)，不是 now-AccessTTL：
// Verify 接受 Leeway 的时钟偏移，token 直到 exp+Leeway 都还验得过。少减这一段，
// 每个 jti 都会有 Leeway 秒既已掉出这份列表、又仍被任何拉取方接受。
//
// 这是个精确到毫秒的边界，只有把时钟做成可注入的才断言得了——用真实 time.Now()
// 只能断言一个区间，而区间恰好盖得住上面那个错法。
func TestListRevokedJTI_WindowStartsOneLeewayBeforeAccessTTL(t *testing.T) {
	ctx, _, mT, _, svc, _ := setupDeviceTest(t)
	const frozen int64 = 1_700_000_000_000
	svc.now = func() int64 { return frozen }

	want := frozen - (time.Hour + jwt.Leeway).Milliseconds() // cfg.AccessTTL 是 1h
	mT.EXPECT().ListRevokedJTIByUser(gomock.Any(), int64(7), want).Return([]string{"jti-1"}, nil)

	got, err := svc.ListRevokedJTI(ctx, 7)

	require.NoError(t, err)
	assert.Equal(t, []string{"jti-1"}, got)
}

// TestExchangeToken_GivenADevice_ThenTheAccessTokenCarriesTheDeviceFingerprint
// 决策 8：agentred 的 auth.account 从**已验签的凭据**取对端身份，不再看请求体。
// 桌面端与 agentred 出示的正是这枚设备 JWT，所以它必须把该设备的 fingerprint 签进
// pfp —— 少了它，这条路上的账号握手会被对端以 ErrUnauthorized 全数拒绝。
func TestExchangeToken_GivenADevice_ThenTheAccessTokenCarriesTheDeviceFingerprint(t *testing.T) {
	const fingerprint = "sha256:475776c61078781c9fda7b3345d232e32d5f176a7220ce2d129c5e39ac2db3de"
	ctx, mD, mT, mF, svc, mock := setupDeviceTest(t)
	mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
		&device_flow_entity.DeviceFlowCode{
			DeviceCode: "dc-x", IntervalSeconds: 5,
			ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
			AuthorizedUserID: 42, ApprovedAt: time.Now().UnixMilli(),
			DeviceKind: "agentred", ClientFingerprint: fingerprint,
		}, nil,
	)
	mF.EXPECT().UpdateLastPolled(gomock.Any(), "dc-x", gomock.Any()).Return(nil)
	mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, d *device_entity.Device) error { d.ID = 7; return nil },
	)
	mT.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
	mF.EXPECT().MarkConsumed(gomock.Any(), "dc-x", gomock.Any()).Return(int64(1), nil)
	mock.ExpectBegin()
	mock.ExpectCommit()

	out, err := svc.ExchangeToken(ctx, "dc-x")

	require.NoError(t, err)
	claims, err := svc.signer.Verify(out.AccessToken)
	require.NoError(t, err)
	assert.Equal(t, fingerprint, claims.PFP)
}
