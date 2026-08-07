// Package device_svc 编排 RFC 8628 Device Flow 与 token 生命周期。
package device_svc

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/i18n"
	"gorm.io/gorm"

	api "agentre-server/internal/api/device"
	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/device_flow_entity"
	"agentre-server/internal/model/entity/device_token_entity"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/usercode"
	"agentre-server/internal/repository/device_flow_repo"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_token_repo"
)

type DeviceSvc interface {
	Authorize(ctx context.Context, in AuthorizeInput) (*AuthorizeOutput, error)
	Pending(ctx context.Context, userCode string) (*PendingInfo, error)
	Approve(ctx context.Context, userCode string, userID int64) (kind string, err error)
	Deny(ctx context.Context, userCode string) error
	ExchangeToken(ctx context.Context, deviceCode string) (*TokenOutput, error)
	Refresh(ctx context.Context, refreshToken string) (*TokenOutput, error)
	Revoke(ctx context.Context, deviceID int64) error
	ListUserDevices(ctx context.Context, userID, callerDeviceID int64) ([]api.ListDevicesItem, error)
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

		// 前面的 flow.IsConsumed() 只是抢跑检查，这里才是真正的判定：
		// 带 consumed_at=0 条件的 UPDATE 只会有一个并发请求改到行，竞败方回滚整个事务。
		//
		// 这一步必须排在写 devices 之前。Upsert 是「先查后写」：两个并发请求若都走到
		// 那里，会双双 INSERT 同一 (user_id, fingerprint)，撞上 uk_devices_user_fingerprint
		// 唯一索引——竞败方拿到的就成了一个唯一约束错误（映射成 500），而不是约定的
		// invalid_grant。先在 flow 行上抢到判定，竞败方就在这里出局，一行也不写。
		n, err := device_flow_repo.DeviceFlow().MarkConsumed(txCtx, dc, nowMs)
		if err != nil {
			return err
		}
		if n != 1 {
			return newOAuthErr(ErrInvalidGrant, "device_code already consumed")
		}

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
		ip, ua := clientInfoFromCtx(ctx)
		token := &device_token_entity.DeviceToken{
			DeviceID:         d.ID,
			RefreshTokenHash: hash,
			RefreshExpiresAt: nowMs + s.cfg.RefreshTTL.Milliseconds(),
			UserAgent:        ua,
			IP:               ip,
			Createtime:       nowMs,
		}
		if err := device_token_repo.DeviceToken().Create(txCtx, token); err != nil {
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
		ip, ua := clientInfoFromCtx(ctx)
		newToken := &device_token_entity.DeviceToken{
			DeviceID:         d.ID,
			RefreshTokenHash: sha256Hex(newPlain),
			RefreshExpiresAt: nowMs + s.cfg.RefreshTTL.Milliseconds(),
			RotatedFromID:    row.ID,
			UserAgent:        ua,
			IP:               ip,
			Createtime:       nowMs,
		}
		if err := device_token_repo.DeviceToken().Create(txCtx, newToken); err != nil {
			return err
		}
		// 前面的 row.IsRevoked() 只是抢跑检查，这里才是真正的判定：
		// 带 revoked_at=0 条件的 UPDATE 只会有一个并发请求改到行。
		// 竞败不等于重放——赢家刚轮换完，链是健康的，此处【不】调 RevokeChain，
		// 否则客户端网络超时后的一次重试就会把用户整条链登出。
		// 真正的重放（A 换出 B 后再用 A）仍走上面 IsRevoked 分支，行为不变。
		n, err := device_token_repo.DeviceToken().Revoke(txCtx, row.ID, nowMs)
		if err != nil {
			return err
		}
		if n != 1 {
			return newOAuthErr(ErrInvalidGrant, "refresh_token already rotated")
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

func (s *deviceSvc) Pending(ctx context.Context, userCode string) (*PendingInfo, error) {
	norm, ok := usercode.Normalize(userCode)
	if !ok {
		return nil, newOAuthErr("user_code_invalid", "malformed user_code")
	}
	flow, err := device_flow_repo.DeviceFlow().FindPendingByUserCode(ctx, norm)
	if err != nil {
		return nil, err
	}
	if flow == nil {
		return nil, newOAuthErr("user_code_invalid", "user_code not found")
	}
	nowMs := time.Now().UnixMilli()
	if flow.IsExpired(nowMs) {
		return nil, newOAuthErr(ErrExpiredToken, "user_code expired")
	}
	caps := map[string]bool{}
	if len(flow.ClientCapabilities) > 0 {
		_ = json.Unmarshal(flow.ClientCapabilities, &caps)
	}
	return &PendingInfo{
		DeviceKind:   flow.DeviceKind,
		Platform:     flow.Platform,
		Version:      flow.Version,
		Capabilities: caps,
		ExpiresIn:    int((flow.ExpiresAt - nowMs) / 1000),
	}, nil
}

func (s *deviceSvc) Approve(ctx context.Context, userCode string, userID int64) (string, error) {
	norm, ok := usercode.Normalize(userCode)
	if !ok {
		return "", newOAuthErr("user_code_invalid", "malformed user_code")
	}
	flow, err := device_flow_repo.DeviceFlow().FindPendingByUserCode(ctx, norm)
	if err != nil {
		return "", err
	}
	if flow == nil {
		return "", newOAuthErr("user_code_invalid", "user_code not found")
	}
	nowMs := time.Now().UnixMilli()
	if flow.IsExpired(nowMs) {
		return "", newOAuthErr(ErrExpiredToken, "user_code expired")
	}
	n, err := device_flow_repo.DeviceFlow().Approve(ctx, norm, userID, nowMs)
	if err != nil {
		return "", err
	}
	// 0 行：并发请求已抢先批准/拒绝/换取，这一次批准没有生效
	if n != 1 {
		return "", newOAuthErr("user_code_invalid", "user_code no longer approvable")
	}
	return flow.DeviceKind, nil
}

func (s *deviceSvc) Deny(ctx context.Context, userCode string) error {
	norm, ok := usercode.Normalize(userCode)
	if !ok {
		return newOAuthErr("user_code_invalid", "malformed user_code")
	}
	n, err := device_flow_repo.DeviceFlow().Deny(ctx, norm, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	// 0 行：code 不存在、已被换取（设备其实已拿到 token）、或已拒绝。
	// 此时返回 200 是会误导人的假成功。
	if n != 1 {
		return newOAuthErr("user_code_invalid", "user_code not found or already settled")
	}
	return nil
}

func (s *deviceSvc) Revoke(ctx context.Context, deviceID int64) error {
	nowMs := time.Now().UnixMilli()
	if err := device_token_repo.DeviceToken().RevokeChain(ctx, deviceID, nowMs); err != nil {
		return err
	}
	return device_repo.Device().Revoke(ctx, deviceID, nowMs)
}

// ListUserDevices returns all devices for a user, marking the caller's row
// and decoding the Capabilities JSON column into a map.
func (s *deviceSvc) ListUserDevices(ctx context.Context, userID, callerDeviceID int64) ([]api.ListDevicesItem, error) {
	rows, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.DeviceListFailed)
	}
	out := make([]api.ListDevicesItem, 0, len(rows))
	for _, d := range rows {
		caps := map[string]bool{}
		if len(d.Capabilities) > 0 {
			_ = json.Unmarshal(d.Capabilities, &caps)
		}
		out = append(out, api.ListDevicesItem{
			ID:           d.ID,
			Name:         d.Name,
			Kind:         d.Kind,
			Platform:     d.Platform,
			Version:      d.Version,
			Fingerprint:  d.Fingerprint,
			Capabilities: caps,
			LastSeenAt:   d.LastSeenAt,
			Status:       d.Status,
			IsThisDevice: d.ID == callerDeviceID,
		})
	}
	return out, nil
}
