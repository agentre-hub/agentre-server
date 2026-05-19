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

	"agentre-hub/internal/pkg/jwt"
	"agentre-hub/internal/pkg/jwt/testkeys"
	"agentre-hub/internal/repository/device_flow_repo"
	"agentre-hub/internal/repository/device_flow_repo/mock_device_flow_repo"
	"agentre-hub/internal/repository/device_repo"
	"agentre-hub/internal/repository/device_repo/mock_device_repo"
	"agentre-hub/internal/repository/device_token_repo"
	"agentre-hub/internal/repository/device_token_repo/mock_device_token_repo"
	hubtest "agentre-hub/internal/testutils"
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

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-hub", "agentre")
	if err != nil {
		t.Fatal(err)
	}

	cfg := Config{
		UserCodeTTL: 10 * time.Minute, PollInterval: 5 * time.Second,
		AccessTTL: time.Hour, RefreshTTL: 90 * 24 * time.Hour,
		VerificationURI: "https://hub/device",
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
