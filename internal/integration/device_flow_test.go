package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/controller/auth_ctr"
	"agentre-server/internal/controller/device_ctr"
	"agentre-server/internal/middleware"
	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/device_flow_entity"
	"agentre-server/internal/model/entity/device_token_entity"
	"agentre-server/internal/model/entity/user_entity"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/repository/device_flow_repo"
	"agentre-server/internal/repository/device_flow_repo/mock_device_flow_repo"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_repo/mock_device_repo"
	"agentre-server/internal/repository/device_token_repo"
	"agentre-server/internal/repository/device_token_repo/mock_device_token_repo"
	"agentre-server/internal/repository/user_repo"
	"agentre-server/internal/repository/user_repo/mock_user_repo"
	"agentre-server/internal/service/device_svc"
	hubtest "agentre-server/internal/testutils"
)

func TestDeviceFlow_HappyPath(t *testing.T) {
	testutils.Redis()
	_ = redis.Default()
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mD := mock_device_repo.NewMockDeviceRepo(ctrl)
	mT := mock_device_token_repo.NewMockDeviceTokenRepo(ctrl)
	mF := mock_device_flow_repo.NewMockDeviceFlowRepo(ctrl)
	mU := mock_user_repo.NewMockUserRepo(ctrl)
	device_repo.RegisterDevice(mD)
	device_token_repo.RegisterDeviceToken(mT)
	device_flow_repo.RegisterDeviceFlow(mF)
	user_repo.RegisterUser(mU)

	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	svc := device_svc.New(device_svc.Config{
		UserCodeTTL: 10 * time.Minute, PollInterval: 5 * time.Second,
		AccessTTL: time.Hour, RefreshTTL: 90 * 24 * time.Hour,
		VerificationURI: "http://localhost/device",
	}, signer)
	device_svc.SetDefault(svc)

	// inject sqlmock DB so ExchangeToken's db.Ctx(ctx).Transaction() can run
	ctx, _, mock := hubtest.DatabasePG(t)

	// 1) authorize → user_code
	mF.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	})
	r.Use(middleware.AttachOAuthErrorFields())
	ctr := device_ctr.NewDevice()
	r.POST("/v1/oauth/device/authorize", wrapCtx(ctr.Authorize))
	r.POST("/v1/oauth/device/token", wrapGin(ctr.Token))

	body := `{"device_kind":"agentred","fingerprint":"fp-aaaaaaaa","capabilities":{"compute":true}}`
	req := httptest.NewRequest("POST", "/v1/oauth/device/authorize", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, 200, w.Code)
	var authzResp struct {
		Data struct {
			DeviceCode string `json:"device_code"`
			UserCode   string `json:"user_code"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(w.Body).Decode(&authzResp))
	require.NotEmpty(t, authzResp.Data.DeviceCode)

	// 2) polling 时未授权 → authorization_pending
	nowMs := time.Now().UnixMilli()
	mF.EXPECT().FindByDeviceCode(gomock.Any(), authzResp.Data.DeviceCode).Return(
		&device_flow_entity.DeviceFlowCode{
			DeviceCode:      authzResp.Data.DeviceCode,
			IntervalSeconds: 5,
			ExpiresAt:       nowMs + 600_000,
		}, nil,
	)
	mF.EXPECT().UpdateLastPolled(gomock.Any(), authzResp.Data.DeviceCode, gomock.Any()).Return(nil)
	req = httptest.NewRequest("POST", "/v1/oauth/device/token", strings.NewReader(
		`{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"`+authzResp.Data.DeviceCode+`"}`,
	))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, 400, w.Code)
	require.Contains(t, w.Body.String(), `"error":"authorization_pending"`)

	// 3) 授权后 polling → 颁发 token
	mF.EXPECT().FindByDeviceCode(gomock.Any(), authzResp.Data.DeviceCode).Return(
		&device_flow_entity.DeviceFlowCode{
			DeviceCode:         authzResp.Data.DeviceCode,
			IntervalSeconds:    5,
			ExpiresAt:          nowMs + 600_000,
			AuthorizedUserID:   42,
			ApprovedAt:         nowMs - 1000,
			DeviceKind:         "agentred",
			ClientFingerprint:  "fp-aaaaaaaa",
			ClientCapabilities: []byte(`{"compute":true}`),
		}, nil,
	)
	mF.EXPECT().UpdateLastPolled(gomock.Any(), authzResp.Data.DeviceCode, gomock.Any()).Return(nil)
	mD.EXPECT().Upsert(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, d *device_entity.Device) error { d.ID = 7; return nil },
	)
	mT.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, e *device_token_entity.DeviceToken) error { e.ID = 11; return nil },
	)
	mF.EXPECT().MarkConsumed(gomock.Any(), authzResp.Data.DeviceCode, gomock.Any()).Return(int64(1), nil)
	mock.ExpectBegin()
	mock.ExpectCommit()

	req = httptest.NewRequest("POST", "/v1/oauth/device/token", strings.NewReader(
		`{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"`+authzResp.Data.DeviceCode+`"}`,
	))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, 200, w.Code)
	var tokResp struct {
		Data struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			DeviceID     int64  `json:"device_id"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(w.Body).Decode(&tokResp))
	require.NotEmpty(t, tokResp.Data.AccessToken)
	require.NotEmpty(t, tokResp.Data.RefreshToken)
	require.Equal(t, int64(7), tokResp.Data.DeviceID)

	// 4) /v1/auth/me via SessionOrDeviceAuth (Bearer device-JWT)
	claims, verr := signer.Verify(tokResp.Data.AccessToken)
	require.NoError(t, verr)

	mU.EXPECT().Find(gomock.Any(), claims.UID).Return(&user_entity.User{
		ID: claims.UID, Email: "u@e.com", DisplayName: "u", AvatarURL: "",
	}, nil)

	authCtr := auth_ctr.NewAuth()
	r.GET("/v1/auth/me",
		middleware.SessionOrDeviceAuth(signer),
		wrapGet(authCtr.Me),
	)

	meReq := httptest.NewRequest(http.MethodGet, "/v1/auth/me", nil)
	meReq.Header.Set("Authorization", "Bearer "+tokResp.Data.AccessToken)
	meW := httptest.NewRecorder()
	r.ServeHTTP(meW, meReq)
	require.Equal(t, http.StatusOK, meW.Code, meW.Body.String())
	require.Contains(t, meW.Body.String(), `"device_id":`)

	// 5) /v1/devices via DeviceJWT
	mD.EXPECT().ListByUser(gomock.Any(), claims.UID).Return([]*device_entity.Device{
		{
			ID: tokResp.Data.DeviceID, UserID: claims.UID, Name: "this-machine",
			Kind: "agentred", Platform: "linux/amd64",
			Capabilities: []byte(`{"compute":true}`),
			LastSeenAt:   time.Now().UnixMilli(), Status: 1,
		},
	}, nil)

	r.GET("/v1/devices",
		middleware.DeviceJWT(signer),
		wrapGet(ctr.List),
	)

	devReq := httptest.NewRequest(http.MethodGet, "/v1/devices", nil)
	devReq.Header.Set("Authorization", "Bearer "+tokResp.Data.AccessToken)
	devW := httptest.NewRecorder()
	r.ServeHTTP(devW, devReq)
	require.Equal(t, http.StatusOK, devW.Code, devW.Body.String())
	require.Contains(t, devW.Body.String(), `"is_this_device":true`)
}

// wrapCtx adapts a handler with (context.Context, *Req) signature to gin.HandlerFunc.
func wrapCtx[Req any, Resp any](h func(context.Context, *Req) (*Resp, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		req := new(Req)
		if err := c.ShouldBindJSON(req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": 1, "msg": err.Error(), "data": nil})
			return
		}
		resp, err := h(c.Request.Context(), req)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": 30000, "msg": err.Error(), "data": nil})
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 0, "msg": "ok", "data": resp})
	}
}

// wrapGin adapts a handler with (*gin.Context, *Req) signature to gin.HandlerFunc.
func wrapGin[Req any, Resp any](h func(*gin.Context, *Req) (*Resp, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		req := new(Req)
		if err := c.ShouldBindJSON(req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": 1, "msg": err.Error(), "data": nil})
			return
		}
		resp, err := h(c, req)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": 30000, "msg": err.Error(), "data": nil})
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 0, "msg": "ok", "data": resp})
	}
}

// wrapGet adapts a handler with (*gin.Context, *Req) signature to gin.HandlerFunc for
// GET requests that carry no JSON body (Req is an empty struct).
func wrapGet[Req any, Resp any](h func(*gin.Context, *Req) (*Resp, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		req := new(Req)
		resp, err := h(c, req)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": 30000, "msg": err.Error(), "data": nil})
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 0, "msg": "ok", "data": resp})
	}
}
