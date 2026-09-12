package middleware_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	hubjwt "github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/relayticket"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

// installAccountGate 装上真闸门（miniredis + repo mock），让这些用例走的是生产那条
// 判定链路：改库封禁 → 取账号行不过滤状态 → user_entity.Check → 401。
func installAccountGate(t *testing.T, status int) {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	repo := mock_user_repo.NewMockUserRepo(ctrl)
	// MinTimes(1) 而不是 AnyTimes()：AnyTimes 允许**零次**，于是「放行」那几条用例
	// （只断言 200）在闸门根本没被接进这条鉴权路径时照样是绿的——而「闸门装上了」
	// 正是它们要证明的事。封禁那几条用例不受影响，它们本来就必然要查这一次。
	repo.EXPECT().FindIgnoreStatus(gomock.Any(), int64(7)).
		Return(&user_entity.User{ID: 7, Status: status}, nil).MinTimes(1)
	user_repo.RegisterUser(repo)
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	user_svc.SetGate(user_svc.NewGate(client, time.Minute))
	t.Cleanup(func() {
		user_svc.SetGate(nil)
		user_repo.RegisterUser(nil)
		_ = client.Close()
	})
}

func gatedAuthTestSigner(t *testing.T) *hubjwt.Signer {
	t.Helper()
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	return signer
}

func gatedRoute(handler gin.HandlerFunc) *gin.Engine {
	r := gin.New()
	r.GET("/me", handler, func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	return r
}

// sessionCookieFor 起一次真实的登录会话，返回可直接挂到请求上的 cookie。
func sessionCookieFor(t *testing.T, userID int64) *http.Cookie {
	t.Helper()
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), "server_session", 14*24*3600)))
	sid, _, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return &http.Cookie{Name: "server_session", Value: sid}
}

func bannedCode() string { return `"code":` + strconv.Itoa(code.UserBanned) }

// 会话有效但账号已被封禁：凭据这一关过了，账号这一关没过，必须 401 + UserBanned。
func TestSessionAuth_BannedAccountRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cookie := sessionCookieFor(t, 7)
	installAccountGate(t, consts.BAN)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	gatedRoute(middleware.SessionAuth()).ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), bannedCode())
}

func TestSessionAuth_ActiveAccountStillPasses(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cookie := sessionCookieFor(t, 7)
	installAccountGate(t, consts.ACTIVE)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	gatedRoute(middleware.SessionAuth()).ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestSessionOrDeviceAuth_BannedAccountRejectedOnSessionBranch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cookie := sessionCookieFor(t, 7)
	installAccountGate(t, consts.BAN)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	gatedRoute(middleware.SessionOrDeviceAuth(gatedAuthTestSigner(t), jwtblacklist.New(redis.Default()))).ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), bannedCode())
}

func TestSessionOrDeviceAuth_BannedAccountRejectedOnBearerBranch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	installAccountGate(t, consts.BAN)
	signer := gatedAuthTestSigner(t)
	token, _, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "desktop"}, time.Hour)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	gatedRoute(middleware.SessionOrDeviceAuth(signer, jwtblacklist.New(redis.Default()))).ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), bannedCode())
}

func TestDeviceJWT_BannedAccountRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	installAccountGate(t, consts.BAN)
	signer := gatedAuthTestSigner(t)
	token, _, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "desktop"}, time.Hour)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	gatedRoute(middleware.DeviceJWT(signer, jwtblacklist.New(redis.Default()))).ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), bannedCode())
}

// relay ticket 走的是另一个中间件（DeviceJWT 刻意拒绝它），闸门必须一样挡得住。
func TestRelayClientJWT_BannedAccountRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	installAccountGate(t, consts.BAN)
	signer := gatedAuthTestSigner(t)
	token, _, err := signer.Sign(hubjwt.Claims{UID: 7, Kind: "relay_client"}, 2*time.Minute)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	gatedRoute(middleware.RelayClientJWT(signer, jwtblacklist.New(redis.Default()), relayticket.New(redis.Default()))).ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), bannedCode())
}
