package device_ctr

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/device"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

type Device struct {
	publicKeys *api.PublicKeyResponse
	signer     *jwt.Signer
}

func NewDevice() *Device { return &Device{} }

func NewDeviceWithPublicKeys(currentKID string, keys map[string]string, maxTokenLifetimeSeconds int64) *Device {
	return &Device{publicKeys: &api.PublicKeyResponse{
		Version: 1, CurrentKID: currentKID, Keys: keys,
		MaxTokenLifetimeSeconds: maxTokenLifetimeSeconds,
	}}
}

func (d *Device) SetSigner(signer *jwt.Signer) { d.signer = signer }

// PublicKey 返回供 agentred 离线验签的 RS256 公钥。
func (d *Device) PublicKey(c *gin.Context, _ *api.PublicKeyRequest) {
	c.JSON(http.StatusOK, d.publicKeys)
}

// ---- Device Flow ----

func (d *Device) Authorize(ctx context.Context, req *api.DeviceAuthorizeRequest) (*api.DeviceAuthorizeResponse, error) {
	out, err := device_svc.Default().Authorize(ctx, device_svc.AuthorizeInput{
		DeviceKind: req.DeviceKind, Fingerprint: req.Fingerprint,
		Platform: req.Platform, Version: req.Version, Name: req.Name,
	})
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return &api.DeviceAuthorizeResponse{
		DeviceCode: out.DeviceCode, UserCode: out.UserCode,
		VerificationURI: out.VerificationURI, VerificationURIComplete: out.VerificationURIComplete,
		Interval: out.Interval, ExpiresIn: out.ExpiresIn,
	}, nil
}

func (d *Device) Token(c *gin.Context, req *api.DeviceTokenRequest) (*api.DeviceTokenResponse, error) {
	ctx := device_svc.WithClientInfo(c.Request.Context(), c.ClientIP(), c.GetHeader("User-Agent"))
	out, err := device_svc.Default().ExchangeToken(ctx, req.DeviceCode)
	if err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.DeviceTokenResponse{
		AccessToken: out.AccessToken, TokenType: "Bearer",
		ExpiresIn: out.ExpiresIn, RefreshToken: out.RefreshToken,
		RefreshExpiresIn: out.RefreshExpiresIn, DeviceID: out.DeviceID,
	}, nil
}

func (d *Device) Pending(c *gin.Context, req *api.DevicePendingRequest) (*api.DevicePendingResponse, error) {
	info, err := device_svc.Default().Pending(c.Request.Context(), req.UserCode)
	if err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.DevicePendingResponse{
		DeviceKind: info.DeviceKind, Platform: info.Platform, Version: info.Version,
		ExpiresIn: info.ExpiresIn,
	}, nil
}

func (d *Device) Approve(c *gin.Context, req *api.DeviceApproveRequest) (*api.DeviceApproveResponse, error) {
	userID := ginctx.UserID(c)
	if userID == 0 {
		return nil, i18n.NewErrorWithStatus(c.Request.Context(), http.StatusUnauthorized, code.Unauthorized)
	}
	kind, err := device_svc.Default().Approve(c.Request.Context(), req.UserCode, userID)
	if err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.DeviceApproveResponse{DeviceKind: kind}, nil
}

func (d *Device) Deny(c *gin.Context, req *api.DeviceDenyRequest) (*api.DeviceDenyResponse, error) {
	if err := device_svc.Default().Deny(c.Request.Context(), req.UserCode); err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.DeviceDenyResponse{}, nil
}

func (d *Device) Refresh(c *gin.Context, req *api.TokenRefreshRequest) (*api.TokenRefreshResponse, error) {
	ctx := device_svc.WithClientInfo(c.Request.Context(), c.ClientIP(), c.GetHeader("User-Agent"))
	out, err := device_svc.Default().Refresh(ctx, req.RefreshToken)
	if err != nil {
		return nil, oauthErrToHTTP(c, err)
	}
	return &api.TokenRefreshResponse{
		AccessToken: out.AccessToken, ExpiresIn: out.ExpiresIn,
		RefreshToken: out.RefreshToken, RefreshExpiresIn: out.RefreshExpiresIn,
	}, nil
}

const relayTicketTTL = 2 * time.Minute

// RelayTicket 用浏览器登录 session 换取只可连接 relay client 的短效凭据。
func (d *Device) RelayTicket(c *gin.Context, _ *api.RelayTicketRequest) (*api.RelayTicketResponse, error) {
	ctx := c.Request.Context()
	userID := ginctx.UserID(c)
	if userID == 0 || d.signer == nil {
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusUnauthorized, code.Unauthorized)
	}
	token, jti, err := d.signer.Sign(jwt.Claims{UID: userID, Kind: "relay_client"}, relayTicketTTL)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	// 把 jti 记到签发它的这次会话名下，登出才能立刻把它拉黑；否则票在手就还能连
	// /v1/relay/client 读写该账号全部 agentred 的会话，最长 relayTicketTTL。
	//
	// 这里 fail-closed：登记不上就等于发一张撤不掉的票，宁可不发。本路由挂在
	// SessionAuth 之后，Redis 不可用时请求根本走不到这儿，代价只是同一次抖动里
	// 换票失败——比留下一张不可撤销的票便宜。
	sid, _ := c.Cookie(auth_svc.Default().CookieName())
	if err := auth_svc.Default().TrackRelayTicket(ctx, sid, jti, relayTicketTTL); err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return &api.RelayTicketResponse{AccessToken: token, ExpiresIn: int(relayTicketTTL / time.Second)}, nil
}

// Revoke 撤销一台设备的凭据。
//
// 设备 JWT 调用方（device_id 非 0）只能撤销自己；浏览器 session 调用方
// （device_id 为 0）只能撤销属于自己账号的设备——凭据所属关系以
// ListUserDevices 为准，防止跨账号撤销。
func (d *Device) Revoke(c *gin.Context, req *api.TokenRevokeRequest) (*api.TokenRevokeResponse, error) {
	userID := ginctx.UserID(c)
	callerID := ginctx.DeviceID(c)
	target := req.DeviceID
	if target == 0 {
		target = callerID
	}
	if target == 0 {
		return nil, i18n.NewForbiddenError(c.Request.Context(), code.Forbidden)
	}
	if callerID != 0 {
		if target != callerID {
			return nil, i18n.NewForbiddenError(c.Request.Context(), code.Forbidden)
		}
	} else {
		owned, err := device_svc.Default().ListUserDevices(c.Request.Context(), userID, 0)
		if err != nil {
			return nil, err
		}
		isOwned := false
		for _, it := range owned {
			if it.ID == target {
				isOwned = true
				break
			}
		}
		if !isOwned {
			return nil, i18n.NewForbiddenError(c.Request.Context(), code.Forbidden)
		}
	}
	if err := device_svc.Default().Revoke(c.Request.Context(), target); err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	return &api.TokenRevokeResponse{}, nil
}

func (d *Device) List(c *gin.Context, _ *api.ListDevicesRequest) (*api.ListDevicesResponse, error) {
	userID := ginctx.UserID(c)
	deviceID := ginctx.DeviceID(c)

	items, err := device_svc.Default().ListUserDevices(c.Request.Context(), userID, deviceID)
	if err != nil {
		return nil, err
	}
	return &api.ListDevicesResponse{Devices: items}, nil
}

// Revocations 供 daemon 定期拉取吊销列表（R4 producer）。设备 JWT 鉴权，
// 已吊销设备自身拉取时被既有 DeviceJWT 中间件的黑名单校验拒绝在前面，
// 这里只需从 JWT 里取账号并转发给 service。
func (d *Device) Revocations(c *gin.Context, _ *api.RevocationsRequest) (*api.RevocationsResponse, error) {
	jtis, err := device_svc.Default().ListRevokedJTI(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	return &api.RevocationsResponse{RevokedJTI: jtis, AsOf: time.Now().UnixMilli()}, nil
}

// oauthErrToHTTP 把 device_svc.OAuthError 映射成 HTTP 状态 + 业务 code，并在 body 里附 RFC 8628 字段。
func oauthErrToHTTP(c *gin.Context, err error) error {
	var oe *device_svc.OAuthError
	if !errors.As(err, &oe) {
		return i18n.NewInternalError(c.Request.Context(), code.ServerError)
	}
	var status, biz int
	switch oe.Code {
	case device_svc.ErrAuthorizationPending:
		status, biz = http.StatusBadRequest, code.DeviceFlowAuthorizationPending
	case device_svc.ErrSlowDown:
		status, biz = http.StatusTooManyRequests, code.DeviceFlowSlowDown
	case device_svc.ErrExpiredToken:
		status, biz = http.StatusGone, code.DeviceFlowExpiredToken
	case device_svc.ErrAccessDenied:
		status, biz = http.StatusForbidden, code.DeviceFlowAccessDenied
	case device_svc.ErrInvalidGrant:
		status, biz = http.StatusBadRequest, code.DeviceFlowInvalidGrant
	case device_svc.ErrUserCodeInvalid:
		status, biz = http.StatusBadRequest, code.DeviceFlowUserCodeInvalid
	default:
		status, biz = http.StatusBadRequest, code.OperationFailed
	}
	c.Set("oauth_error", oe.Code)
	c.Set("oauth_error_description", oe.Description)
	return i18n.NewErrorWithStatus(c.Request.Context(), status, biz)
}
