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
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"
	"gorm.io/gorm"

	api "agentre-server/internal/api/device"
	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/model/entity/device_flow_entity"
	"agentre-server/internal/model/entity/device_token_entity"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwtblacklist"
	"agentre-server/internal/pkg/usercode"
	"agentre-server/internal/repository/device_flow_repo"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_token_repo"
	"agentre-server/internal/service/relay_svc"
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
	ListRevokedJTI(ctx context.Context, userID int64) ([]string, error)
}

// LocalPathPurger 是 Revoke 撤销一台设备时需要用到的窄接口（ISP）：只清掉该设备
// 上报的本机路径清单（工作区多端同步 R18），不需要认得 sync_svc 的其余方法。
// device_svc 不 import sync_svc——由 bootstrap 用 sync_svc.Default() 满足这个接口。
type LocalPathPurger interface {
	PurgeDeviceLocalPaths(ctx context.Context, deviceID int64) error
}

// localPathPurger 默认是空操作：未装配时（例如只跑 device flow、没有整套 bootstrap
// 的测试或调用方）Revoke 照常成功，只是不去清上报组——与 relay_svc.Default() 的
// 安全占位同一模式，不让调用方在 nil 接口上 panic。
var localPathPurger LocalPathPurger = noopLocalPathPurger{}

// SetLocalPathPurger 由 bootstrap 注入真实实现；传 nil 时恢复成空操作。
func SetLocalPathPurger(p LocalPathPurger) {
	if p == nil {
		p = noopLocalPathPurger{}
	}
	localPathPurger = p
}

type noopLocalPathPurger struct{}

func (noopLocalPathPurger) PurgeDeviceLocalPaths(context.Context, int64) error { return nil }

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

	code := &device_flow_entity.DeviceFlowCode{
		DeviceCode:        dc,
		UserCode:          uc,
		DeviceKind:        in.DeviceKind,
		ClientFingerprint: in.Fingerprint,
		Platform:          in.Platform,
		Version:           in.Version,
		IntervalSeconds:   int(s.cfg.PollInterval / time.Second),
		ExpiresAt:         now + s.cfg.UserCodeTTL.Milliseconds(),
		Createtime:        now,
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

// OAuth 标准错误字面量
const (
	ErrAuthorizationPending = "authorization_pending"
	ErrSlowDown             = "slow_down"
	ErrExpiredToken         = "expired_token"
	ErrAccessDenied         = "access_denied"
	ErrInvalidGrant         = "invalid_grant"
	// ErrUserCodeInvalid 不是 RFC 8628 的字面量，是浏览器侧 pending/approve/deny
	// 自有的错误：user_code 格式非法、查不到，或已被并发请求结算。
	// device_ctr 按它映射 code.DeviceFlowUserCodeInvalid。
	ErrUserCodeInvalid = "user_code_invalid"
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

		// 前面的 flow.IsConsumed() / IsDenied() 只是抢跑检查，这里才是真正的判定：
		// 带 consumed_at=0 AND denied_at=0 条件的 UPDATE 只会有一个并发请求改到行，
		// 竞败方回滚整个事务。用户在抢跑检查之后才提交的「拒绝」也在这里被挡住。
		//
		// 这一步排在写 devices / device_tokens 之前：竞败方在这里出局，一行也不写，
		// 不必靠回滚去擦掉已经落到 WAL 上的设备行和 token 行。
		n, err := device_flow_repo.DeviceFlow().MarkConsumed(txCtx, dc, nowMs)
		if err != nil {
			return err
		}
		if n != 1 {
			return newOAuthErr(ErrInvalidGrant, "device_code already consumed")
		}

		d := &device_entity.Device{
			UserID:      flow.AuthorizedUserID,
			Name:        flow.ClientFingerprint[:8],
			Kind:        flow.DeviceKind,
			Platform:    flow.Platform,
			Version:     flow.Version,
			Fingerprint: flow.ClientFingerprint,
			LastSeenAt:  nowMs,
			Status:      1, // consts.ACTIVE
			Createtime:  nowMs,
			Updatetime:  nowMs,
		}
		if err := device_repo.Device().Upsert(txCtx, d); err != nil {
			return err
		}

		access, jti, err := s.signer.Sign(jwt.Claims{
			UID:  flow.AuthorizedUserID,
			DID:  d.ID,
			Kind: d.Kind,
		}, s.cfg.AccessTTL)
		if err != nil {
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
			AccessJTI:        jti,
			RefreshExpiresAt: nowMs + s.cfg.RefreshTTL.Milliseconds(),
			UserAgent:        ua,
			IP:               ip,
			Createtime:       nowMs,
		}
		if err := device_token_repo.DeviceToken().Create(txCtx, token); err != nil {
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

		// 前面的 row.IsRevoked() 只是抢跑检查，这里才是真正的判定：
		// 带 revoked_at=0 条件的 UPDATE 只会有一个并发请求改到行。
		// 竞败不等于重放——赢家刚轮换完，链是健康的，此处【不】调 RevokeChain，
		// 否则客户端网络超时后的一次重试就会把用户整条链登出。
		// 真正的重放（A 换出 B 后再用 A）仍走上面 IsRevoked 分支，行为不变。
		//
		// 和 ExchangeToken 一样，这一步排在写 device_tokens 之前：竞败方在这里
		// 出局，一行也不写，不必靠回滚去擦掉一条已经落到 WAL 上的新 token。
		n, err := device_token_repo.DeviceToken().Revoke(txCtx, row.ID, nowMs)
		if err != nil {
			return err
		}
		if n != 1 {
			return newOAuthErr(ErrInvalidGrant, "refresh_token already rotated")
		}

		newPlain, err := randomBase32(32)
		if err != nil {
			return err
		}
		ip, ua := clientInfoFromCtx(ctx)
		access, jti, err := s.signer.Sign(jwt.Claims{
			UID:  d.UserID,
			DID:  d.ID,
			Kind: d.Kind,
		}, s.cfg.AccessTTL)
		if err != nil {
			return err
		}
		newToken := &device_token_entity.DeviceToken{
			DeviceID:         d.ID,
			RefreshTokenHash: sha256Hex(newPlain),
			AccessJTI:        jti,
			RefreshExpiresAt: nowMs + s.cfg.RefreshTTL.Milliseconds(),
			RotatedFromID:    row.ID,
			UserAgent:        ua,
			IP:               ip,
			Createtime:       nowMs,
		}
		if err := device_token_repo.DeviceToken().Create(txCtx, newToken); err != nil {
			return err
		}
		if err := device_repo.Device().Touch(txCtx, d.ID, nowMs); err != nil {
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
		return nil, newOAuthErr(ErrUserCodeInvalid, "malformed user_code")
	}
	flow, err := device_flow_repo.DeviceFlow().FindPendingByUserCode(ctx, norm)
	if err != nil {
		return nil, err
	}
	if flow == nil {
		return nil, newOAuthErr(ErrUserCodeInvalid, "user_code not found")
	}
	nowMs := time.Now().UnixMilli()
	if flow.IsExpired(nowMs) {
		return nil, newOAuthErr(ErrExpiredToken, "user_code expired")
	}
	return &PendingInfo{
		DeviceKind: flow.DeviceKind,
		Platform:   flow.Platform,
		Version:    flow.Version,
		ExpiresIn:  int((flow.ExpiresAt - nowMs) / 1000),
	}, nil
}

func (s *deviceSvc) Approve(ctx context.Context, userCode string, userID int64) (string, error) {
	norm, ok := usercode.Normalize(userCode)
	if !ok {
		return "", newOAuthErr(ErrUserCodeInvalid, "malformed user_code")
	}
	flow, err := device_flow_repo.DeviceFlow().FindPendingByUserCode(ctx, norm)
	if err != nil {
		return "", err
	}
	if flow == nil {
		return "", newOAuthErr(ErrUserCodeInvalid, "user_code not found")
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
		return "", newOAuthErr(ErrUserCodeInvalid, "user_code no longer approvable")
	}
	return flow.DeviceKind, nil
}

func (s *deviceSvc) Deny(ctx context.Context, userCode string) error {
	norm, ok := usercode.Normalize(userCode)
	if !ok {
		return newOAuthErr(ErrUserCodeInvalid, "malformed user_code")
	}
	n, err := device_flow_repo.DeviceFlow().Deny(ctx, norm, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	// 0 行：code 不存在、已被换取（设备其实已拿到 token）、或已拒绝。
	// 此时返回 200 是会误导人的假成功。
	if n != 1 {
		return newOAuthErr(ErrUserCodeInvalid, "user_code not found or already settled")
	}
	return nil
}

func (s *deviceSvc) Revoke(ctx context.Context, deviceID int64) error {
	nowMs := time.Now().UnixMilli()
	jtis, err := device_token_repo.DeviceToken().ListAccessJTIByDevice(ctx, deviceID)
	if err != nil {
		return err
	}
	// 把该设备已签发（含刷新轮换出的旧 access token）的 jti 全部拉黑，
	// 让在线设备撤销后立即失效（middleware.DeviceJWT 逐请求校验黑名单）。
	// TTL 取 AccessTTL+jwt.Leeway：黑名单从**撤销那一刻**起算，而 token 是从
	// **签发那一刻**起算、且 Verify 还多接受 Leeway 的时钟偏移。只取 AccessTTL
	// 时，一个刚签发就被撤销的 token（12:00 签发、12:00:05 撤销）会在
	// 12:15:05 掉出黑名单，却一直验签通过到 12:16:00——中间那段它又活了。
	// Redis 不可用时不让 DB 侧吊销失败——黑名单本身 fail-open（spec §6.5）。
	ttlSec := int((s.cfg.AccessTTL + jwt.Leeway) / time.Second)
	for _, jti := range jtis {
		_ = jwtblacklist.Add(ctx, jti, ttlSec)
	}
	if err := device_token_repo.DeviceToken().RevokeChain(ctx, deviceID, nowMs); err != nil {
		return err
	}
	if err := device_repo.Device().Revoke(ctx, deviceID, nowMs); err != nil {
		return err
	}
	// 工作区多端同步 R18：该设备上报的本机路径清单跟着一并消失。这是撤销的
	// 一个从属后果，不是撤销本身——取不到 purger 或它落库失败都不该让「设备已
	// 撤销、token 已拉黑」这个已经生效的结果回滚,只记日志。
	if err := localPathPurger.PurgeDeviceLocalPaths(ctx, deviceID); err != nil {
		logger.Ctx(ctx).Warn("device_svc.Revoke: purge reported local paths failed",
			zap.Int64("deviceId", deviceID), zap.Error(err))
	}
	return nil
}

// ListRevokedJTI 返回调用方账号（userID，跨其名下全部设备）已吊销、且签发
// 时间距今仍可能验签通过的 access token jti 全集，供 daemon 定期拉取后本地
// 生效（R4）。超出窗口的旧吊销记录交给过期兜底、这里直接不取。
//
// 窗口长度是 AccessTTL+jwt.Leeway 而不是 AccessTTL：Verify 接受 Leeway 的时钟
// 偏移，token 直到 exp+Leeway 都还验得过。只减 AccessTTL 会让每个 jti 在最后
// Leeway 秒里既已掉出这份列表、又仍被任何拉取方接受。
func (s *deviceSvc) ListRevokedJTI(ctx context.Context, userID int64) ([]string, error) {
	windowStart := time.Now().Add(-(s.cfg.AccessTTL + jwt.Leeway)).UnixMilli()
	return device_token_repo.DeviceToken().ListRevokedJTIByUser(ctx, userID, windowStart)
}

// ListUserDevices returns all devices for a user, marking the caller's row and
// reporting the real relay presence (R20) as the online state.
func (s *deviceSvc) ListUserDevices(ctx context.Context, userID, callerDeviceID int64) ([]api.ListDevicesItem, error) {
	rows, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.DeviceListFailed)
	}
	out := make([]api.ListDevicesItem, 0, len(rows))
	for _, d := range rows {
		// 浏览器是 relay 的短效调用方，不是可管理设备。旧版本遗留的 web 行也不再
		// 泄漏到设备列表。
		if d.Kind == device_entity.KindWeb {
			continue
		}
		// 在线态来自 daemon 的 Redis 中继登记（R20），不是 devices.status。
		// Redis 抖动时按离线对待（fail-open）：在线态只是列表的增强列，
		// 不应拖垮整个设备列表或 Revoke 前的归属校验（该流程也走本方法）。
		online, err := relay_svc.Default().IsDaemonOnline(ctx, userID, d.Fingerprint)
		if err != nil {
			online = false
		}
		out = append(out, api.ListDevicesItem{
			ID:           d.ID,
			Name:         d.Name,
			Kind:         d.Kind,
			Platform:     d.Platform,
			Version:      d.Version,
			Fingerprint:  d.Fingerprint,
			LastSeenAt:   d.LastSeenAt,
			Status:       d.Status,
			Online:       online,
			IsThisDevice: d.ID == callerDeviceID,
		})
	}
	return out, nil
}
