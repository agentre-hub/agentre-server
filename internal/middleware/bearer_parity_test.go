package middleware_test

import (
	"context"
	"encoding/json"
	"errors"
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
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	hubjwt "github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/relayticket"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// DeviceJWT、SessionOrDeviceAuth 与中继客户端入口的原生分支对设备 access token 是同一条
// 判据：同一枚令牌在三处必须得到同一个放行/拒绝结论，放行时必须落下同一组身份。三处各写
// 一份实现时，往其中一处加一条校验而漏掉另一处，不会有任何编译错误——只会留下一个能绕过
// 它的入口。这组用例把「三处同形」变成机械检查。
func bearerMiddlewares(signer *hubjwt.Signer, tokens middleware.BearerResolver) map[string]gin.HandlerFunc {
	return map[string]gin.HandlerFunc{
		"DeviceJWT":           middleware.DeviceJWT(tokens),
		"SessionOrDeviceAuth": middleware.SessionOrDeviceAuth(tokens),
		"RelayClientJWT": middleware.RelayClientJWT(tokens, signer,
			jwtblacklist.New(redis.Default()), relayticket.New(redis.Default())),
	}
}

type claimDump struct {
	UserID     int64  `json:"user_id"`
	DeviceID   int64  `json:"device_id"`
	DeviceKind string `json:"device_kind"`
	Handle     string `json:"handle"`
}

func serveAuthorization(mw gin.HandlerFunc, authorization string) *httptest.ResponseRecorder {
	r := gin.New()
	r.GET("/probe", mw, func(c *gin.Context) {
		c.JSON(http.StatusOK, claimDump{
			UserID: ginctx.UserID(c), DeviceID: ginctx.DeviceID(c),
			DeviceKind: ginctx.DeviceKind(c), Handle: ginctx.CredentialHandle(c),
		})
	})
	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func serveBearer(mw gin.HandlerFunc, token string) *httptest.ResponseRecorder {
	return serveAuthorization(mw, "Bearer "+token)
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

// 放行时三处必须落下同一组身份——含凭据句柄。句柄是「这条请求用的是哪一份凭据」，
// 少了它，下游的长连接就没法复查自己背后的那份凭据。
func TestBearerBranches_PopulateTheSameClaims(t *testing.T) {
	signer := bearerTestSigner(t)
	token := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 42, Kind: "desktop", Handle: "11"})

	for name, mw := range bearerMiddlewares(signer, bearertest.Resolver{}) {
		t.Run(name, func(t *testing.T) {
			w := serveBearer(mw, token)
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())

			var got claimDump
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
			assert.Equal(t, claimDump{UserID: 7, DeviceID: 42, DeviceKind: "desktop", Handle: "11"}, got)
		})
	}
}

// 拒绝判据在三处必须同时成立。少一条就是多一个绕过入口。
func TestBearerBranches_RejectTheSameCredentials(t *testing.T) {
	signer := bearerTestSigner(t)
	legacyDeviceJWT, _, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "desktop"}, time.Hour)
	require.NoError(t, err)

	deviceless := bearertest.Issue(device_svc.Principal{AccountID: 7, Kind: "relay_client"})
	cases := map[string]string{
		"未知、已过期或设备已撤销的令牌不放行":    "Bearer unknown-token",
		"解析出的身份不属于任何设备，进不了设备入口": "Bearer " + deviceless,
		"验得过签的旧设备 JWT 不再放行":     "Bearer " + legacyDeviceJWT,
		"空 Bearer 不放行":          "Bearer ",
	}
	for name, mw := range bearerMiddlewares(signer, bearertest.Resolver{}) {
		for why, authorization := range cases {
			t.Run(name+"/"+why, func(t *testing.T) {
				assert.Equal(t, http.StatusUnauthorized, serveAuthorization(mw, authorization).Code)
			})
		}
	}
}

type failingResolver struct{}

func (failingResolver) ResolveBearer(context.Context, string) (*device_svc.Principal, error) {
	return nil, errors.New("database unavailable")
}

// 解析方判不出来（查库失败）不是「凭据无效」：三处给同一个结论，而且不是 401——
// 否则客户端会把一次数据库抖动当成凭据失效，去刷新甚至重新配对。
func TestBearerBranches_ResolverFailureIsNotAnAuthVerdict(t *testing.T) {
	signer := bearerTestSigner(t)

	for name, mw := range bearerMiddlewares(signer, failingResolver{}) {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, http.StatusInternalServerError, serveBearer(mw, "any-token").Code)
		})
	}
}
