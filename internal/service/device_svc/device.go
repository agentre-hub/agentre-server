// Package device_svc 编排 RFC 8628 Device Flow 与 token 生命周期。
package device_svc

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"

	"agentre-hub/internal/model/entity/device_entity"
	"agentre-hub/internal/model/entity/device_flow_entity"
	"agentre-hub/internal/model/entity/device_token_entity"
	"agentre-hub/internal/pkg/jwt"
	"agentre-hub/internal/pkg/usercode"
	"agentre-hub/internal/repository/device_flow_repo"
	"agentre-hub/internal/repository/device_repo"
	"agentre-hub/internal/repository/device_token_repo"
)

type DeviceSvc interface {
	Authorize(ctx context.Context, in AuthorizeInput) (*AuthorizeOutput, error)
	Pending(ctx context.Context, userCode string) (*PendingInfo, error)
	Approve(ctx context.Context, userCode string, userID int64) (kind string, err error)
	Deny(ctx context.Context, userCode string) error
	ExchangeToken(ctx context.Context, deviceCode string) (*TokenOutput, error)
	Refresh(ctx context.Context, refreshToken string) (*TokenOutput, error)
	Revoke(ctx context.Context, deviceID int64) error
}

type deviceSvc struct {
	cfg    Config
	signer Signer
}

var defaultSvc DeviceSvc

func Default() DeviceSvc     { return defaultSvc }
func SetDefault(s DeviceSvc) { defaultSvc = s }

func New(cfg Config, signer Signer) DeviceSvc           { return newDeviceSvc(cfg, signer) }
func newDeviceSvc(cfg Config, signer Signer) *deviceSvc { return &deviceSvc{cfg: cfg, signer: signer} }

func (s *deviceSvc) Authorize(ctx context.Context, in AuthorizeInput) (*AuthorizeOutput, error) {
	now := time.Now().UnixMilli()
	dc, err := randomBase32(32)
	if err != nil {
		return nil, err
	}
	uc := usercode.Generate()
	capsJSON := mustMarshalJSON(in.Capabilities)

	code := &device_flow_entity.DeviceFlowCode{
		DeviceCode:         dc,
		UserCode:           uc,
		DeviceKind:         in.DeviceKind,
		ClientFingerprint:  in.Fingerprint,
		ClientCapabilities: capsJSON,
		Platform:           in.Platform,
		Version:            in.Version,
		IntervalSeconds:    int(s.cfg.PollInterval / time.Second),
		ExpiresAt:          now + s.cfg.UserCodeTTL.Milliseconds(),
		Createtime:         now,
	}
	if err := device_flow_repo.DeviceFlow().Create(ctx, code); err != nil {
		return nil, err
	}
	base := strings.TrimRight(s.cfg.VerificationURI, "/")
	return &AuthorizeOutput{
		DeviceCode:              dc,
		UserCode:                uc,
		VerificationURI:         base,
		VerificationURIComplete: base + "?user_code=" + uc,
		Interval:                int(s.cfg.PollInterval / time.Second),
		ExpiresIn:               int(s.cfg.UserCodeTTL / time.Second),
	}, nil
}

func randomBase32(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return strings.ToLower(strings.TrimRight(base32.StdEncoding.EncodeToString(buf), "=")), nil
}

func mustMarshalJSON(m map[string]bool) []byte {
	if m == nil {
		return []byte("{}")
	}
	pairs := make([]string, 0, len(m))
	for k, v := range m {
		pairs = append(pairs, fmt.Sprintf("%q:%t", k, v))
	}
	return []byte("{" + strings.Join(pairs, ",") + "}")
}

// OAuth 标准错误字面量
const (
	ErrAuthorizationPending = "authorization_pending"
	ErrSlowDown             = "slow_down"
	ErrExpiredToken         = "expired_token"
	ErrAccessDenied         = "access_denied"
	ErrInvalidGrant         = "invalid_grant"
)

// OAuthError 包装 OAuth 标准错误字面量。controller 转换为对应 HTTP 状态。
type OAuthError struct{ Code, Description string }

func (e *OAuthError) Error() string       { return fmt.Sprintf("%s: %s", e.Code, e.Description) }
func newOAuthErr(code, desc string) error { return &OAuthError{Code: code, Description: desc} }

func (s *deviceSvc) ExchangeToken(ctx context.Context, dc string) (*TokenOutput, error) {
	if dc == "" {
		return nil, newOAuthErr(ErrInvalidGrant, "missing device_code")
	}

	flow, err := device_flow_repo.DeviceFlow().FindByDeviceCode(ctx, dc)
	if err != nil {
		return nil, err
	}
	if flow == nil {
		return nil, newOAuthErr(ErrInvalidGrant, "device_code not found")
	}

	nowMs := time.Now().UnixMilli()

	if flow.IsConsumed() {
		return nil, newOAuthErr(ErrInvalidGrant, "device_code already consumed")
	}
	if flow.IsDenied() {
		return nil, newOAuthErr(ErrAccessDenied, "user denied authorization")
	}
	if flow.IsExpired(nowMs) {
		return nil, newOAuthErr(ErrExpiredToken, "device flow expired")
	}

	if !flow.NextPollAllowed(nowMs) {
		return nil, newOAuthErr(ErrSlowDown, "polling too fast")
	}
	if err := device_flow_repo.DeviceFlow().UpdateLastPolled(ctx, dc, nowMs); err != nil {
		return nil, err
	}

	if !flow.IsAuthorized() {
		return nil, newOAuthErr(ErrAuthorizationPending, "user has not approved yet")
	}

	// 已授权 → upsert device + 颁发 token
	out := &TokenOutput{}
	err = db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		txCtx := db.WithContextDB(ctx, tx)

		d := &device_entity.Device{
			UserID:       flow.AuthorizedUserID,
			Name:         flow.ClientFingerprint[:8],
			Kind:         flow.DeviceKind,
			Platform:     flow.Platform,
			Version:      flow.Version,
			Fingerprint:  flow.ClientFingerprint,
			Capabilities: flow.ClientCapabilities,
			LastSeenAt:   nowMs,
			Status:       1, // consts.ACTIVE
			Createtime:   nowMs,
			Updatetime:   nowMs,
		}
		if err := device_repo.Device().Upsert(txCtx, d); err != nil {
			return err
		}

		refreshPlain, err := randomBase32(32)
		if err != nil {
			return err
		}
		hash := sha256Hex(refreshPlain)
		token := &device_token_entity.DeviceToken{
			DeviceID:         d.ID,
			RefreshTokenHash: hash,
			RefreshExpiresAt: nowMs + s.cfg.RefreshTTL.Milliseconds(),
			Createtime:       nowMs,
		}
		if err := device_token_repo.DeviceToken().Create(txCtx, token); err != nil {
			return err
		}
		if err := device_flow_repo.DeviceFlow().MarkConsumed(txCtx, dc, nowMs); err != nil {
			return err
		}

		access, jti, err := s.signer.Sign(jwt.Claims{
			UID:  flow.AuthorizedUserID,
			DID:  d.ID,
			Kind: d.Kind,
			Caps: d.CapabilityList(),
		}, s.cfg.AccessTTL)
		if err != nil {
			return err
		}

		*out = TokenOutput{
			AccessToken:      access,
			RefreshToken:     refreshPlain,
			ExpiresIn:        int(s.cfg.AccessTTL / time.Second),
			RefreshExpiresIn: int(s.cfg.RefreshTTL / time.Second),
			DeviceID:         d.ID,
			JTI:              jti,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func (s *deviceSvc) Refresh(ctx context.Context, refreshToken string) (*TokenOutput, error) {
	if refreshToken == "" {
		return nil, newOAuthErr(ErrInvalidGrant, "missing refresh_token")
	}
	nowMs := time.Now().UnixMilli()
	hash := sha256Hex(refreshToken)

	row, err := device_token_repo.DeviceToken().FindByHash(ctx, hash)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, newOAuthErr(ErrInvalidGrant, "refresh_token not found")
	}

	if row.IsRevoked() {
		// 重放：整链 revoke
		_ = device_token_repo.DeviceToken().RevokeChain(ctx, row.DeviceID, nowMs)
		return nil, newOAuthErr(ErrInvalidGrant, "refresh token reuse detected")
	}
	if row.IsExpired(nowMs) {
		return nil, newOAuthErr(ErrInvalidGrant, "refresh_token expired")
	}

	d, err := device_repo.Device().Find(ctx, row.DeviceID)
	if err != nil {
		return nil, err
	}
	if d == nil || !d.IsActive() {
		return nil, newOAuthErr(ErrInvalidGrant, "device revoked")
	}

	out := &TokenOutput{}
	err = db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		txCtx := db.WithContextDB(ctx, tx)
		newPlain, err := randomBase32(32)
		if err != nil {
			return err
		}
		newToken := &device_token_entity.DeviceToken{
			DeviceID:         d.ID,
			RefreshTokenHash: sha256Hex(newPlain),
			RefreshExpiresAt: nowMs + s.cfg.RefreshTTL.Milliseconds(),
			RotatedFromID:    row.ID,
			Createtime:       nowMs,
		}
		if err := device_token_repo.DeviceToken().Create(txCtx, newToken); err != nil {
			return err
		}
		if err := device_token_repo.DeviceToken().Revoke(txCtx, row.ID, nowMs); err != nil {
			return err
		}
		if err := device_repo.Device().Touch(txCtx, d.ID, nowMs); err != nil {
			return err
		}

		access, jti, err := s.signer.Sign(jwt.Claims{
			UID:  d.UserID,
			DID:  d.ID,
			Kind: d.Kind,
			Caps: d.CapabilityList(),
		}, s.cfg.AccessTTL)
		if err != nil {
			return err
		}
		*out = TokenOutput{
			AccessToken:      access,
			RefreshToken:     newPlain,
			ExpiresIn:        int(s.cfg.AccessTTL / time.Second),
			RefreshExpiresIn: int(s.cfg.RefreshTTL / time.Second),
			DeviceID:         d.ID,
			JTI:              jti,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// stubs — implemented in subsequent commits
func (s *deviceSvc) Pending(_ context.Context, _ string) (*PendingInfo, error) {
	panic("not implemented")
}
func (s *deviceSvc) Approve(_ context.Context, _ string, _ int64) (string, error) {
	panic("not implemented")
}
func (s *deviceSvc) Deny(_ context.Context, _ string) error  { panic("not implemented") }
func (s *deviceSvc) Revoke(_ context.Context, _ int64) error { panic("not implemented") }
