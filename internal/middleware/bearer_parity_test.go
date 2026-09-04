package middleware_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	hubjwt "github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
)

// DeviceJWT 与 SessionOrDeviceAuth 的 Bearer 分支是同一条判据：同一枚凭据在两处
// 必须得到同一个放行/拒绝结论，放行时必须落下同一组 claim。两处各写一份实现时，
// 往其中一处加一条校验（比如某天给黑名单加个宽限期）而漏掉另一处，不会有任何
// 编译错误——只会留下一个能绕过它的入口。这组用例把「两处同形」变成机械检查。
func bearerMiddlewares(signer *hubjwt.Signer) map[string]gin.HandlerFunc {
	return map[string]gin.HandlerFunc{
		"DeviceJWT":           middleware.DeviceJWT(signer, jwtblacklist.New(redis.Default())),
		"SessionOrDeviceAuth": middleware.SessionOrDeviceAuth(signer, jwtblacklist.New(redis.Default())),
	}
}

type claimDump struct {
	UserID     int64  `json:"user_id"`
	DeviceID   int64  `json:"device_id"`
	DeviceKind string `json:"device_kind"`
	JTI        string `json:"jti"`
}

func serveBearer(mw gin.HandlerFunc, token string) *httptest.ResponseRecorder {
	r := gin.New()
	r.GET("/probe", mw, func(c *gin.Context) {
		c.JSON(http.StatusOK, claimDump{
			UserID: ginctx.UserID(c), DeviceID: ginctx.DeviceID(c),
			DeviceKind: ginctx.DeviceKind(c), JTI: ginctx.JTI(c),
		})
	})
	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func bearerTestSigner(t *testing.T) *hubjwt.Signer {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), "server_session", 14*24*3600)))
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	return signer
}

// 放行时两处必须落下同一组 claim——含 jti。jti 是「这条请求用的是哪一份凭据」，
// 少了它，下游就分不清同一账号的两枚凭据。
func TestBearerBranches_PopulateTheSameClaims(t *testing.T) {
	signer := bearerTestSigner(t)
	tok, jti, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "desktop"}, time.Hour)
	require.NoError(t, err)

	for name, mw := range bearerMiddlewares(signer) {
		t.Run(name, func(t *testing.T) {
			w := serveBearer(mw, tok)
			require.Equal(t, http.StatusOK, w.Code)

			var got claimDump
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
			assert.Equal(t, claimDump{UserID: 7, DeviceID: 42, DeviceKind: "desktop", JTI: jti}, got)
		})
	}
}

// 三条拒绝判据在两处必须同时成立。少一条就是多一个绕过入口。
func TestBearerBranches_RejectTheSameCredentials(t *testing.T) {
	signer := bearerTestSigner(t)

	relayTicket, _, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 0, Kind: "relay_client"}, time.Hour)
	require.NoError(t, err)
	noDevice, _, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 0, Kind: "desktop"}, time.Hour)
	require.NoError(t, err)
	blacklisted, blacklistedJTI, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "desktop"}, time.Hour)
	require.NoError(t, err)
	require.NoError(t, jwtblacklist.New(redis.Default()).Add(t.Context(), blacklistedJTI, 3600))

	cases := map[string]string{
		"浏览器中继票据不能进普通设备端点": relayTicket,
		"没有设备号的凭据不放行":      noDevice,
		"已拉黑的 jti 不放行":     blacklisted,
		"签名不认的凭据不放行":       "garbage",
	}
	for name, mw := range bearerMiddlewares(signer) {
		for why, tok := range cases {
			t.Run(name+"/"+why, func(t *testing.T) {
				assert.Equal(t, http.StatusUnauthorized, serveBearer(mw, tok).Code)
			})
		}
	}
}
