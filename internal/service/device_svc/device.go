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

	api "github.com/agentre-hub/agentre-server/internal/api/device"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_flow_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_token_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/usercode"
	"github.com/agentre-hub/agentre-server/internal/repository/device_flow_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
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
	// OwnedDevice 取一台属于该账号、且仍可用的设备。
	//
	// 查不到、不归他、已撤销三种情形一律回同一个 DeviceNotFound：对调用方是同
	// 一件事，区分它们等于告诉调用方「这台设备存在，只是不是你的」。
	OwnedDevice(ctx context.Context, userID, deviceID int64) (*device_entity.Device, error)
}

// DeviceDataPurger 是 Revoke 撤销一台设备时需要用到的窄接口（ISP）：只清掉「这台
// 设备不在了就没有意义」的那些数据，不需要认得 sync_svc 的其余方法。
// device_svc 不 import sync_svc——由 bootstrap 用 sync_svc.Default() 满足这个接口。
//
// 两件事的归属维度不同，因此是两个方法而不是一个：上报组按 device_id 分命名空间
// （R18），账号级同步对象按（账号, agentred 指纹）圈定（R14）。
type DeviceDataPurger interface {
	// PurgeDeviceLocalPaths 清掉该设备上报的本机路径清单（R18）。
	PurgeDeviceLocalPaths(ctx context.Context, deviceID int64) error
	// PurgeDeviceSyncObjects 把只属于这台机器的账号级同步对象（指向它的 agent
	// backend、它上面的项目路径）落墓碑。
	PurgeDeviceSyncObjects(ctx context.Context, userID int64, fingerprint string) error
	// PurgeDeviceDeleteTodos 清掉挂在这台机器上、永远执行不了的会话删除待办
	// （会话镜像决策 7）。删除一条对话时机器要是离线，server 那份当场清掉、给那台
	// 机器留一条待办等它回来补删；设备被撤销之后它再也不会替这个账号执行任何东西，
	// 那条指令因此没有意义。账号里那些对话本身不动——留着、读得到、此后只读。
	PurgeDeviceDeleteTodos(ctx context.Context, userID int64, fingerprint string) error
}

// deviceDataPurger 默认是空操作：未装配时（例如只跑 device flow、没有整套 bootstrap
// 的测试或调用方）Revoke 照常成功，只是不去清——与 relay_svc.Default() 的
// 安全占位同一模式，不让调用方在 nil 接口上 panic。
var deviceDataPurger DeviceDataPurger = noopDeviceDataPurger{}

// SetDeviceDataPurger 由 bootstrap 注入真实实现；传 nil 时恢复成空操作。
func SetDeviceDataPurger(p DeviceDataPurger) {
	if p == nil {
		p = noopDeviceDataPurger{}
	}
	deviceDataPurger = p
}

type noopDeviceDataPurger struct{}

func (noopDeviceDataPurger) PurgeDeviceLocalPaths(context.Context, int64) error { return nil }

func (noopDeviceDataPurger) PurgeDeviceSyncObjects(context.Context, int64, string) error {
	return nil
}

func (noopDeviceDataPurger) PurgeDeviceDeleteTodos(context.Context, int64, string) error {
	return nil
}

type deviceSvc struct {
	cfg    Config
	signer Signer
	// now 是这个服务的时钟。注入而不是就地 time.Now()，与 sync_svc / engine_svc /
	// relay_svc.framebus 同一形状：这里的判定全是「距今多久」的边界（授权码过期、
	// 刷新窗口、吊销列表窗口），用真实时钟只断言得了区间，而区间往往恰好盖得住
	// 差一个常量的错法。
	now func() int64
}

var defaultSvc DeviceSvc

func Default() DeviceSvc     { return defaultSvc }
func SetDefault(s DeviceSvc) { defaultSvc = s }

func New(cfg Config, signer Signer) DeviceSvc { return newDeviceSvc(cfg, signer) }
func newDeviceSvc(cfg Config, signer Signer) *deviceSvc {
	return &deviceSvc{cfg: cfg, signer: signer, now: func() int64 { return time.Now().UnixMilli() }}
}

func (s *deviceSvc) OwnedDevice(ctx context.Context, userID, deviceID int64) (*device_entity.Device, error) {
	d, err := device_repo.Device().Find(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	if !d.UsableBy(userID) {
		return nil, i18n.NewNotFoundError(ctx, code.DeviceNotFound)
	}
	return d, nil
}

func (s *deviceSvc) Authorize(ctx context.Context, in AuthorizeInput) (*AuthorizeOutput, error) {
	now := s.now()
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
		ClientName:        in.Name,
		Platform:          in.Platform,
		Version:           in.Version,
		IntervalSeconds:   int(s.cfg.PollInterval / time.Second),
		ExpiresAt:         now + s.cfg.UserCodeTTL.Milliseconds(),
		Createtime:        now,
	}
	if err := device_flow_repo.DeviceFlow().Create(ctx, code); err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("device flow authorized", zap.String("userCode", uc),
		zap.String("deviceKind", in.DeviceKind), zap.String("platform", in.Platform),
		zap.String("version", in.Version), zap.String("fingerprint", in.Fingerprint),
		zap.String("clientName", in.Name))
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

	nowMs := s.now()

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
			Name:        device_entity.DisplayName(flow.ClientName, flow.ClientFingerprint),
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

		// 首次签发，没有被轮换掉的前一条，rotatedFromID 传 0。
		pair, err := s.issueTokenPair(txCtx, ctx, d, nowMs, 0)
		if err != nil {
			return err
		}
		*out = *pair
		return nil
	})
	if err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("device token exchanged", zap.Int64("userId", flow.AuthorizedUserID), zap.Int64("deviceId", out.DeviceID), zap.String("deviceKind", flow.DeviceKind), zap.String("platform", flow.Platform), zap.String("version", flow.Version), zap.String("jti", out.JTI))
	return out, nil
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// issueTokenPair 在事务内为设备签发一对令牌并落库：access token 由 signer 签出，
// refresh token 只有哈希入库、明文仅在这一次响应里回给客户端。rotatedFromID 为 0
// 表示首次签发（ExchangeToken），非 0 时是这次刷新轮换掉的那条 token 行（Refresh）。
//
// txCtx 用于落库，必须是事务里的那个；IP / UA 仍从外层 ctx 取，与抽出前一致。
func (s *deviceSvc) issueTokenPair(
	txCtx, ctx context.Context, d *device_entity.Device, nowMs, rotatedFromID int64,
) (*TokenOutput, error) {
	access, jti, err := s.signer.Sign(jwt.Claims{
		UID: d.UserID,
		DID: d.ID,
		// 对端身份签进凭据（决策 8）：agentred 的 auth.account 从这里取，不再采信
		// 请求体里的自报指纹。设备这一侧填的就是它自己那条 devices.fingerprint。
		PFP:  d.Fingerprint,
		Kind: d.Kind,
	}, s.cfg.AccessTTL)
	if err != nil {
		return nil, err
	}

	refreshPlain, err := randomBase32(32)
	if err != nil {
		return nil, err
	}
	ip, ua := clientInfoFromCtx(ctx)
	token := &device_token_entity.DeviceToken{
		DeviceID:         d.ID,
		RefreshTokenHash: sha256Hex(refreshPlain),
		AccessJTI:        jti,
		RefreshExpiresAt: nowMs + s.cfg.RefreshTTL.Milliseconds(),
		RotatedFromID:    rotatedFromID,
		UserAgent:        ua,
		IP:               ip,
		Createtime:       nowMs,
	}
	if err := device_token_repo.DeviceToken().Create(txCtx, token); err != nil {
		return nil, err
	}

	return &TokenOutput{
		AccessToken:      access,
		RefreshToken:     refreshPlain,
		ExpiresIn:        int(s.cfg.AccessTTL / time.Second),
		RefreshExpiresIn: int(s.cfg.RefreshTTL / time.Second),
		DeviceID:         d.ID,
		JTI:              jti,
	}, nil
}

func (s *deviceSvc) Refresh(ctx context.Context, refreshToken string) (*TokenOutput, error) {
	if refreshToken == "" {
		return nil, newOAuthErr(ErrInvalidGrant, "missing refresh_token")
	}
	nowMs := s.now()
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

		pair, err := s.issueTokenPair(txCtx, ctx, d, nowMs, row.ID)
		if err != nil {
			return err
		}
		if err := device_repo.Device().Touch(txCtx, d.ID, nowMs); err != nil {
			return err
		}

		*out = *pair
		return nil
	})
	if err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("device token refreshed", zap.Int64("userId", d.UserID), zap.Int64("deviceId", out.DeviceID), zap.String("deviceKind", d.Kind), zap.String("jti", out.JTI), zap.Int64("rotatedFromId", row.ID))
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
	nowMs := s.now()
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
	nowMs := s.now()
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
	logger.Ctx(ctx).Info("device flow approved", zap.Int64("userId", userID), zap.String("userCode", norm), zap.String("deviceKind", flow.DeviceKind), zap.String("platform", flow.Platform), zap.String("version", flow.Version))
	return flow.DeviceKind, nil
}

func (s *deviceSvc) Deny(ctx context.Context, userCode string) error {
	norm, ok := usercode.Normalize(userCode)
	if !ok {
		return newOAuthErr(ErrUserCodeInvalid, "malformed user_code")
	}
	n, err := device_flow_repo.DeviceFlow().Deny(ctx, norm, s.now())
	if err != nil {
		return err
	}
	// 0 行：code 不存在、已被换取（设备其实已拿到 token）、或已拒绝。
	// 此时返回 200 是会误导人的假成功。
	if n != 1 {
		return newOAuthErr(ErrUserCodeInvalid, "user_code not found or already settled")
	}
	logger.Ctx(ctx).Info("device flow denied", zap.String("userCode", norm))
	return nil
}

func (s *deviceSvc) Revoke(ctx context.Context, deviceID int64) error {
	nowMs := s.now()
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
	// 以下两步都是撤销的**从属后果**，不是撤销本身：取不到 purger、查不到设备行、
	// 或落库失败，都不该让「设备已撤销、token 已拉黑」这个已经生效的结果回滚，
	// 一律只记日志（与既有的 PurgeDeviceLocalPaths 同一失效方向）。
	//
	// 工作区多端同步 R18：该设备上报的本机路径清单跟着一并消失。
	if err := deviceDataPurger.PurgeDeviceLocalPaths(ctx, deviceID); err != nil {
		logger.Ctx(ctx).Warn("device_svc.Revoke: purge reported local paths failed",
			zap.Int64("deviceId", deviceID), zap.Error(err))
	}
	s.purgeDeviceScopedData(ctx, deviceID)
	return nil
}

// purgeDeviceScopedData 让「只属于这台设备」的东西跟着它一起离开账号：它的 CLI 路径
// 覆盖与它上面的项目路径（落墓碑，取值见 sync_svc.deviceScopedKinds），以及挂在它上面、
// 此后永远执行不了的会话删除待办（直接清掉，会话镜像决策 7）。工作区不动——projects /
// agents / departments 一行也不碰，它们属于账号而不属于某台机器；账号里那些已保存的
// 对话同样留着，只是变成只读。
//
// **指向它的 agent backend 也不在此列**，尽管后端现在明确带着自己的运行设备：那是一份
// 可以改指到另一台机器的配置，撤销之后它在控制台里如实标成「设备已撤销」等着用户改指
// （规格 2026-08-21 决策 8），替用户删掉才是丢东西。
//
// 这里要多读一次 devices：这两件事都按（账号, agentred 指纹）圈定，而 Revoke 的入参
// 只有 deviceID，回答不了「哪个账号、哪台机器」。读不到就跳过——绝不能拿一个空指纹
// 去清，那会命中账号下每一行没写机器的同类对象。
func (s *deviceSvc) purgeDeviceScopedData(ctx context.Context, deviceID int64) {
	d, err := device_repo.Device().Find(ctx, deviceID)
	if err != nil || d == nil {
		logger.Ctx(ctx).Warn("device_svc.Revoke: cannot resolve the revoked device, skipping account-level purge",
			zap.Int64("deviceId", deviceID), zap.Error(err))
		return
	}
	if err := deviceDataPurger.PurgeDeviceSyncObjects(ctx, d.UserID, d.Fingerprint); err != nil {
		logger.Ctx(ctx).Warn("device_svc.Revoke: purge device-scoped sync objects failed",
			zap.Int64("deviceId", deviceID), zap.Int64("userId", d.UserID), zap.Error(err))
	}
	// 两件清理互不牵连：上一件失败了，这一件照样要发生。
	if err := deviceDataPurger.PurgeDeviceDeleteTodos(ctx, d.UserID, d.Fingerprint); err != nil {
		logger.Ctx(ctx).Warn("device_svc.Revoke: purge pending session deletes failed",
			zap.Int64("deviceId", deviceID), zap.Int64("userId", d.UserID), zap.Error(err))
	}
}

// ListRevokedJTI 返回调用方账号（userID，跨其名下全部设备）已吊销、且签发
// 时间距今仍可能验签通过的 access token jti 全集，供 daemon 定期拉取后本地
// 生效（R4）。超出窗口的旧吊销记录交给过期兜底、这里直接不取。
//
// 窗口长度是 AccessTTL+jwt.Leeway 而不是 AccessTTL：Verify 接受 Leeway 的时钟
// 偏移，token 直到 exp+Leeway 都还验得过。只减 AccessTTL 会让每个 jti 在最后
// Leeway 秒里既已掉出这份列表、又仍被任何拉取方接受。
func (s *deviceSvc) ListRevokedJTI(ctx context.Context, userID int64) ([]string, error) {
	windowStart := s.now() - (s.cfg.AccessTTL + jwt.Leeway).Milliseconds()
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
