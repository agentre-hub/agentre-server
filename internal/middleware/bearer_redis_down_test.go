package middleware_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_token_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo/mock_device_token_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

func digestOf(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// S2：Redis 不可用时，设备 access token 的判定照常。三处入口接的是生产那个解析方
// （device_svc 按摘要查库）与生产那道账号闸门（缓存读不到回落查库），Redis 整个停掉之后
// 有效令牌照常放行、所属设备已撤销的令牌照常 401。
func TestBearerBranches_DecideDeviceTokensWithoutRedis(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mini := testutils.Redis(t) // 这一台是全局默认，下面把它整个停掉
	signer := gatedAuthTestSigner(t)

	ctrl := gomock.NewController(t)
	tokens := mock_device_token_repo.NewMockDeviceTokenRepo(ctrl)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	users := mock_user_repo.NewMockUserRepo(ctrl)
	device_token_repo.RegisterDeviceToken(tokens)
	device_repo.RegisterDevice(devices)
	user_repo.RegisterUser(users)
	user_svc.SetGate(user_svc.NewGate(redis.Default(), time.Minute))
	t.Cleanup(func() {
		device_token_repo.RegisterDeviceToken(nil)
		device_repo.RegisterDevice(nil)
		user_repo.RegisterUser(nil)
		user_svc.SetGate(nil)
	})

	now := time.Now().UnixMilli()
	tokens.EXPECT().FindByAccessHash(gomock.Any(), digestOf("live")).
		Return(&device_token_entity.DeviceToken{ID: 1, DeviceID: 42, Createtime: now}, nil).AnyTimes()
	tokens.EXPECT().FindByAccessHash(gomock.Any(), digestOf("revoked")).
		Return(&device_token_entity.DeviceToken{ID: 2, DeviceID: 43, Createtime: now}, nil).AnyTimes()
	tokens.EXPECT().FindByAccessHash(gomock.Any(), digestOf("unknown")).Return(nil, nil).AnyTimes()
	devices.EXPECT().Find(gomock.Any(), int64(42)).Return(&device_entity.Device{
		ID: 42, UserID: 7, Kind: device_entity.KindDesktop, Status: consts.ACTIVE,
	}, nil).AnyTimes()
	devices.EXPECT().Find(gomock.Any(), int64(43)).Return(&device_entity.Device{
		ID: 43, UserID: 7, Kind: device_entity.KindDesktop, Status: consts.DELETE,
	}, nil).AnyTimes()
	users.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
		Return(&user_entity.User{ID: 7, Status: consts.ACTIVE}, nil).MinTimes(1)

	middlewares := bearerMiddlewares(signer, device_svc.New(device_svc.Config{AccessTTL: time.Hour}, nil, nil))
	mini.Close()

	for name, mw := range middlewares {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, http.StatusOK, serveBearer(mw, "live").Code, "有效令牌照常放行")
			assert.Equal(t, http.StatusUnauthorized, serveBearer(mw, "revoked").Code, "设备已撤销照常拒绝")
			assert.Equal(t, http.StatusUnauthorized, serveBearer(mw, "unknown").Code, "未知令牌照常拒绝")
		})
	}
}
