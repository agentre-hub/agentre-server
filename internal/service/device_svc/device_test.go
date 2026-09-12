package device_svc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/go-sql-driver/mysql"
	goredis "github.com/redis/go-redis/v9"
	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_flow_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_token_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_flow_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_flow_repo/mock_device_flow_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo/mock_device_token_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
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

	cfg := Config{
		FlowTTL: 10 * time.Minute, PollInterval: 5 * time.Second,
		AccessTTL: time.Hour, RefreshTTL: 90 * 24 * time.Hour,
		VerificationURI: "https://server/device",
	}
	ctx, _, mock := hubtest.Database(t)
	return ctx, mD, mT, mF, newDeviceSvc(cfg), mock
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

// user_code 生成器的码空间不大（32^6），且 pending_flag 部分唯一索引只能拦住
// "还没结算" 的行，撞码不算罕见到可以直接 500 给用户。Authorize 撞见
// uk_dfc_user_code_pending 的 1062 时必须原地重新生成再试，而不是把一次纯粹的
// 随机数运气上抛成失败请求。
func TestAuthorize_UserCodeCollision(t *testing.T) {
	pendingDup := &mysql.MySQLError{
		Number:  1062,
		Message: "Duplicate entry 'ABC-DEF' for key 'device_flow_codes.uk_dfc_user_code_pending'",
	}

	convey.Convey("Authorize 撞 user_code", t, func() {
		convey.Convey("与待授权码冲突一次后重试成功，返回第二次生成的新码", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			var seen []string
			gomock.InOrder(
				mF.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
					func(_ context.Context, c *device_flow_entity.DeviceFlowCode) error {
						seen = append(seen, c.UserCode)
						return pendingDup
					},
				),
				mF.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
					func(_ context.Context, c *device_flow_entity.DeviceFlowCode) error {
						seen = append(seen, c.UserCode)
						return nil
					},
				),
			)

			out, err := svc.Authorize(ctx, AuthorizeInput{DeviceKind: "agentred", Fingerprint: "fp-aaaaaaaa"})

			assert.NoError(t, err)
			assert.Len(t, seen, 2)
			assert.Equal(t, seen[1], out.UserCode)
		})

		convey.Convey("连续 5 次撞码后返回错误，不再重试", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().Create(gomock.Any(), gomock.Any()).Return(pendingDup).Times(5)

			out, err := svc.Authorize(ctx, AuthorizeInput{DeviceKind: "agentred", Fingerprint: "fp-aaaaaaaa"})

			assert.Nil(t, out)
			assert.Error(t, err)
		})

		convey.Convey("其他唯一键（device_code）冲突不重试，直接上抛", func() {
			ctx, _, _, mF, svc, _ := setupDeviceTest(t)
			identityDup := &mysql.MySQLError{
				Number:  1062,
				Message: "Duplicate entry 'dc-x' for key 'device_flow_codes.uk_device_flow_codes_identity'",
			}
			mF.EXPECT().Create(gomock.Any(), gomock.Any()).Return(identityDup).Times(1)

			out, err := svc.Authorize(ctx, AuthorizeInput{DeviceKind: "agentred", Fingerprint: "fp-aaaaaaaa"})

			assert.Nil(t, out)
			assert.ErrorIs(t, err, identityDup)
		})
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
			mF.EXPECT().UpdateLastPolledIfDue(gomock.Any(), "dc-x", gomock.Any(), gomock.Any()).Return(int64(1), nil)
			_, err := svc.ExchangeToken(ctx, "dc-x")
			assert.Contains(t, err.Error(), "authorization_pending")
		})
		// 限速判定曾经是「先读 last_polled_at 判间隔、再无条件 UPDATE」的 check-then-act：
		// 两个并发或重复的轮询都能读到「还没到点」为假、都往下走。条件 UPDATE 把
		// 判定收进数据库自己的一条语句，0 行受影响就是这次没抢到，必须 slow_down，
		// 且不能再往下判 IsAuthorized（没有轮到它决定）。
		convey.Convey("并发/重复轮询在限速间隔内只有一个通过，另一个 slow_down", func() {
			ctx, mD, mT, mF, svc, _ := setupDeviceTest(t)
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
				&device_flow_entity.DeviceFlowCode{
					DeviceCode: "dc-x", IntervalSeconds: 5,
					ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
					AuthorizedUserID: 42, ApprovedAt: time.Now().UnixMilli(),
				}, nil,
			)
			mF.EXPECT().UpdateLastPolledIfDue(gomock.Any(), "dc-x", gomock.Any(), int64(5000)).Return(int64(0), nil)
			mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).Times(0)
			mT.EXPECT().Create(gomock.Any(), gomock.Any()).Times(0)
			mF.EXPECT().MarkConsumed(gomock.Any(), gomock.Any(), gomock.Any()).Times(0)

			_, err := svc.ExchangeToken(ctx, "dc-x")
			assert.Contains(t, err.Error(), ErrSlowDown)
		})
		convey.Convey("已授权 → 颁发 token + 标 consumed + upsert device", func() {
			ctx, mD, mT, mF, svc, mock := setupDeviceTest(t)
			var capturedHash string
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
				&device_flow_entity.DeviceFlowCode{
					DeviceCode: "dc-x", IntervalSeconds: 5,
					ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
					AuthorizedUserID: 42, ApprovedAt: time.Now().UnixMilli(),
					DeviceKind: "agentred", ClientFingerprint: "fp-xxxxxxx",
				}, nil,
			)
			mF.EXPECT().UpdateLastPolledIfDue(gomock.Any(), "dc-x", gomock.Any(), gomock.Any()).Return(int64(1), nil)
			mD.EXPECT().FindByFingerprint(gomock.Any(), int64(42), "fp-xxxxxxx").Return(nil, nil)
			mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, d *device_entity.Device) error {
					assert.Equal(t, "agentred", d.Kind)
					d.ID = 7
					return nil
				},
			)
			mT.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, tok *device_token_entity.DeviceToken) error {
					capturedHash = tok.AccessTokenHash
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
			assert.Equal(t, sha256Hex(out.AccessToken), capturedHash)
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
			mF.EXPECT().UpdateLastPolledIfDue(gomock.Any(), "dc-x", gomock.Any(), gomock.Any()).Return(int64(1), nil)
			var name string
			mD.EXPECT().FindByFingerprint(gomock.Any(), int64(42), gomock.Any()).Return(nil, nil)
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
			mF.EXPECT().UpdateLastPolledIfDue(gomock.Any(), "dc-x", gomock.Any(), gomock.Any()).Return(int64(1), nil)
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

// 撤销后原机重新配对：ON DUPLICATE KEY 把同一行设备改回 active。撤销前签发的令牌行若还留着，
// 旧 access token 会随设备复活重新解析出身份，旧 refresh token 会被当成重放把新链一起撤掉——
// 所以重新激活一台已撤销的设备时，先删掉它名下撤销前的令牌行。
func TestExchangeToken_ReactivatingARevokedDevice_DropsItsPreRevocationTokens(t *testing.T) {
	authorizedFlow := func() *device_flow_entity.DeviceFlowCode {
		return &device_flow_entity.DeviceFlowCode{
			DeviceCode: "dc-x", IntervalSeconds: 5,
			ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
			AuthorizedUserID: 42, ApprovedAt: time.Now().UnixMilli(),
			DeviceKind: "agentred", ClientFingerprint: "fp-xxxxxxx",
		}
	}
	exchange := func(t *testing.T, previous *device_entity.Device, deletes int) {
		ctx, mD, mT, mF, svc, mock := setupDeviceTest(t)
		mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(authorizedFlow(), nil)
		mF.EXPECT().UpdateLastPolledIfDue(gomock.Any(), "dc-x", gomock.Any(), gomock.Any()).Return(int64(1), nil)
		mF.EXPECT().MarkConsumed(gomock.Any(), "dc-x", gomock.Any()).Return(int64(1), nil)
		find := mD.EXPECT().FindByFingerprint(gomock.Any(), int64(42), "fp-xxxxxxx").Return(previous, nil)
		deleted := mT.EXPECT().DeleteByDevice(gomock.Any(), int64(7)).Return(nil).Times(deletes)
		upsert := mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, d *device_entity.Device) error { d.ID = 7; return nil })
		gomock.InOrder(find, deleted, upsert)
		mT.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
		mock.ExpectBegin()
		mock.ExpectCommit()

		out, err := svc.ExchangeToken(ctx, "dc-x")
		require.NoError(t, err)
		assert.Equal(t, int64(7), out.DeviceID)
	}

	convey.Convey("ExchangeToken for a fingerprint", t, func() {
		convey.Convey("whose device row was revoked: its token rows are deleted before the device is reactivated", func() {
			exchange(t, &device_entity.Device{ID: 7, UserID: 42, Fingerprint: "fp-xxxxxxx", Status: consts.DELETE}, 1)
		})
		convey.Convey("whose device is still active: its token rows are kept", func() {
			exchange(t, &device_entity.Device{ID: 7, UserID: 42, Fingerprint: "fp-xxxxxxx", Status: consts.ACTIVE}, 0)
		})
		convey.Convey("seen for the first time: nothing to delete", func() {
			exchange(t, nil, 0)
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
		convey.Convey("token 已 revoked、设备仍 active → 重放 → RevokeChain", func() {
			ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
			mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
				&device_token_entity.DeviceToken{ID: 1, DeviceID: 42, RevokedAt: 5000}, nil,
			)
			mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
				&device_entity.Device{ID: 42, UserID: 7, Kind: "agentred", Status: consts.ACTIVE}, nil,
			)
			mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			_, err := svc.Refresh(ctx, "stolen")
			assert.Contains(t, err.Error(), "invalid_grant")
		})
		convey.Convey("正常轮换 → 新 refresh + 旧 revoke + touch device", func() {
			ctx, mD, mT, _, svc, mock := setupDeviceTest(t)
			var capturedHash string
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
					capturedHash = tok.AccessTokenHash
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
			assert.Equal(t, sha256Hex(out.AccessToken), capturedHash)
		})
	})
}

// S1：access token 是不含任何可解析内容的随机串，server 只存它的摘要。
// 反例是一枚 JWT —— 三段、带签名、载荷可解码；以及把明文原样写进库。
func TestExchangeToken_IssuesOpaqueAccessTokenStoredOnlyAsDigest(t *testing.T) {
	ctx, mD, mT, mF, svc, mock := setupDeviceTest(t)
	mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
		&device_flow_entity.DeviceFlowCode{
			DeviceCode: "dc-x", IntervalSeconds: 5,
			ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
			AuthorizedUserID: 7, ApprovedAt: time.Now().UnixMilli(),
			DeviceKind: device_entity.KindAgentred, ClientFingerprint: "sha256:aaaa",
		}, nil,
	)
	mF.EXPECT().UpdateLastPolledIfDue(gomock.Any(), "dc-x", gomock.Any(), gomock.Any()).Return(int64(1), nil)
	mF.EXPECT().MarkConsumed(gomock.Any(), "dc-x", gomock.Any()).Return(int64(1), nil)
	mD.EXPECT().FindByFingerprint(gomock.Any(), gomock.Any(), gomock.Any()).Return(nil, nil)
	mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, d *device_entity.Device) error { d.ID = 42; return nil })
	var stored *device_token_entity.DeviceToken
	mT.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, tok *device_token_entity.DeviceToken) error { stored = tok; return nil })
	mock.ExpectBegin()
	mock.ExpectCommit()

	out, err := svc.ExchangeToken(ctx, "dc-x")
	require.NoError(t, err)
	require.NotNil(t, stored)

	assert.NotContains(t, out.AccessToken, ".", "access token 不能是 JWT 那种可解析的分段结构")
	assert.GreaterOrEqual(t, len(out.AccessToken), 32, "随机串要有足够熵")
	assert.Equal(t, sha256Hex(out.AccessToken), stored.AccessTokenHash, "库里只存摘要")
	assert.NotEqual(t, out.AccessToken, stored.AccessTokenHash, "明文不能落库")
	assert.Equal(t, int(svc.cfg.AccessTTL/time.Second), out.ExpiresIn, "有效期与今天一致")
}

func TestRevoke(t *testing.T) {
	convey.Convey("Revoke", t, func() {
		// S4：撤销立即生效——该设备名下的 access token（含刷新轮换出的旧令牌）当场解析
		// 不出身份。判据是库里的设备状态，撤销既不写、也不读 Redis。
		convey.Convey("撤销后该设备名下的 access token 立即失效，且不经 Redis", func() {
			mini := hubtest.Redis(t)
			ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
			dev := &device_entity.Device{
				ID: 42, UserID: 7, Kind: device_entity.KindAgentred, Fingerprint: "sha256:aaaa", Status: consts.ACTIVE,
			}
			mD.EXPECT().Find(gomock.Any(), int64(42)).DoAndReturn(
				func(context.Context, int64) (*device_entity.Device, error) { snapshot := *dev; return &snapshot, nil },
			).AnyTimes()
			nowMs := time.Now().UnixMilli()
			current := &device_token_entity.DeviceToken{ID: 2, DeviceID: 42, Createtime: nowMs}
			rotated := &device_token_entity.DeviceToken{ID: 1, DeviceID: 42, Createtime: nowMs - 1000, RevokedAt: nowMs}
			mT.EXPECT().FindByAccessHash(gomock.Any(), sha256Hex("current")).Return(current, nil).Times(2)
			mT.EXPECT().FindByAccessHash(gomock.Any(), sha256Hex("rotated")).Return(rotated, nil).Times(2)
			mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
			mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).DoAndReturn(
				func(context.Context, int64, int64) error { dev.Status = consts.DELETE; return nil },
			)

			for _, token := range []string{"current", "rotated"} {
				_, err := svc.ResolveBearer(ctx, token)
				convey.So(err, convey.ShouldBeNil)
			}
			convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
			for _, token := range []string{"current", "rotated"} {
				_, err := svc.ResolveBearer(ctx, token)
				convey.So(errors.Is(err, ErrBearerInvalid), convey.ShouldBeTrue)
			}
			convey.So(mini.Keys(), convey.ShouldBeEmpty)
		})

		// R19「解除授权」的可观察后果：撤销后该设备无法再刷新。黑名单只覆盖已签发
		// access token 的 AccessTTL 窗口，真正让设备回不来的是 devices 行被置为
		// 已撤销后 Refresh 的这道判定 —— 少了它，撤销一台设备只是让它等 15 分钟。
		convey.Convey("撤销后该设备手上未过期的 refresh token 也换不到新凭据", func() {
			hubtest.Redis(t)
			ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
			dev := &device_entity.Device{ID: 42, UserID: 7, Kind: device_entity.KindAgentred, Status: consts.ACTIVE}

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
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		mD.EXPECT().Revoke(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		expectRevokedDeviceLookup(mD)

		convey.So(svc.Revoke(ctx, 42), convey.ShouldBeNil)
	})
}

func TestRefresh_LostRace(t *testing.T) {
	convey.Convey("Refresh", t, func() {
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

// stubForwarder 站在 relay_svc.Forwarder 的位置：本用例只关心 Redis 里的在线态
// 登记，帧总线一次也不会被走到。
type stubForwarder struct{}

func (stubForwarder) Check(context.Context, relay_svc.Route) error { return nil }

func (stubForwarder) Forward(
	context.Context, relay_svc.Route, relay_svc.Peer, string, int, []byte,
) error {
	return nil
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
			nil, nil, redisClient, stubForwarder{},
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

// redisTrips 数一条 Redis 客户端上发出去的往返：单发一条命令算一次 command，一整个
// pipeline 算一次 pipeline。
type redisTrips struct {
	mu        sync.Mutex
	commands  int
	pipelines int
}

func (h *redisTrips) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (h *redisTrips) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		h.mu.Lock()
		h.commands++
		h.mu.Unlock()
		return next(ctx, cmd)
	}
}

func (h *redisTrips) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		h.mu.Lock()
		h.pipelines++
		h.mu.Unlock()
		return next(ctx, cmds)
	}
}

func (h *redisTrips) reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.commands, h.pipelines = 0, 0
}

func (h *redisTrips) counts() (commands, pipelines int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.commands, h.pipelines
}

// presenceWorld 按 bootstrap 的形状装配设备在线态的两个来源：真实的 relay_svc 与
// mirror_svc.Supervisor 共用同一个 Redis 客户端（生产上都是 redis.Default()），
// 客户端上挂着往返计数。RESP2 且不发 CLIENT SETINFO，连接建立时不夹带握手命令。
func presenceWorld(t *testing.T) (*miniredis.Miniredis, relay_svc.RelaySvc, *mirror_svc.Supervisor, *redisTrips) {
	t.Helper()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr(), Protocol: 2, DisableIdentity: true})
	t.Cleanup(func() { _ = client.Close() })
	trips := &redisTrips{}
	client.AddHook(trips)

	relay := relay_svc.New(
		relay_svc.Config{InstanceID: "server-a", OnlineTTL: time.Minute},
		nil, nil, client, stubForwarder{},
	)
	relay_svc.SetDefault(relay)
	t.Cleanup(func() { relay_svc.SetDefault(nil) })
	sup := mirror_svc.NewSupervisor(mirror_svc.Config{InstanceID: "server-a"}, nil, nil, client)
	mirror_svc.SetDefault(sup)
	t.Cleanup(func() { mirror_svc.SetDefault(nil) })
	return mini, relay, sup, trips
}

// Given 账号下 5 台机器，在线登记、协议不匹配、握手自报的 commit 各有几台有记录；
// When 列出设备；
// Then 每一行的在线态 / 协议不匹配 / 构建与逐台读取时相同，而 Redis 上没有一条单发命令：
// 中继在线态、镜像握手状态各一次 pipeline 读完，往返次数与设备台数无关（要求 10）。
func TestListUserDevices_GivenManyDevices_ThenPresenceIsReadInBatchesNotPerDevice(t *testing.T) {
	ctx, mD, _, _, svc, _ := setupDeviceTest(t)
	userID := int64(7)
	_, relay, sup, trips := presenceWorld(t)

	for _, fp := range []string{"fp-b", "fp-d"} {
		require.NoError(t, relay.RegisterDaemon(ctx, relay_svc.Route{AccountID: userID, Fingerprint: fp, InstanceID: "server-a"}))
	}
	sup.RecordProtocolMismatch(ctx, userID, "fp-a")
	sup.RecordDaemonBuild(ctx, userID, "fp-a", "a1b2c3d")
	sup.RecordDaemonBuild(ctx, userID, "fp-d", "")
	mD.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{
		{ID: 41, UserID: 7, Name: "a", Kind: "agentred", Fingerprint: "fp-a", Status: 1},
		{ID: 42, UserID: 7, Name: "b", Kind: "agentred", Fingerprint: "fp-b", Status: 1},
		{ID: 43, UserID: 7, Name: "c", Kind: "desktop", Fingerprint: "fp-c", Status: 1},
		{ID: 44, UserID: 7, Name: "d", Kind: "agentred", Fingerprint: "fp-d", Status: 1},
		{ID: 45, UserID: 7, Name: "e", Kind: "agentred", Fingerprint: "fp-e", Status: 1},
	}, nil)
	trips.reset()

	items, err := svc.ListUserDevices(ctx, userID, 43)

	require.NoError(t, err)
	commands, pipelines := trips.counts()
	assert.Zero(t, commands, "no per-device Redis command")
	assert.Equal(t, 2, pipelines, "one pipeline for relay presence, one for mirror handshake state")
	assert.Equal(t, []DeviceView{
		{ID: 41, Name: "a", Kind: "agentred", Fingerprint: "fp-a", Status: 1,
			ProtocolMismatch: true, DaemonCommit: "a1b2c3d", DaemonBuildKnown: true},
		{ID: 42, Name: "b", Kind: "agentred", Fingerprint: "fp-b", Status: 1, Online: true},
		{ID: 43, Name: "c", Kind: "desktop", Fingerprint: "fp-c", Status: 1, IsThisDevice: true},
		{ID: 44, Name: "d", Kind: "agentred", Fingerprint: "fp-d", Status: 1, Online: true, DaemonBuildKnown: true},
		{ID: 45, Name: "e", Kind: "agentred", Fingerprint: "fp-e", Status: 1},
	}, items)
}

// Given Redis 整个读不出来；When 列出设备；Then 列表照常返回，每台机器离线、无协议不匹配、
// 构建未知——在线态是增强列，读不到按 fail-open 处理，不拖垮整个列表。
func TestListUserDevices_GivenRedisFailing_ThenEveryDeviceFailsOpenAndTheListReturns(t *testing.T) {
	ctx, mD, _, _, svc, _ := setupDeviceTest(t)
	userID := int64(7)
	mini, relay, sup, _ := presenceWorld(t)

	require.NoError(t, relay.RegisterDaemon(ctx, relay_svc.Route{AccountID: userID, Fingerprint: "fp-a", InstanceID: "server-a"}))
	sup.RecordProtocolMismatch(ctx, userID, "fp-a")
	sup.RecordDaemonBuild(ctx, userID, "fp-a", "a1b2c3d")
	mD.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{
		{ID: 41, UserID: 7, Kind: "agentred", Fingerprint: "fp-a", Status: 1},
		{ID: 42, UserID: 7, Kind: "agentred", Fingerprint: "fp-b", Status: 1},
	}, nil)
	mini.SetError("ERR redis is down")

	items, err := svc.ListUserDevices(ctx, userID, 0)

	require.NoError(t, err)
	assert.Equal(t, []DeviceView{
		{ID: 41, Kind: "agentred", Fingerprint: "fp-a", Status: 1},
		{ID: 42, Kind: "agentred", Fingerprint: "fp-b", Status: 1},
	}, items)
}

// 设备流的 user_code 是**凭据**：谁手里有一个还没结算的 pending 码，就能用自己的
// 账号批准它，把受害者那台机器并进自己账号（批准端点认的就是「登录态 + 这个码」）。
// 日志是给排障看的，它进不了浏览器、却进日志文件、日志采集和任何有读权限的人手里，
// 所以它一行都不该带明文 —— docs/observability.md 的 data policy 已经写明「不记凭据」。
//
// 三处都要盯：签发（authorized）、批准（approved）、拒绝（denied）。批准与拒绝那两条
// 更要命：走到那里说明这个码此刻正是**有效的 pending 码**。
func TestDeviceFlow_UserCodeNeverReachesTheLog(t *testing.T) {
	logs := hubtest.Logs(t)
	ctx, _, _, mF, svc, _ := setupDeviceTest(t)

	var issued string
	mF.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, flow *device_flow_entity.DeviceFlowCode) error {
			issued = flow.UserCode
			return nil
		},
	)
	out, err := svc.Authorize(ctx, AuthorizeInput{
		DeviceKind: "agentred", Fingerprint: "fp-aaaaaaaa", Platform: "linux/amd64", Version: "0.5.0",
		Name: "coding",
	})
	require.NoError(t, err)
	require.Equal(t, issued, out.UserCode)

	const approved = "A4F-7Q2"
	mF.EXPECT().FindPendingByUserCode(gomock.Any(), approved).Return(
		&device_flow_entity.DeviceFlowCode{
			UserCode: approved, DeviceKind: "agentred",
			ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
		}, nil,
	)
	mF.EXPECT().Approve(gomock.Any(), approved, int64(42), gomock.Any()).Return(int64(1), nil)
	_, err = svc.Approve(ctx, approved, 42)
	require.NoError(t, err)

	const denied = "B5G-8R3"
	mF.EXPECT().Deny(gomock.Any(), denied, gomock.Any()).Return(int64(1), nil)
	require.NoError(t, svc.Deny(ctx, denied))

	for _, entry := range logs.All() {
		for _, secret := range []string{out.UserCode, approved, denied} {
			assert.NotContains(t, entry.Message, secret,
				"日志消息里出现了 user_code 明文：%s", entry.Message)
			for key, value := range entry.ContextMap() {
				assert.NotContains(t, fmt.Sprint(value), secret,
					"日志字段 %s 里出现了 user_code 明文（%s）", key, entry.Message)
			}
		}
	}
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

// TestExchangeToken_GivenADevice_ThenTheAccessTokenResolvesToTheDeviceFingerprint
// 决策 8：对端身份取自 server 对凭据的解析，不再看请求体。设备 access token 解析出的
// 对端指纹必须是该设备自己那条 devices.fingerprint —— 少了它，这条路上的账号握手会被
// 对端全数拒绝。
func TestExchangeToken_GivenADevice_ThenTheAccessTokenResolvesToTheDeviceFingerprint(t *testing.T) {
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
	mF.EXPECT().UpdateLastPolledIfDue(gomock.Any(), "dc-x", gomock.Any(), gomock.Any()).Return(int64(1), nil)
	var upserted device_entity.Device
	mD.EXPECT().FindByFingerprint(gomock.Any(), gomock.Any(), gomock.Any()).Return(nil, nil)
	mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, d *device_entity.Device) error { d.ID = 7; upserted = *d; return nil },
	)
	var stored *device_token_entity.DeviceToken
	mT.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, tok *device_token_entity.DeviceToken) error { stored = tok; return nil },
	)
	mF.EXPECT().MarkConsumed(gomock.Any(), "dc-x", gomock.Any()).Return(int64(1), nil)
	mock.ExpectBegin()
	mock.ExpectCommit()

	out, err := svc.ExchangeToken(ctx, "dc-x")
	require.NoError(t, err)

	mT.EXPECT().FindByAccessHash(gomock.Any(), sha256Hex(out.AccessToken)).Return(stored, nil)
	mD.EXPECT().Find(gomock.Any(), int64(7)).Return(&upserted, nil)
	principal, err := svc.ResolveBearer(ctx, out.AccessToken)
	require.NoError(t, err)
	assert.Equal(t, fingerprint, principal.PeerFingerprint)
	assert.Equal(t, int64(42), principal.AccountID)
	assert.Equal(t, int64(7), principal.DeviceID)
}

// TestRefreshBizCode 钉住 refresh 失败的**诊断**：线上的 error 字面量按 RFC 8628
// 恒为 invalid_grant（agentred 只认这个词，见 cmd/agentred/login.go 的 switch），
// 但用户看到的那句话必须说清楚到底哪里不对。
//
// 在此之前六条失败路径共用一个 DeviceFlowInvalidGrant，文案是「device_code 无效」——
// 而 refresh 这次请求里根本没有 device_code；同时 RefreshTokenReplay /
// RefreshTokenExpired 这两个文案正确的码在整个代码库零引用。
func TestRefreshBizCode(t *testing.T) {
	// biz 取出 OAuthError 携带的业务码；顺带确认线上字面量没被改掉。
	biz := func(t *testing.T, err error) int {
		t.Helper()
		var oe *OAuthError
		require.ErrorAs(t, err, &oe)
		assert.Equal(t, ErrInvalidGrant, oe.Code, "线上字面量必须仍是 invalid_grant")
		return oe.Biz
	}

	t.Run("refresh_token 缺失 → RefreshTokenInvalid", func(t *testing.T) {
		ctx, _, _, _, svc, _ := setupDeviceTest(t)
		_, err := svc.Refresh(ctx, "")
		assert.Equal(t, code.RefreshTokenInvalid, biz(t, err))
	})

	t.Run("refresh_token 查不到 → RefreshTokenInvalid", func(t *testing.T) {
		ctx, _, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(nil, nil)
		_, err := svc.Refresh(ctx, "missing")
		assert.Equal(t, code.RefreshTokenInvalid, biz(t, err))
	})

	t.Run("重放 → RefreshTokenReplay", func(t *testing.T) {
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
			&device_token_entity.DeviceToken{ID: 1, DeviceID: 42, RevokedAt: 5000}, nil,
		)
		// 设备仍然 active：这才是一次真正的重放，不是撤销的连带效果。
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
			&device_entity.Device{ID: 42, UserID: 7, Kind: "agentred", Status: consts.ACTIVE}, nil,
		)
		mT.EXPECT().RevokeChain(gomock.Any(), int64(42), gomock.Any()).Return(nil)
		_, err := svc.Refresh(ctx, "stolen")
		assert.Equal(t, code.RefreshTokenReplay, biz(t, err))
	})

	// 整条链已经被 Revoke 标过 revoked_at 的这枚 token 不算「重放」证据——它只是
	// 撤销留下的既有状态。设备撤销是终态判定，优先于这枚具体 token 的 revoked_at：
	// 答案必须是 DeviceRevoked，且不能再触发一次 RevokeChain（没有 EXPECT 就不允许调用）。
	t.Run("设备整链已撤销后刷新（token 行本身也已被标 revoked）→ DeviceRevoked，不判重放", func(t *testing.T) {
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
			&device_token_entity.DeviceToken{ID: 1, DeviceID: 42, RevokedAt: 5000}, nil,
		)
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
			&device_entity.Device{ID: 42, UserID: 7, Kind: "agentred", Status: consts.DELETE}, nil,
		)
		_, err := svc.Refresh(ctx, "revoked-chain-token")
		assert.Equal(t, code.DeviceRevoked, biz(t, err))
	})

	t.Run("已过期 → RefreshTokenExpired", func(t *testing.T) {
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
			&device_token_entity.DeviceToken{
				ID: 1, DeviceID: 42,
				RefreshExpiresAt: time.Now().Add(-time.Hour).UnixMilli(),
			}, nil,
		)
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
			&device_entity.Device{ID: 42, UserID: 7, Kind: "agentred", Status: consts.ACTIVE}, nil,
		)
		_, err := svc.Refresh(ctx, "stale")
		assert.Equal(t, code.RefreshTokenExpired, biz(t, err))
	})

	t.Run("设备已撤销 → DeviceRevoked", func(t *testing.T) {
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
			&device_token_entity.DeviceToken{
				ID: 1, DeviceID: 42,
				RefreshExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
			}, nil,
		)
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
			&device_entity.Device{ID: 42, UserID: 7, Kind: "agentred", Status: consts.DELETE}, nil,
		)
		_, err := svc.Refresh(ctx, "revoked-device")
		assert.Equal(t, code.DeviceRevoked, biz(t, err))
	})

	// devices 行整个不见了，与「还在、但已撤销」不是同一件事：前者是数据不一致，
	// 后者是用户自己在控制台点的。压成同一个码，排查时分不出来。
	t.Run("设备行不存在 → DeviceNotFound", func(t *testing.T) {
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
			&device_token_entity.DeviceToken{
				ID: 1, DeviceID: 42,
				RefreshExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
			}, nil,
		)
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(nil, nil)
		_, err := svc.Refresh(ctx, "orphan")
		assert.Equal(t, code.DeviceNotFound, biz(t, err))
	})
}

// ── 换取 token 那一刻要出声 ────────────────────────────────────────────────

// exchangeSignals 记下换取 token 时广播出去的每一帧。SetDefault 换掉包级入口。
type exchangeSignals struct {
	frames []accountchan_svc.Frame
}

func (s *exchangeSignals) Broadcast(_ context.Context, _ int64, frame accountchan_svc.Frame) error {
	s.frames = append(s.frames, frame)
	return nil
}

func (s *exchangeSignals) Subscribe(context.Context, int64) (accountchan_svc.Subscription, error) {
	return nil, accountchan_svc.ErrChannelUnconfigured
}

func recordExchangeSignals(t *testing.T) *exchangeSignals {
	t.Helper()
	signals := &exchangeSignals{}
	accountchan_svc.SetDefault(signals)
	t.Cleanup(func() { accountchan_svc.SetDefault(nil) })
	return signals
}

// Given 用户已经在控制台上批准了这台设备；When daemon 下一次轮询换到 token（devices
// 行正是在这一刻才建出来）；Then 这个账号收到一条 device_presence。
//
// 少了这一声，控制台只剩 relay 的 RegisterDaemon 那一条可指望：批准只改
// device_flow_codes，设备行要等 daemon 轮询（interval 默认 5 秒）才存在，而设备页只在
// 挂载时取一次、之后只跟着 device_presence 重取。用户批准完立刻进设备页正好落在这个
// 窗口里，看到的是空的；而账号通道此刻多半还在取票建连，RegisterDaemon 那一条发出来
// 也接不着。信号不补发、连着时兜底轮询又让路（见前端 accountChannel 的 poll），页面
// 于是一直停在空列表上直到手动刷新。
func TestExchangeToken_SignalsThatTheDeviceRowNowExists(t *testing.T) {
	ctx, mD, mT, mF, svc, mock := setupDeviceTest(t)
	signals := recordExchangeSignals(t)
	mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
		&device_flow_entity.DeviceFlowCode{
			DeviceCode: "dc-x", IntervalSeconds: 5,
			ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
			AuthorizedUserID: 42, ApprovedAt: time.Now().UnixMilli(),
			DeviceKind: "agentred", ClientFingerprint: "fp-aaaaaaaa",
		}, nil,
	)
	mF.EXPECT().UpdateLastPolledIfDue(gomock.Any(), "dc-x", gomock.Any(), gomock.Any()).Return(int64(1), nil)
	mF.EXPECT().MarkConsumed(gomock.Any(), "dc-x", gomock.Any()).Return(int64(1), nil)
	mD.EXPECT().FindByFingerprint(gomock.Any(), gomock.Any(), gomock.Any()).Return(nil, nil)
	mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, d *device_entity.Device) error { d.ID = 7; return nil },
	)
	mT.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
	mock.ExpectBegin()
	mock.ExpectCommit()

	_, err := svc.ExchangeToken(ctx, "dc-x")

	require.NoError(t, err)
	require.Equal(t, []accountchan_svc.Frame{
		{Type: accountchan_svc.FrameTypeDevicePresence},
	}, signals.frames)
}

// S2：Bearer 按摘要查到它的账号、设备、类型与对端指纹。未知、已过期、所属设备已撤销
// 一律答同一种无效；查库失败是另一回事，不能冒充成「令牌无效」。
func TestResolveBearer(t *testing.T) {
	const frozen int64 = 1_700_000_000_000
	const token = "opaque-access-token"
	digest := sha256Hex(token)
	activeDevice := func() *device_entity.Device {
		return &device_entity.Device{
			ID: 42, UserID: 7, Kind: device_entity.KindAgentred, Fingerprint: "sha256:aaaa", Status: consts.ACTIVE,
		}
	}
	setup := func(t *testing.T) (
		context.Context, *mock_device_repo.MockDeviceRepo, *mock_device_token_repo.MockDeviceTokenRepo, *deviceSvc,
	) {
		ctx, mD, mT, _, svc, _ := setupDeviceTest(t)
		svc.now = func() int64 { return frozen }
		return ctx, mD, mT, svc
	}

	t.Run("有效令牌交出账号、设备、类型、对端指纹、过期时刻与凭据句柄", func(t *testing.T) {
		ctx, mD, mT, svc := setup(t)
		mT.EXPECT().FindByAccessHash(gomock.Any(), digest).Return(
			&device_token_entity.DeviceToken{ID: 11, DeviceID: 42, AccessTokenHash: digest, Createtime: frozen - 1000}, nil)
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(activeDevice(), nil)

		got, err := svc.ResolveBearer(ctx, token)

		require.NoError(t, err)
		assert.Equal(t, &Principal{
			AccountID: 7, DeviceID: 42, Kind: device_entity.KindAgentred, PeerFingerprint: "sha256:aaaa",
			ExpiresAt: frozen - 1000 + time.Hour.Milliseconds(), Handle: "11",
		}, got)
	})

	t.Run("刷新轮换出的旧令牌在过期前仍有效：行上的 revoked_at 不参与判定", func(t *testing.T) {
		ctx, mD, mT, svc := setup(t)
		mT.EXPECT().FindByAccessHash(gomock.Any(), digest).Return(&device_token_entity.DeviceToken{
			ID: 11, DeviceID: 42, Createtime: frozen - time.Hour.Milliseconds() + 1, RevokedAt: frozen - 500,
		}, nil)
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(activeDevice(), nil)

		_, err := svc.ResolveBearer(ctx, token)

		assert.NoError(t, err)
	})

	t.Run("未知令牌无效", func(t *testing.T) {
		ctx, _, mT, svc := setup(t)
		mT.EXPECT().FindByAccessHash(gomock.Any(), digest).Return(nil, nil)

		_, err := svc.ResolveBearer(ctx, token)

		assert.ErrorIs(t, err, ErrBearerInvalid)
	})

	t.Run("到点即过期", func(t *testing.T) {
		ctx, _, mT, svc := setup(t)
		mT.EXPECT().FindByAccessHash(gomock.Any(), digest).Return(
			&device_token_entity.DeviceToken{ID: 11, DeviceID: 42, Createtime: frozen - time.Hour.Milliseconds()}, nil)

		_, err := svc.ResolveBearer(ctx, token)

		assert.ErrorIs(t, err, ErrBearerInvalid)
	})

	t.Run("所属设备已撤销", func(t *testing.T) {
		ctx, mD, mT, svc := setup(t)
		mT.EXPECT().FindByAccessHash(gomock.Any(), digest).Return(
			&device_token_entity.DeviceToken{ID: 11, DeviceID: 42, Createtime: frozen}, nil)
		revoked := activeDevice()
		revoked.Status = consts.DELETE
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(revoked, nil)

		_, err := svc.ResolveBearer(ctx, token)

		assert.ErrorIs(t, err, ErrBearerInvalid)
	})

	t.Run("设备行已不存在", func(t *testing.T) {
		ctx, mD, mT, svc := setup(t)
		mT.EXPECT().FindByAccessHash(gomock.Any(), digest).Return(
			&device_token_entity.DeviceToken{ID: 11, DeviceID: 42, Createtime: frozen}, nil)
		mD.EXPECT().Find(gomock.Any(), int64(42)).Return(nil, nil)

		_, err := svc.ResolveBearer(ctx, token)

		assert.ErrorIs(t, err, ErrBearerInvalid)
	})

	t.Run("空令牌不查库", func(t *testing.T) {
		ctx, _, _, svc := setup(t)

		_, err := svc.ResolveBearer(ctx, "")

		assert.ErrorIs(t, err, ErrBearerInvalid)
	})

	t.Run("查库失败原样上抛，不冒充成令牌无效", func(t *testing.T) {
		ctx, _, mT, svc := setup(t)
		boom := errors.New("boom")
		mT.EXPECT().FindByAccessHash(gomock.Any(), digest).Return(nil, boom)

		_, err := svc.ResolveBearer(ctx, token)

		assert.ErrorIs(t, err, boom)
		assert.NotErrorIs(t, err, ErrBearerInvalid)
	})
}

// bizCode 取一个服务层错误上钉着的业务码。
func bizCode(t *testing.T, err error) int {
	t.Helper()
	var he *httputils.Error
	require.True(t, errors.As(err, &he), "服务层的拒绝必须是成形的 httputils.Error，实际 %T: %v", err, err)
	return he.Code
}

// Rename 是账号级备注名的写入口（设备列表里三行同名 MacBook 时唯一分得清谁是谁的
// 办法）。它写的是 display_name 那一列，不是设备自报的 name——后者会被那台机器下一次
// claim 覆盖回去。
func TestRename_WritesTheNormalizedDisplayName(t *testing.T) {
	ctx, mD, _, _, svc, _ := setupDeviceTest(t)
	svc.now = func() int64 { return 5000 }

	mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
		&device_entity.Device{ID: 42, UserID: 7, Name: "wangyizhideMacBook-Pro.local", Status: consts.ACTIVE}, nil)
	// 首尾空白在落库之前就被去掉：存进去的空格此后每一处显示都带着。
	mD.EXPECT().UpdateDisplayName(gomock.Any(), int64(42), "办公室那台", int64(5000)).Return(nil)

	name, err := svc.Rename(ctx, 7, 42, "  办公室那台  ")

	assert.NoError(t, err)
	assert.Equal(t, "办公室那台", name, "交回的是这一改之后生效的显示名")
}

// 清空备注名是合法操作：写空串，生效的显示名回落到设备自报名。
func TestRename_ClearingFallsBackToTheReportedName(t *testing.T) {
	ctx, mD, _, _, svc, _ := setupDeviceTest(t)
	svc.now = func() int64 { return 5000 }

	mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
		&device_entity.Device{ID: 42, UserID: 7, Name: "wangyizhideMacBook-Pro.local", Status: consts.ACTIVE}, nil)
	mD.EXPECT().UpdateDisplayName(gomock.Any(), int64(42), "", int64(5000)).Return(nil)

	name, err := svc.Rename(ctx, 7, 42, "   ")

	assert.NoError(t, err)
	assert.Equal(t, "wangyizhideMacBook-Pro.local", name)
}

// 别人账号下的设备改不了。没有 UpdateDisplayName 的 EXPECT —— 真写下去就会在这里红。
func TestRename_RejectsADeviceFromAnotherAccount(t *testing.T) {
	ctx, mD, _, _, svc, _ := setupDeviceTest(t)

	mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
		&device_entity.Device{ID: 42, UserID: 8, Name: "someone-else", Status: consts.ACTIVE}, nil)

	_, err := svc.Rename(ctx, 7, 42, "我的")

	assert.Error(t, err)
	assert.Equal(t, code.DeviceNotFound, bizCode(t, err),
		"查不到 / 不归他 / 已撤销一律同一个出口：区分它们等于告诉调用方这台设备存在")
}

// 已撤销的设备同样改不了（与撤销、升级同一条归属判定 OwnedDevice）。
func TestRename_RejectsARevokedDevice(t *testing.T) {
	ctx, mD, _, _, svc, _ := setupDeviceTest(t)

	mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
		&device_entity.Device{ID: 42, UserID: 7, Status: consts.DELETE}, nil)

	_, err := svc.Rename(ctx, 7, 42, "我的")

	assert.Error(t, err)
	assert.Equal(t, code.DeviceNotFound, bizCode(t, err))
}

// 超长的名字在写库之前就被挡下，且判的是**修剪之后**的长度。
func TestRename_RejectsAnOverlongName(t *testing.T) {
	ctx, _, _, _, svc, _ := setupDeviceTest(t)

	_, err := svc.Rename(ctx, 7, 42, strings.Repeat("名", device_entity.MaxDisplayNameRunes+1))

	assert.Error(t, err)
	assert.Equal(t, code.InvalidParameter, bizCode(t, err))
	// 连归属都不必查：这条请求本身就不成立。没有 Find 的 EXPECT，查了就红。
}

// 恰好到上限、且首尾带空白的名字要收下：修剪掉的空格不占额度。
func TestRename_AcceptsALimitLengthNameWithSurroundingSpace(t *testing.T) {
	ctx, mD, _, _, svc, _ := setupDeviceTest(t)
	svc.now = func() int64 { return 5000 }
	name := strings.Repeat("名", device_entity.MaxDisplayNameRunes)

	mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
		&device_entity.Device{ID: 42, UserID: 7, Status: consts.ACTIVE}, nil)
	mD.EXPECT().UpdateDisplayName(gomock.Any(), int64(42), name, int64(5000)).Return(nil)

	got, err := svc.Rename(ctx, 7, 42, " "+name+" ")

	assert.NoError(t, err)
	assert.Equal(t, name, got)
}

// 设备列表要把账号级备注名带出去，控制台与桌面端才都看得见（这就是「账号级」的全部
// 意思）。原始的自报名同时保留：改名对话框要拿它当占位符，清空之后也要回落到它。
func TestListUserDevices_CarriesTheAccountLevelDisplayName(t *testing.T) {
	ctx, mD, _, _, svc, _ := setupDeviceTest(t)
	relay_svc.SetDefault(nil)
	t.Cleanup(func() { relay_svc.SetDefault(nil) })

	mD.EXPECT().ListByUser(gomock.Any(), int64(7)).Return([]*device_entity.Device{
		{ID: 42, UserID: 7, Name: "wangyizhideMacBook-Pro.local", DisplayName: "办公室那台", Fingerprint: "fp-a", Status: 1},
		{ID: 43, UserID: 7, Name: "wangyizhideMacBook-Pro.local", Fingerprint: "fp-b", Status: 1},
	}, nil)

	items, err := svc.ListUserDevices(ctx, 7, 0)

	require.NoError(t, err)
	require.Len(t, items, 2)
	assert.Equal(t, "办公室那台", items[0].DisplayName)
	assert.Equal(t, "wangyizhideMacBook-Pro.local", items[0].Name, "自报名不被备注名顶掉")
	assert.Equal(t, "", items[1].DisplayName, "没设过备注名就是空串，消费端据此回落到 name")
}
