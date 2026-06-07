//go:build jwttestkeys

package device_svc

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
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
		mF.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)

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
			mF.EXPECT().FindByDeviceCode(gomock.Any(), "dc-x").Return(
				&device_flow_entity.DeviceFlowCode{
					DeviceCode: "dc-x", IntervalSeconds: 5,
					ExpiresAt:        time.Now().Add(time.Hour).UnixMilli(),
					AuthorizedUserID: 42, ApprovedAt: time.Now().UnixMilli(),
					DeviceKind: "agentred", ClientFingerprint: "fp-xxxxxxx",
					ClientCapabilities: []byte(`{"compute":true}`),
				}, nil,
			)
			mF.EXPECT().UpdateLastPolled(gomock.Any(), "dc-x", gomock.Any()).Return(nil)
			mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, d *device_entity.Device) error { d.ID = 7; return nil },
			)
			mT.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
			mF.EXPECT().MarkConsumed(gomock.Any(), "dc-x", gomock.Any()).Return(nil)

			mock.ExpectBegin()
			mock.ExpectCommit()

			out, err := svc.ExchangeToken(ctx, "dc-x")
			assert.NoError(t, err)
			assert.NotEmpty(t, out.AccessToken)
			assert.NotEmpty(t, out.RefreshToken)
			assert.Equal(t, int64(7), out.DeviceID)
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
			mT.EXPECT().FindByHash(gomock.Any(), gomock.Any()).Return(
				&device_token_entity.DeviceToken{
					ID: 1, DeviceID: 42, RefreshExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
				}, nil,
			)
			mD.EXPECT().Find(gomock.Any(), int64(42)).Return(
				&device_entity.Device{ID: 42, UserID: 7, Kind: "agentred", Status: 1}, nil,
			)
			mT.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)
			mT.EXPECT().Revoke(gomock.Any(), int64(1), gomock.Any()).Return(nil)
			mD.EXPECT().Touch(gomock.Any(), int64(42), gomock.Any()).Return(nil)

			mock.ExpectBegin()
			mock.ExpectCommit()

			out, err := svc.Refresh(ctx, "good")
			assert.NoError(t, err)
			assert.NotEmpty(t, out.AccessToken)
			assert.NotEmpty(t, out.RefreshToken)
			assert.Equal(t, int64(42), out.DeviceID)
		})
	})
}

func TestListUserDevices(t *testing.T) {
	convey.Convey("ListUserDevices marks caller and decodes capabilities", t, func() {
		ctx, mD, _, _, svc, _ := setupDeviceTest(t)
		callerDev := int64(42)
		userID := int64(7)

		mD.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{
			{ID: 42, UserID: 7, Name: "mac-pro-m4", Kind: "desktop", Platform: "darwin/arm64", Version: "v0.4.1", Fingerprint: "fp-a", Capabilities: []byte(`{"compute":true,"file_browse":true}`), LastSeenAt: 1000, Status: 1},
			{ID: 43, UserID: 7, Name: "agentred-1", Kind: "agentred", Platform: "linux/amd64", Version: "v0.4.1", Fingerprint: "fp-b", Capabilities: []byte(`{"compute":true}`), LastSeenAt: 999, Status: 1},
		}, nil)

		items, err := svc.ListUserDevices(ctx, userID, callerDev)

		convey.So(err, convey.ShouldBeNil)
		convey.So(len(items), convey.ShouldEqual, 2)
		convey.So(items[0].ID, convey.ShouldEqual, int64(42))
		convey.So(items[0].IsThisDevice, convey.ShouldBeTrue)
		convey.So(items[0].Capabilities["compute"], convey.ShouldBeTrue)
		convey.So(items[0].Capabilities["file_browse"], convey.ShouldBeTrue)
		convey.So(items[1].IsThisDevice, convey.ShouldBeFalse)
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
			mF.EXPECT().Approve(gomock.Any(), "A4F-7Q2", int64(42), gomock.Any()).Return(nil)

			kind, err := svc.Approve(ctx, "A4F-7Q2", 42)
			assert.NoError(t, err)
			assert.Equal(t, "agentred", kind)
		})
	})
}
