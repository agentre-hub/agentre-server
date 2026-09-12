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

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_flow_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_token_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/dberr"
	"github.com/agentre-hub/agentre-server/internal/pkg/usercode"
	"github.com/agentre-hub/agentre-server/internal/repository/device_flow_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
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
	ListUserDevices(ctx context.Context, userID, callerDeviceID int64) ([]DeviceView, error)
	// ResolveBearer 把一枚设备 access token 解析成调用方身份，见实现处说明。
	ResolveBearer(ctx context.Context, token string) (*Principal, error)
	// OwnedDevice 取一台属于该账号、且仍可用的设备。
	//
	// 查不到、不归他、已撤销三种情形一律回同一个 DeviceNotFound：对调用方是同
	// 一件事，区分它们等于告诉调用方「这台设备存在，只是不是你的」。
	OwnedDevice(ctx context.Context, userID, deviceID int64) (*device_entity.Device, error)
	// Rename 改一台设备的**账号级**备注名，交回这一改之后生效的显示名。
	//
	// 空串（或只有空白）= 清空，生效的显示名回落到设备自报的那个。归属判定与撤销、
	// 升级同一条（OwnedDevice）：只能改自己账号下、仍在用的设备。
	Rename(ctx context.Context, userID, deviceID int64, displayName string) (string, error)
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
	cfg Config
	// now 是这个服务的时钟。注入而不是就地 time.Now()，与 sync_svc / engine_svc /
	// relay_svc.framebus 同一形状：这里的判定全是「距今多久」的边界（授权码过期、
	// 刷新窗口、access token 过期），用真实时钟只断言得了区间，而区间往往恰好盖得住
	// 差一个常量的错法。
	now func() int64
}

var defaultSvc DeviceSvc

func Default() DeviceSvc     { return defaultSvc }
func SetDefault(s DeviceSvc) { defaultSvc = s }

// New 构造设备服务。
func New(cfg Config) DeviceSvc {
	return newDeviceSvc(cfg)
}
func newDeviceSvc(cfg Config) *deviceSvc {
	return &deviceSvc{cfg: cfg, now: func() int64 { return time.Now().UnixMilli() }}
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

// Rename 写账号级备注名。
//
// 写的是 display_name 而不是 name：name 是设备 claim 时自报的主机名，那台机器下一次
// 重新配对会把它原样覆盖回去（device_repo.Upsert 的赋值列里就有它），用户改的名字
// 因此活不过一次重连。两列分开之后，改名对任何一端都不再是一条会被冲掉的本地标签。
//
// 长度与空白的判定在实体上（NormalizeDisplayName），且排在归属判定之前：请求本身
// 不成立时连库都不必查。
func (s *deviceSvc) Rename(ctx context.Context, userID, deviceID int64, displayName string) (string, error) {
	name, ok := device_entity.NormalizeDisplayName(displayName)
	if !ok {
		return "", i18n.NewError(ctx, code.InvalidParameter)
	}
	d, err := s.OwnedDevice(ctx, userID, deviceID)
	if err != nil {
		return "", err
	}
	if err := device_repo.Device().UpdateDisplayName(ctx, deviceID, name, s.now()); err != nil {
		logger.Ctx(ctx).Error("device_svc.Rename: update display name failed",
			zap.Int64("deviceId", deviceID), zap.Int64("userId", userID), zap.Error(err))
		return "", i18n.NewInternalError(ctx, code.ServerError)
	}
	d.DisplayName = name
	return d.EffectiveName(), nil
}

// uniqueKeyUserCodePending 是 user_code 唯一键的名字（migrations/202609120101_initial_schema.go）。
// pending_flag 是 MySQL 表达「部分唯一索引」的写法：生成列不能带表达式排除已过期、
// 未结算的行（会撞 ERROR 3763），所以过期但还没被清理/结算的行仍会占着 user_code，
// 重新生成的码撞见它是预期内的常规碰撞，不是异常。
const uniqueKeyUserCodePending = "uk_dfc_user_code_pending"

// maxUserCodeCollisions 是同一次 Authorize 请求重新生成 user_code 的次数上限。
const maxUserCodeCollisions = 5

func (s *deviceSvc) Authorize(ctx context.Context, in AuthorizeInput) (*AuthorizeOutput, error) {
	now := s.now()
	dc, err := randomBase32(32)
	if err != nil {
		return nil, err
	}

	var uc string
	for attempt := 1; ; attempt++ {
		uc = usercode.Generate()
		flow := &device_flow_entity.DeviceFlowCode{
			DeviceCode:        dc,
			UserCode:          uc,
			DeviceKind:        in.DeviceKind,
			ClientFingerprint: in.Fingerprint,
			ClientName:        in.Name,
			Platform:          in.Platform,
			Version:           in.Version,
			IntervalSeconds:   int(s.cfg.PollInterval / time.Second),
			ExpiresAt:         now + s.cfg.FlowTTL.Milliseconds(),
			Createtime:        now,
		}
		err := device_flow_repo.DeviceFlow().Create(ctx, flow)
		if err == nil {
			break
		}
		// 只重试撞在待授权 user_code 上的碰撞；其余唯一键冲突（如 device_code）
		// 是真正的异常，照常上抛，不掩盖成一次「正常」的重试。
		if !dberr.IsDuplicateKey(err, uniqueKeyUserCodePending) {
			return nil, err
		}
		if attempt >= maxUserCodeCollisions {
			logger.Ctx(ctx).Error("device flow user_code collided too many times",
				zap.Int("attempts", attempt), zap.Error(err))
			return nil, err
		}
	}
	// user_code **不进日志**：它就是这条流程的凭据，拿到一个还没结算的 pending 码就能
	// 用自己的账号去批准它，把对方那台机器并进自己账号。摘要也不行 —— 码空间只有
	// 32^6，任何不可逆摘要都能离线穷举回来。要串起同一条流程就用 fingerprint（设备
	// 的公开身份，下面批准那条也带着它）。
	logger.Ctx(ctx).Info("device flow authorized",
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
		ExpiresIn:               int(s.cfg.FlowTTL / time.Second),
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
//
// Code 是发到线上的那个词，必须留在 RFC 8628 的词表里——agentred 只按它分支
// （cmd/agentred/login.go）。Biz 是给人看的那一层：invalid_grant 一个词底下压着
// 六种互不相干的失败，光靠 Code 说不出到底哪里不对。为零表示「按 Code 取默认
// 业务码」，映射在 device_ctr.oauthErrToHTTP。
type OAuthError struct {
	Code, Description string
	Biz               int
}

func (e *OAuthError) Error() string       { return fmt.Sprintf("%s: %s", e.Code, e.Description) }
func newOAuthErr(code, desc string) error { return &OAuthError{Code: code, Description: desc} }

// newOAuthErrBiz 在标准字面量之外再钉一个业务码，用于线上必须回同一个词、
// 但用户该看到不同说明的那些分支。
func newOAuthErrBiz(code, desc string, biz int) error {
	return &OAuthError{Code: code, Description: desc, Biz: biz}
}

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

	// 限速判定是一条条件 UPDATE，不是「先读 last_polled_at 判间隔再无条件写」：两个并发或
	// 重复的轮询打到同一行时，WHERE 里的 last_polled_at <= now-minGap 只让数据库
	// 认定的那一个改到行，另一个凭 RowsAffected==0 判 slow_down——不给它机会把
	// 「还没到点」的判断建立在自己读到的、可能已经过时的那一份状态上。
	minGapMs := int64(flow.IntervalSeconds) * 1000
	n, err := device_flow_repo.DeviceFlow().UpdateLastPolledIfDue(ctx, dc, nowMs, minGapMs)
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, newOAuthErr(ErrSlowDown, "polling too fast")
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

		// 撤销后原机重新配对：下面的 Upsert 会把同一行设备改回 active。撤销前签发的令牌行若还
		// 留着，旧 access token 会随设备复活重新解析出身份，旧 refresh token 会被当成重放把新链
		// 一起撤掉——先删掉它们，撤销才真正落在令牌上。
		previous, err := device_repo.Device().FindByFingerprint(txCtx, flow.AuthorizedUserID, flow.ClientFingerprint)
		if err != nil {
			return err
		}
		if previous != nil && !previous.IsActive() {
			if err := device_token_repo.DeviceToken().DeleteByDevice(txCtx, previous.ID); err != nil {
				return err
			}
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

		pair, err := s.issueTokenPair(txCtx, ctx, d, nowMs)
		if err != nil {
			return err
		}
		*out = *pair
		return nil
	})
	if err != nil {
		return nil, err
	}
	logger.Ctx(ctx).Info("device token exchanged", zap.Int64("userId", flow.AuthorizedUserID), zap.Int64("deviceId", out.DeviceID), zap.String("deviceKind", flow.DeviceKind), zap.String("platform", flow.Platform), zap.String("version", flow.Version))
	// 设备行是**这一刻**才建出来的，不是用户点批准那一刻：Approve 只改 device_flow_codes，
	// 行要等 daemon 下一次轮询（interval 默认 5 秒）走到这里。用户批准完立刻进设备页
	// 正好落在那个窗口里，看到的是一份不含这台机器的列表。
	//
	// 只靠 relay_svc.RegisterDaemon 那一声不够：它发生在这之后、且发在账号通道
	// 多半还在取票建连的那几秒里——信号不补发，连着之后兜底轮询又让路，于是那份空
	// 列表会一直挂到用户自己刷新。所以行一存在就说一声。
	//
	// 事务外、best-effort：广播失败只记日志，token 已经发出去了，不能因为一条信号回滚。
	accountchan_svc.BroadcastSignalBestEffort(ctx, flow.AuthorizedUserID, accountchan_svc.FrameTypeDevicePresence)
	return out, nil
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// issueTokenPair 在事务内为设备签发一对令牌并落库：两枚都是不含任何可解析内容的
// 随机串，库里只存各自的 sha256 摘要，明文只在本次响应中返回。调用方身份（账号、
// 设备、对端指纹）由 ResolveBearer 按摘要从库里查出，不再写进令牌。
//
// txCtx 用于落库，必须是事务里的那个；IP / UA 仍从外层 ctx 取，与抽出前一致。
func (s *deviceSvc) issueTokenPair(
	txCtx, ctx context.Context, d *device_entity.Device, nowMs int64,
) (*TokenOutput, error) {
	access, err := randomBase32(32)
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
		AccessTokenHash:  sha256Hex(access),
		RefreshExpiresAt: nowMs + s.cfg.RefreshTTL.Milliseconds(),
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
	}, nil
}

func (s *deviceSvc) Refresh(ctx context.Context, refreshToken string) (*TokenOutput, error) {
	if refreshToken == "" {
		return nil, newOAuthErrBiz(ErrInvalidGrant, "missing refresh_token", code.RefreshTokenInvalid)
	}
	nowMs := s.now()
	hash := sha256Hex(refreshToken)

	row, err := device_token_repo.DeviceToken().FindByHash(ctx, hash)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, newOAuthErrBiz(ErrInvalidGrant, "refresh_token not found", code.RefreshTokenInvalid)
	}

	d, err := device_repo.Device().Find(ctx, row.DeviceID)
	if err != nil {
		return nil, err
	}
	// 行不见了和「行还在、但已撤销」不是同一件事：前者是数据不一致，后者是用户
	// 自己在控制台点的。压成同一个码，排查时就分不出来了。
	if d == nil {
		return nil, newOAuthErrBiz(ErrInvalidGrant, "device not found", code.DeviceNotFound)
	}
	// 设备撤销是终态判定，排在这枚具体 refresh token 的状态之前：Revoke → RevokeChain
	// 会把整条链的每一行都标 revoked_at，此后无论拿链上哪一枚（当前的、还是早先轮换
	// 出去的旧的）来刷新，答案都必须是同一个 DeviceRevoked——而不是被 RevokeChain
	// 自己留下的 revoked_at 误判成「重放」。真正的重放检测只在设备仍然 active 时才
	// 有意义：那时一枚已被标 revoked 的 token 不是撤销的连带效果，而是凭据泄露的证据。
	if !d.IsActive() {
		return nil, newOAuthErrBiz(ErrInvalidGrant, "device revoked", code.DeviceRevoked)
	}

	if row.IsRevoked() {
		// 重放：整链 revoke
		_ = device_token_repo.DeviceToken().RevokeChain(ctx, row.DeviceID, nowMs)
		return nil, newOAuthErrBiz(ErrInvalidGrant, "refresh token reuse detected", code.RefreshTokenReplay)
	}
	if row.IsExpired(nowMs) {
		return nil, newOAuthErrBiz(ErrInvalidGrant, "refresh_token expired", code.RefreshTokenExpired)
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
			return newOAuthErrBiz(ErrInvalidGrant, "refresh_token already rotated", code.RefreshTokenInvalid)
		}

		pair, err := s.issueTokenPair(txCtx, ctx, d, nowMs)
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
	logger.Ctx(ctx).Info("device token refreshed", zap.Int64("userId", d.UserID), zap.Int64("deviceId", out.DeviceID), zap.String("deviceKind", d.Kind), zap.Int64("rotatedFromId", row.ID))
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
	// 不带 user_code（理由在 Authorize 那条日志上）。批准这条尤其不能带：走到这里说明
	// 它此刻正是一个有效的 pending 码。fingerprint 顶上它的位置，与签发那条同名。
	logger.Ctx(ctx).Info("device flow approved", zap.Int64("userId", userID),
		zap.String("fingerprint", flow.ClientFingerprint), zap.String("deviceKind", flow.DeviceKind),
		zap.String("platform", flow.Platform), zap.String("version", flow.Version))
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
	// 同样不带 user_code（理由在 Authorize 那条日志上）。这一路手里只有码本身，所以
	// 这条日志只说「有一个码被拒了」——比在日志里留一枚可用凭据划算。
	logger.Ctx(ctx).Info("device flow denied")
	return nil
}

func (s *deviceSvc) Revoke(ctx context.Context, deviceID int64) error {
	nowMs := s.now()
	// 撤销立即生效靠的是这里落库的设备状态：ResolveBearer 逐请求查它，该设备名下全部
	// access token（含刷新轮换出的旧令牌）当场解析不出身份，已建好的中继连接由 connguard
	// 的心跳复查断开。判据全在 MySQL，不写也不读 Redis。
	if err := device_token_repo.DeviceToken().RevokeChain(ctx, deviceID, nowMs); err != nil {
		return err
	}
	if err := device_repo.Device().Revoke(ctx, deviceID, nowMs); err != nil {
		return err
	}
	// 以下两步都是撤销的**从属后果**，不是撤销本身：取不到 purger、查不到设备行、
	// 或落库失败，都不该让「设备与刷新链已撤销」这个已经生效的结果回滚，
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

// DeviceView 是设备列表里的一行，**服务层自己的形状**。
//
// 刻意不用 internal/api/device 的响应 DTO：那个类型带着 json tag，是某个端点的传输
// 形状，把它当服务层返回值等于让「改一个 tag」变成「改服务层签名」。wire 形状归 api
// 层，由 controller 做这层映射（见 device_ctr 的 toListDevicesItem）。
//
// DaemonCommit / DaemonBuildKnown 的语义（空串不等于开发构建，见决策 19）在 wire 那一
// 侧解释，这里只是搬运。
type DeviceView struct {
	ID int64
	// Name 是设备自报的名字（通常是主机名），DisplayName 是用户设的账号级备注名，
	// 空串 = 没设过。两格都交出去：消费端按「有备注名用备注名，没有回落 Name」渲染，
	// 而改名界面要拿 Name 当占位符、拿 DisplayName 当输入框的当前值。
	Name             string
	DisplayName      string
	Kind             string
	Platform         string
	Version          string
	Fingerprint      string
	LastSeenAt       int64
	Status           int
	Online           bool
	IsThisDevice     bool
	ProtocolMismatch bool
	DaemonCommit     string
	DaemonBuildKnown bool
}

// daemonPresenceBatch 是设备列表对中继在线态的全部需要（ISP/DIP）：一批机器一次读完。
// relay_svc 的真实实现结构性满足它；它刻意不进 relay_svc.RelaySvc——那个接口的占位
// 实现与其余消费方只认逐台的 IsDaemonOnline。
type daemonPresenceBatch interface {
	DaemonsOnline(ctx context.Context, accountID int64, fingerprints []string) ([]bool, error)
}

// handshakeStateBatch 是设备列表对镜像握手状态（协议不匹配、自报的短 commit）的全部
// 需要：一批机器一次读完。mirror_svc.Supervisor 满足它，nil 接收者同样作答。
type handshakeStateBatch interface {
	HandshakeStates(ctx context.Context, userID int64, fingerprints []string) []mirror_svc.HandshakeState
}

// ListUserDevices returns all devices for a user, marking the caller's row and
// reporting the real relay presence (R20) as the online state.
//
// 每台机器的在线态与握手状态各由一次批量读取答完，Redis 往返次数与设备台数无关
// （db-perf-fixes 决策 9）。
func (s *deviceSvc) ListUserDevices(ctx context.Context, userID, callerDeviceID int64) ([]DeviceView, error) {
	rows, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.DeviceListFailed)
	}
	fingerprints := make([]string, len(rows))
	for i, d := range rows {
		fingerprints[i] = d.Fingerprint
	}
	online := daemonsOnline(ctx, userID, fingerprints)
	// 协议不匹配是镜像握手记下的共享状态（mirror_svc 决策 14）；短 commit 同样来自
	// 握手（决策 5：commit 为空的机器显示为开发构建、永不劝升），Known 是「知不知道」
	// ——没握过手时不能把「没有答案」读成「commit 为空」。未装配镜像时
	// mirror_svc.Default() 为 nil，HandshakeStates 自己对 nil 接收者兜底，与在线态同一
	// fail-open 习惯。
	var handshakes handshakeStateBatch = mirror_svc.Default()
	states := handshakes.HandshakeStates(ctx, userID, fingerprints)
	out := make([]DeviceView, 0, len(rows))
	for i, d := range rows {
		out = append(out, DeviceView{
			ID:               d.ID,
			Name:             d.Name,
			DisplayName:      d.DisplayName,
			Kind:             d.Kind,
			Platform:         d.Platform,
			Version:          d.Version,
			Fingerprint:      d.Fingerprint,
			LastSeenAt:       d.LastSeenAt,
			Status:           d.Status,
			Online:           online[i],
			IsThisDevice:     d.ID == callerDeviceID,
			ProtocolMismatch: states[i].ProtocolMismatch,
			DaemonCommit:     states[i].DaemonCommit,
			DaemonBuildKnown: states[i].DaemonBuildKnown,
		})
	}
	return out, nil
}

// daemonsOnline 读一批机器的中继在线态，与 fingerprints 逐格对应。
//
// 在线态来自 daemon 的 Redis 中继登记（R20），不是 devices.status。Redis 抖动时按离线
// 对待（fail-open）：在线态只是列表的增强列，不应拖垮整个设备列表——读不出来的那几格
// 已经答离线，错误本身在这里丢弃。未装配中继时 relay_svc.Default() 是占位实现、
// 答不了批量，同样一律离线。
func daemonsOnline(ctx context.Context, userID int64, fingerprints []string) []bool {
	batch, ok := relay_svc.Default().(daemonPresenceBatch)
	if !ok {
		return make([]bool, len(fingerprints))
	}
	online, _ := batch.DaemonsOnline(ctx, userID, fingerprints)
	return online
}
