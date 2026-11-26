// Package personal_token_svc 管理个人 token 的创建、轮换、列表、吊销，以及把一枚个人 token
// 解析成调用方身份（规格 2026-11-25-agrctl-account-peer「个人 token 与范围」）。
//
// 管理只认人：浏览器会话或 `cli` 设备（agrctl 登录态）。个人 token 自己不能管理 token——
// 否则一枚泄露的 token 就能给自己续命、给自己加范围。
package personal_token_svc

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/personal_token_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/dberr"
	"github.com/agentre-hub/agentre-server/internal/pkg/hashutil"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/personal_token_repo"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

const (
	// TokenPrefix 是个人 token 明文的固定前缀：一眼认得出是什么（也方便密钥扫描），解析时
	// 不带它的串不必去查库。前缀之后是 32 字节随机数的 base64url（无填充）。
	TokenPrefix = "agr_pat_"
	// secretBytes 是密钥随机部分的字节数。
	secretBytes = 32
	// handlePrefix 是个人 token 凭据句柄的前缀，后接 personal_tokens.id。长连接守卫据此认出
	// 这条连接背后是一枚个人 token，而不是中继票据。
	handlePrefix = "pat:"
	// peerFingerprintPrefix 是个人 token 对端指纹的前缀，后接 16 字节随机数的十六进制。
	peerFingerprintPrefix = "pat:"
	// lastUsedResolution 是「最近使用时间」的精度：同一枚 token 在这段时间里再被用到不再
	// 写库，免得每个请求都落一次 UPDATE。
	lastUsedResolution = time.Minute
	// maxLifetimeSeconds 是显式期限的上限（100 年）：只为让毫秒换算不溢出，真想要更久就用
	// 永不过期。
	maxLifetimeSeconds = int64(100 * 365 * 24 * 3600)
)

// uniqueNameIndex 是「账号内名字唯一」的那个唯一键。
const uniqueNameIndex = "uk_personal_tokens_user_name"

// Caller 是管理请求的调用方，取自鉴权中间件放进上下文的身份。浏览器会话没有设备号与
// 设备形态（DeviceID 0、Kind 空串）。
type Caller struct {
	AccountID int64
	DeviceID  int64
	Kind      string
	// Handle 是凭据句柄（ResolveBearer 交出的那个）；只有 Self 用它认出「这枚 token」。
	Handle string
}

// isHuman 判定调用方能不能管理 token：浏览器会话，或 `cli` 设备。个人 token、桌面、
// agentred 与其它任何凭据都不行。
func (c Caller) isHuman() bool {
	if c.AccountID == 0 {
		return false
	}
	return (c.DeviceID == 0 && c.Kind == "") || c.Kind == device_entity.KindCLI
}

// Lifetime 是调用方要的期限：零值 = 没指定（创建取默认 30 天，轮换沿用原规则）；
// Never = 永不过期；Seconds > 0 = 从现在起这么多秒。两者同时给、或 Seconds 为负都无效。
type Lifetime struct {
	Seconds int64
	Never   bool
}

// resolve 把期限换成期限规则（毫秒，0 = 永不过期）。fallback 是没指定时的规则。
func (l Lifetime) resolve(fallbackMs int64) (int64, bool) {
	switch {
	case l.Never && l.Seconds != 0, l.Seconds < 0, l.Seconds > maxLifetimeSeconds:
		return 0, false
	case l.Never:
		return 0, true
	case l.Seconds > 0:
		return l.Seconds * 1000, true
	default:
		return fallbackMs, true
	}
}

type CreateInput struct {
	Name     string
	Scopes   []string
	Lifetime Lifetime
}

type RotateInput struct {
	Name     string
	Lifetime Lifetime
}

// TokenView 是一枚 token 可以展示的全部事实；不含密钥，也不含摘要。时间都是 unix 毫秒，
// ExpiresAt 为 0 表示永不过期，LastUsedAt / RotatedAt 为 0 表示从没用过 / 从没轮换过。
type TokenView struct {
	Name       string
	Scopes     []string
	Createtime int64
	ExpiresAt  int64
	LastUsedAt int64
	RotatedAt  int64
	// CreatedByDeviceID 是创建它的设备；浏览器会话创建的为 0。CreatedByDeviceName 是那台
	// 设备此刻的显示名，设备已撤销时为空串。
	CreatedByDeviceID   int64
	CreatedByDeviceName string
	// PeerFingerprint 是这枚 token 的对端指纹（它发起的会话记在这个发起方名下）。只有 Self
	// 与 List 填它：token 据此认出自己发起的会话，列表的调用方据它把会话发起方认成 token 名。
	PeerFingerprint string
}

// Issued 是创建或轮换的结果：Token 是密钥明文，只在这一次交出，server 不保存它。
type Issued struct {
	Token string
	TokenView
}

type PersonalTokenSvc interface {
	// Create 创建一枚 token。名字在账号内已被占用时答 409。
	Create(ctx context.Context, caller Caller, in CreateInput) (*Issued, error)
	// Rotate 给同名 token 换一个新密钥：名字、范围、对端指纹不变，旧密钥立即作废。
	Rotate(ctx context.Context, caller Caller, in RotateInput) (*Issued, error)
	List(ctx context.Context, caller Caller) ([]TokenView, error)
	// Delete 吊销（删除）同名 token，在 HTTP 上立即生效。
	Delete(ctx context.Context, caller Caller, name string) error
	// ResolveBearer 把一枚个人 token 明文解析成调用方身份；不是个人 token、未知、已过期
	// 一律 device_svc.ErrBearerInvalid。
	ResolveBearer(ctx context.Context, token string) (*device_svc.Principal, error)
	// WatchRelayCredential 给一条以个人 token 建好的中继连接返回撤销判定，见实现处说明。
	WatchRelayCredential(ctx context.Context, accountID int64, handle string) func(context.Context) bool
}

// SelfSvc 是「个人 token 查自己」这一个角色，与管理接口分开：调用方不同（只有个人 token），
// 使用者也不同（whoami）。Self 交出调用方那枚个人 token 自己的事实（无密钥）；浏览器会话与
// 设备答 403——它们有 List；行已被吊销或不归这个账号答 404。
type SelfSvc interface {
	Self(ctx context.Context, caller Caller) (TokenView, error)
}

var defaultSvc PersonalTokenSvc = New()

// DefaultSelf 是进程默认的 SelfSvc。
func DefaultSelf() SelfSvc { return New() }

func Default() PersonalTokenSvc     { return defaultSvc }
func SetDefault(s PersonalTokenSvc) { defaultSvc = s }

type personalTokenSvc struct {
	now func() int64
}

func New() *personalTokenSvc {
	return &personalTokenSvc{now: func() int64 { return time.Now().UnixMilli() }}
}

// IsHandle 报告一个凭据句柄是不是个人 token 的。
func IsHandle(handle string) bool { return strings.HasPrefix(handle, handlePrefix) }

func handleOf(id int64) string { return handlePrefix + strconv.FormatInt(id, 10) }

func (s *personalTokenSvc) Create(ctx context.Context, caller Caller, in CreateInput) (*Issued, error) {
	if !caller.isHuman() {
		return nil, i18n.NewForbiddenError(ctx, code.Forbidden)
	}
	name, err := personal_token_entity.NormalizeName(in.Name)
	if err != nil {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	scopes, err := personal_token_entity.NormalizeScopes(in.Scopes)
	if err != nil {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	lifetimeMs, ok := in.Lifetime.resolve(personal_token_entity.DefaultLifetime.Milliseconds())
	if !ok {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}

	repo := personal_token_repo.PersonalToken()
	existing, err := repo.FindByName(ctx, caller.AccountID, name)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, nameTaken(ctx)
	}
	token, hash, err := newSecret()
	if err != nil {
		return nil, err
	}
	peerFingerprint, err := newPeerFingerprint()
	if err != nil {
		return nil, err
	}
	now := s.now()
	row := &personal_token_entity.PersonalToken{
		UserID: caller.AccountID, Name: name, TokenHash: hash, PeerFingerprint: peerFingerprint,
		CreatedByDeviceID: caller.DeviceID, Createtime: now, Updatetime: now,
	}
	row.SetScopes(scopes)
	row.Renew(now, lifetimeMs)
	if err := repo.Create(ctx, row); err != nil {
		// 两个并发的同名创建都过了上面的查重，后到的那个撞唯一键：结论仍是「名字已被占用」。
		if dberr.IsDuplicateKey(err, uniqueNameIndex) {
			return nil, nameTaken(ctx)
		}
		return nil, err
	}
	logger.Ctx(ctx).Info("personal_token_svc.Create: 个人 token 已创建",
		zap.Int64("accountId", caller.AccountID), zap.String("tokenName", name),
		zap.Strings("scopes", scopes), zap.Bool("neverExpires", row.NeverExpires()))
	view, err := s.view(ctx, caller.AccountID, row)
	if err != nil {
		return nil, err
	}
	return &Issued{Token: token, TokenView: view}, nil
}

func (s *personalTokenSvc) Rotate(ctx context.Context, caller Caller, in RotateInput) (*Issued, error) {
	if !caller.isHuman() {
		return nil, i18n.NewForbiddenError(ctx, code.Forbidden)
	}
	name, err := personal_token_entity.NormalizeName(in.Name)
	if err != nil {
		return nil, i18n.NewNotFoundError(ctx, code.NotFound)
	}
	repo := personal_token_repo.PersonalToken()
	row, err := repo.FindByName(ctx, caller.AccountID, name)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, i18n.NewNotFoundError(ctx, code.NotFound)
	}
	lifetimeMs, ok := in.Lifetime.resolve(row.LifetimeMs)
	if !ok {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	token, hash, err := newSecret()
	if err != nil {
		return nil, err
	}
	now := s.now()
	prevHash := row.TokenHash
	row.TokenHash = hash
	row.RotatedAt = now
	row.Renew(now, lifetimeMs)
	affected, err := repo.UpdateSecret(ctx, row, prevHash)
	if err != nil {
		return nil, err
	}
	if affected == 0 {
		// 查到之后、写入之前：被并发删掉了（404），或被另一次轮换换掉了密钥（409——那一次
		// 交出的才是有效的密钥，这一次的不能再交出去）。
		current, err := repo.FindByName(ctx, caller.AccountID, name)
		if err != nil {
			return nil, err
		}
		if current == nil {
			return nil, i18n.NewNotFoundError(ctx, code.NotFound)
		}
		return nil, i18n.NewErrorWithStatus(ctx, http.StatusConflict, code.InvalidParameter)
	}
	logger.Ctx(ctx).Info("personal_token_svc.Rotate: 个人 token 已轮换",
		zap.Int64("accountId", caller.AccountID), zap.String("tokenName", row.Name),
		zap.Bool("neverExpires", row.NeverExpires()))
	view, err := s.view(ctx, caller.AccountID, row)
	if err != nil {
		return nil, err
	}
	return &Issued{Token: token, TokenView: view}, nil
}

func (s *personalTokenSvc) List(ctx context.Context, caller Caller) ([]TokenView, error) {
	if !caller.isHuman() {
		return nil, i18n.NewForbiddenError(ctx, code.Forbidden)
	}
	rows, err := personal_token_repo.PersonalToken().ListByUser(ctx, caller.AccountID)
	if err != nil {
		return nil, err
	}
	views, err := s.views(ctx, caller.AccountID, rows)
	if err != nil {
		return nil, err
	}
	// 管理列表带每枚 token 的对端指纹：调用方据它把会话的发起方认成 token 名。views 与 rows 同序。
	for i := range views {
		views[i].PeerFingerprint = rows[i].PeerFingerprint
	}
	return views, nil
}

func (s *personalTokenSvc) Self(ctx context.Context, caller Caller) (TokenView, error) {
	if caller.AccountID == 0 || caller.Kind != device_svc.KindPersonalToken || !IsHandle(caller.Handle) {
		return TokenView{}, i18n.NewForbiddenError(ctx, code.Forbidden)
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(caller.Handle, handlePrefix), 10, 64)
	if err != nil {
		return TokenView{}, i18n.NewForbiddenError(ctx, code.Forbidden)
	}
	row, err := personal_token_repo.PersonalToken().Find(ctx, id)
	if err != nil {
		return TokenView{}, err
	}
	if row == nil || row.UserID != caller.AccountID {
		return TokenView{}, i18n.NewNotFoundError(ctx, code.NotFound)
	}
	view, err := s.view(ctx, caller.AccountID, row)
	if err != nil {
		return TokenView{}, err
	}
	view.PeerFingerprint = row.PeerFingerprint
	return view, nil
}

func (s *personalTokenSvc) Delete(ctx context.Context, caller Caller, name string) error {
	if !caller.isHuman() {
		return i18n.NewForbiddenError(ctx, code.Forbidden)
	}
	name, err := personal_token_entity.NormalizeName(name)
	if err != nil {
		return i18n.NewNotFoundError(ctx, code.NotFound)
	}
	affected, err := personal_token_repo.PersonalToken().DeleteByName(ctx, caller.AccountID, name)
	if err != nil {
		return err
	}
	if affected == 0 {
		return i18n.NewNotFoundError(ctx, code.NotFound)
	}
	logger.Ctx(ctx).Info("personal_token_svc.Delete: 个人 token 已吊销",
		zap.Int64("accountId", caller.AccountID), zap.String("tokenName", name))
	return nil
}

// ResolveBearer 按摘要解析一枚个人 token。
//
// 有效 = 带 TokenPrefix、摘要存在（删除即吊销，轮换换掉了旧摘要）、未到期。不带前缀的串
// 不查库：组合解析方会把每一枚不认识的 Bearer 都递过来。查库失败原样上抛，不冒充成
// ErrBearerInvalid。明文只在这里哈希一次、按摘要等值查找，不进日志。
func (s *personalTokenSvc) ResolveBearer(ctx context.Context, token string) (*device_svc.Principal, error) {
	if !strings.HasPrefix(token, TokenPrefix) || len(token) == len(TokenPrefix) {
		return nil, device_svc.ErrBearerInvalid
	}
	repo := personal_token_repo.PersonalToken()
	row, err := repo.FindByHash(ctx, hashutil.SHA256Hex(token))
	if err != nil {
		return nil, err
	}
	now := s.now()
	if !row.ValidAt(now) {
		return nil, device_svc.ErrBearerInvalid
	}
	if now-row.LastUsedAt >= lastUsedResolution.Milliseconds() {
		// 最近使用时间只是展示用的事实，记不下来不影响这次鉴权。
		if err := repo.TouchLastUsed(ctx, row.ID, now); err != nil {
			logger.Ctx(ctx).Warn("personal_token_svc.ResolveBearer: 记录最近使用时间失败",
				zap.Int64("accountId", row.UserID), zap.String("tokenName", row.Name), zap.Error(err))
		}
	}
	return &device_svc.Principal{
		AccountID:       row.UserID,
		Kind:            device_svc.KindPersonalToken,
		PeerFingerprint: row.PeerFingerprint,
		ExpiresAt:       row.ExpiresAt,
		Handle:          handleOf(row.ID),
		Scopes:          row.ScopeList(),
		TokenName:       row.Name,
	}, nil
}

// WatchRelayCredential 解析一条以个人 token 建好的中继连接背后的撤销判据，返回一个可被
// 连接心跳反复调用的判定函数。handle 是 ResolveBearer 交出的那个句柄。
//
// 中继长连接只在 upgrade 那一刻过一次鉴权中间件；没有这个复查，吊销、轮换与到期就只挡得住
// 新连接。判据是「这一行还在、还归这个账号、密钥还是 upgrade 时那一枚、尚未到期」：建立时
// 记下当时的摘要，轮换换掉摘要后这条用旧密钥建的连接随之断开。
//
// 判不出来（查库失败）按不撤销处理，与设备连接的复查同一口径：那只是一次早已生效的吊销的
// 收尾，不值得为一次数据库抖动断掉所有连接。upgrade 时就查不到行的连接没有可复查的依据，
// 按已撤销处理。
func (s *personalTokenSvc) WatchRelayCredential(ctx context.Context, accountID int64, handle string) func(context.Context) bool {
	revoked := func(context.Context) bool { return true }
	id, err := strconv.ParseInt(strings.TrimPrefix(handle, handlePrefix), 10, 64)
	if !IsHandle(handle) || err != nil {
		return revoked
	}
	repo := personal_token_repo.PersonalToken()
	initial, err := repo.Find(ctx, id)
	switch {
	case err != nil:
		logger.Ctx(ctx).Warn("personal_token_svc.WatchRelayCredential: 解析个人 token 失败，"+
			"该连接吊销时将撤不掉，只靠账号闸门复查", zap.Int64("accountId", accountID), zap.Error(err))
		return func(context.Context) bool { return false }
	case initial == nil || initial.UserID != accountID:
		return revoked
	}
	hash := initial.TokenHash
	return func(ctx context.Context) bool {
		row, err := repo.Find(ctx, id)
		if err != nil {
			return false
		}
		return row == nil || row.UserID != accountID || row.TokenHash != hash || !row.ValidAt(s.now())
	}
}

// view 是单行的 views。
func (s *personalTokenSvc) view(ctx context.Context, accountID int64, row *personal_token_entity.PersonalToken) (TokenView, error) {
	views, err := s.views(ctx, accountID, []*personal_token_entity.PersonalToken{row})
	if err != nil {
		return TokenView{}, err
	}
	return views[0], nil
}

// views 把行映射成可展示的事实，创建设备的显示名按账号的在用设备一次查齐；没有行是设备
// 创建的就不查。
func (s *personalTokenSvc) views(ctx context.Context, accountID int64, rows []*personal_token_entity.PersonalToken) ([]TokenView, error) {
	names := map[int64]string{}
	for _, row := range rows {
		if row.CreatedByDeviceID == 0 {
			continue
		}
		devices, err := device_repo.Device().ListByUser(ctx, accountID)
		if err != nil {
			return nil, err
		}
		for _, d := range devices {
			names[d.ID] = d.EffectiveName()
		}
		break
	}
	out := make([]TokenView, 0, len(rows))
	for _, row := range rows {
		out = append(out, TokenView{
			Name: row.Name, Scopes: row.ScopeList(), Createtime: row.Createtime, ExpiresAt: row.ExpiresAt,
			LastUsedAt: row.LastUsedAt, RotatedAt: row.RotatedAt,
			CreatedByDeviceID: row.CreatedByDeviceID, CreatedByDeviceName: names[row.CreatedByDeviceID],
		})
	}
	return out, nil
}

func nameTaken(ctx context.Context) error {
	return i18n.NewErrorWithStatus(ctx, http.StatusConflict, code.InvalidParameter)
}

// newSecret 生成一枚新密钥，交回明文与它的 sha256 摘要。
func newSecret() (string, string, error) {
	buf := make([]byte, secretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", errors.Join(errors.New("generate personal token secret"), err)
	}
	token := TokenPrefix + base64.RawURLEncoding.EncodeToString(buf)
	return token, hashutil.SHA256Hex(token), nil
}

// newPeerFingerprint 生成一枚 token 自己的对端指纹，创建时生成一次、轮换不变。
func newPeerFingerprint() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", errors.Join(errors.New("generate personal token peer fingerprint"), err)
	}
	return peerFingerprintPrefix + hex.EncodeToString(buf), nil
}
