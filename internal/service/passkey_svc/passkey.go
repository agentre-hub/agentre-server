// Package passkey_svc 编排通行密钥（WebAuthn）的注册、登录与管理。
//
// 密码学部分一行都不自己写：attestation / COSE / CBOR 解析、origin 与 challenge 比对、
// 签名校验全部交给 github.com/go-webauthn/webauthn（决策 11）。这里只负责四件事——
// 谁能注册、状态存在哪、怎么落库、以及一把验过的密钥背后是哪个账号、那个账号还能不能用。
//
// 两步之间的 challenge 存 Redis 而不是进程内存（决策 14）：多副本部署下 begin 与
// finish 必然会落在不同副本上，进程内的 map 在第二跳一定找不到。
package passkey_svc

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/webauthn_credential_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/webauthn_credential_repo"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

const (
	// handleLen 是 WebAuthn user handle 的字节数。规范给的上限是 64，官方建议用满；
	// 32 字节已经远超任何碰撞或枚举的门槛，同时让存储列不必开到上限。
	handleLen = 32
	// MaxNameLen 是密钥名字的长度上限（字符数），与 webauthn_credentials.name 的
	// varchar(64) 对齐。
	MaxNameLen = 64
	// DefaultMaxPerAccount 是每账号的密钥数量上限缺省值。
	DefaultMaxPerAccount = 10
	// challengeTTL 是 challenge 的存活时长：够用户找出安全钥匙、插上、按一下，
	// 又不至于让一个没做完的注册在 Redis 上挂一整天。不开成配置项——它不是运维要调的
	// 旋钮，改大只会让废弃的 challenge 在 Redis 上待得更久。
	challengeTTL = 5 * time.Minute
)

// challengeKeyPrefix 按**浏览器会话**归集 challenge：注册要求已登录，一次注册只对
// 发起它的那条会话有效。按账号归集的话，同一账号的另一个浏览器能把别人开的那次
// 注册接着做完。
const challengeKeyPrefix = "webauthn_reg_challenge:"

func challengeKey(sessionID string) string { return challengeKeyPrefix + sessionID }

// loginChallengeKeyPrefix 按 **challenge 本身**归集登录的 challenge。
//
// 注册那条路上可以按会话归集，登录这条路上没有会话可用：此刻还没人登录，而这正是
// 决策 10 的要求——不要求任何标识。challenge 是服务端现生成的一段随机字节，认证器
// 会原样带回 clientDataJSON，因此它既是查询键也是那份「有没有发出过这一次」的凭据。
// 取走即删（GETDEL），重放不成立。
const loginChallengeKeyPrefix = "webauthn_login_challenge:"

func loginChallengeKey(challenge string) string { return loginChallengeKeyPrefix + challenge }

// errCredentialUnknown / errCredentialLookup 是凭证反查的两种结局。分开是因为处置
// 相反：前者是常态（密钥已被删、换了服务端），要变成一句用户看得懂的话；后者是
// 基础设施故障，只能是 500，绝不能说成「这把密钥不存在」。
var (
	errCredentialUnknown = errors.New("passkey credential belongs to no usable account")
	errCredentialLookup  = errors.New("passkey credential lookup failed")
)

// Config 是通行密钥的 Relying Party 配置。RPID 与 Origins 一律从配置来（决策 15）：
// 开发态前端在 5174、后端在 8443，e2e 又是另一组端口，只按 PublicURL 推一个
// origin 会让本地与 e2e 全部验不过。
type Config struct {
	RPID          string
	RPDisplayName string
	Origins       []string
	MaxPerAccount int
}

// Passkey 是发给前端的一条密钥。只有名字与两个时间：公钥与凭证 ID 不经由任何清单
// 端点出去。
type Passkey struct {
	ID         int64
	Name       string
	CreatedAt  int64
	LastUsedAt int64
}

// FinishRegistration 是提交认证器回应时的入参。
type FinishRegistration struct {
	UserID    int64
	SessionID string
	// Name 由用户在提交前输入，必填、限长——不从 AAGUID 猜设备型号。
	Name string
	// Response 是浏览器 navigator.credentials.create() 的回应原文（JSON）。
	Response []byte
}

type PasskeySvc interface {
	// BeginRegistration 生成注册选项并把 challenge 存进 Redis（与 sessionID 绑定）。
	BeginRegistration(ctx context.Context, userID int64, sessionID string) (json.RawMessage, error)
	// FinishRegistration 校验认证器的回应并落库。
	FinishRegistration(ctx context.Context, in FinishRegistration) (*Passkey, error)
	// BeginLogin 生成登录选项：**不要求任何标识**，allowCredentials 留空（决策 10），
	// challenge 存 Redis。
	BeginLogin(ctx context.Context) (json.RawMessage, error)
	// FinishLogin 校验认证器的回应、按凭证 ID 反查账号、过账号闸门，返回该账号 id。
	// 建立会话是调用方的事：UA 与 IP 只有 HTTP 那一层拿得到。
	FinishLogin(ctx context.Context, response []byte) (int64, error)
	// List 列出该账号全部通行密钥。
	List(ctx context.Context, userID int64) ([]Passkey, error)
	// Delete 删掉一把；允许删到零把——GitHub 登录始终是回退路径（决策 9）。
	Delete(ctx context.Context, userID, id int64) error
}

type passkeySvc struct {
	rc  *goredis.Client
	cfg Config
	wa  *webauthn.WebAuthn
	// initErr 记下 RP 配置不成立的原因。构造期不退出进程：通行密钥配错不该让设备流、
	// 中继、同步这些毫不相干的能力跟着起不来，但相关端点必须如实报错并留下日志。
	initErr error
}

var defaultSvc PasskeySvc

func Default() PasskeySvc     { return defaultSvc }
func SetDefault(s PasskeySvc) { defaultSvc = s }

// New 构造服务。缺省值就地补齐——0 上限等于谁都注册不了。
func New(rc *goredis.Client, cfg Config) PasskeySvc {
	if cfg.MaxPerAccount <= 0 {
		cfg.MaxPerAccount = DefaultMaxPerAccount
	}
	s := &passkeySvc{rc: rc, cfg: cfg}
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          cfg.RPID,
		RPDisplayName: cfg.RPDisplayName,
		RPOrigins:     cfg.Origins,
		// 不要 attestation：本服务不接 FIDO Metadata Service，要来的证书没有任何
		// 校验方，却会在部分平台上多弹一次「是否允许透露设备型号」。
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			// 可发现凭证（决策 10）：登录时不要求任何标识、allowCredentials 留空，
			// 全靠认证器自己记得住这把密钥属于谁。
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			RequireResidentKey: protocol.ResidentKeyRequired(),
			// preferred 而不是 required：required 会把没有生物识别 / PIN 的安全钥匙
			// 挡在门外，而这一步的前置条件已经是「一条已登录的浏览器会话」。
			UserVerification: protocol.VerificationPreferred,
		},
	})
	if err != nil {
		s.initErr = err
		return s
	}
	s.wa = wa
	return s
}

func (s *passkeySvc) ready(ctx context.Context) error {
	if s.wa != nil {
		return nil
	}
	logger.Ctx(ctx).Error("passkey_svc: WebAuthn RP 配置不成立，通行密钥端点全部不可用",
		zap.String("rpId", s.cfg.RPID), zap.Strings("origins", s.cfg.Origins),
		zap.Error(s.initErr))
	return i18n.NewInternalError(ctx, code.ServerError)
}

func (s *passkeySvc) BeginRegistration(ctx context.Context, userID int64, sessionID string) (
	json.RawMessage, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	if sessionID == "" {
		// challenge 与会话绑定，没有会话就无处安放这次注册。
		return nil, i18n.NewUnauthorizedError(ctx, code.Unauthorized)
	}
	// 上限先判：不能先让用户在认证器上按一遍指纹、再告诉他名额早就满了。
	if err := s.checkCap(ctx, userID); err != nil {
		return nil, err
	}
	u, exclude, err := s.registrationUser(ctx, userID)
	if err != nil {
		return nil, err
	}

	creation, session, err := s.wa.BeginRegistration(u, webauthn.WithExclusions(exclude))
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 生成注册选项失败", zap.Int64("userId", userID), zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	if err := s.storeChallenge(ctx, sessionID, session); err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 写入 challenge 失败", zap.Int64("userId", userID), zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}

	raw, err := json.Marshal(creation.Response)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return raw, nil
}

func (s *passkeySvc) FinishRegistration(ctx context.Context, in FinishRegistration) (*Passkey, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	name, err := normalizeName(ctx, in.Name)
	if err != nil {
		return nil, err
	}

	session, err := s.takeChallenge(ctx, in.SessionID)
	if err != nil {
		return nil, err
	}
	handle, err := s.handle(ctx, in.UserID)
	if err != nil {
		return nil, err
	}

	parsed, err := protocol.ParseCredentialCreationResponseBytes(in.Response)
	if err != nil {
		// 解析不了与验不过是同一类事实：认证器给的这段东西不作数。日志里留原因，
		// 回给用户的是一句人话——里面的细节对攻击者比对用户有用得多。
		logger.Ctx(ctx).Warn("passkey_svc: 认证器回应解析失败",
			zap.Int64("userId", in.UserID), zap.Error(err))
		return nil, i18n.NewError(ctx, code.PasskeyVerificationFailed)
	}
	credential, err := s.wa.CreateCredential(&webauthnUser{handle: handle}, *session, parsed)
	if err != nil {
		logger.Ctx(ctx).Warn("passkey_svc: 认证器回应校验未通过",
			zap.Int64("userId", in.UserID), zap.Error(err))
		return nil, i18n.NewError(ctx, code.PasskeyVerificationFailed)
	}

	// 再判一次上限：begin 与 finish 之间隔着用户在认证器上操作的那几秒，同一账号在
	// 另一个浏览器里完全可以把额度用满。只在 begin 判，上限就只是个建议。
	if err := s.checkCap(ctx, in.UserID); err != nil {
		return nil, err
	}

	now := time.Now().UnixMilli()
	row := &webauthn_credential_entity.WebAuthnCredential{
		UserID:         in.UserID,
		CredentialID:   credential.ID,
		PublicKey:      credential.PublicKey,
		AAGUID:         credential.Authenticator.AAGUID,
		SignCount:      credential.Authenticator.SignCount,
		Transports:     joinTransports(credential.Transport),
		Name:           name,
		BackupEligible: credential.Flags.BackupEligible,
		BackupState:    credential.Flags.BackupState,
		// LastUsedAt 留 0：刚注册的密钥一次都没用过，写成 now 会让清单显示成「刚刚用过」。
		LastUsedAt: 0,
		Createtime: now,
		Updatetime: now,
	}
	if err := webauthn_credential_repo.WebAuthnCredential().Create(ctx, row); err != nil {
		if errors.Is(err, webauthn_credential_repo.ErrCredentialTaken) {
			return nil, i18n.NewErrorWithStatus(ctx, http.StatusConflict, code.PasskeyAlreadyRegistered)
		}
		logger.Ctx(ctx).Error("passkey_svc: 通行密钥落库失败",
			zap.Int64("userId", in.UserID), zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return toPasskey(row), nil
}

func (s *passkeySvc) BeginLogin(ctx context.Context) (json.RawMessage, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	// BeginDiscoverableLogin：allowCredentials 留空，浏览器自己弹选择器（决策 10）。
	// 这一步一次库都不查——查库就意味着按某个标识找账号，而那正是这条路径要避免的
	// 账号枚举面。
	assertion, session, err := s.wa.BeginDiscoverableLogin()
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 生成登录选项失败", zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	if err := s.storeLoginChallenge(ctx, session); err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 写入登录 challenge 失败", zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	raw, err := json.Marshal(assertion.Response)
	if err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return raw, nil
}

func (s *passkeySvc) FinishLogin(ctx context.Context, response []byte) (int64, error) {
	if err := s.ready(ctx); err != nil {
		return 0, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(response)
	if err != nil {
		logger.Ctx(ctx).Warn("passkey_svc: 登录回应解析失败", zap.Error(err))
		return 0, i18n.NewError(ctx, code.PasskeyVerificationFailed)
	}

	// 先认 challenge：没有发出过这一次，就不该为它查任何一次库——否则这个端点等于
	// 一个免费的凭证探测器（伪造一段回应即可问「这把凭证在不在册」）。
	session, err := s.takeLoginChallenge(ctx, parsed.Response.CollectedClientData.Challenge)
	if err != nil {
		return 0, err
	}
	// origin 单独判一道，只为把「origin 不在允许列表」这一种失败说清楚：真正的裁决
	// 仍在下面的 ValidateDiscoverableLogin 里，判据也是同一个（库自己导出的
	// IsOriginInHaystack），这里不另写一套比较规则。
	if !protocol.IsOriginInHaystack(parsed.Response.CollectedClientData.Origin, s.cfg.Origins) {
		logger.Ctx(ctx).Warn("passkey_svc: 登录 origin 不在允许列表",
			zap.String("origin", parsed.Response.CollectedClientData.Origin))
		return 0, i18n.NewError(ctx, code.PasskeyOriginNotAllowed)
	}

	var row *webauthn_credential_entity.WebAuthnCredential
	handler := func(rawID, _ []byte) (webauthn.User, error) {
		// userHandle 与账号的对应关系由库来比（validateLogin 第 2 步拿它跟
		// WebAuthnID() 对），这里只负责按凭证 ID 把那个账号交出去。
		u, found, err := s.credentialOwner(ctx, rawID)
		if err != nil {
			return nil, err
		}
		row = found
		return u, nil
	}
	if _, err := s.wa.ValidateDiscoverableLogin(handler, *session, parsed); err != nil {
		switch {
		case errors.Is(err, errCredentialUnknown):
			return 0, i18n.NewError(ctx, code.PasskeyCredentialUnknown)
		case errors.Is(err, errCredentialLookup):
			return 0, i18n.NewInternalError(ctx, code.ServerError)
		default:
			logger.Ctx(ctx).Warn("passkey_svc: 登录回应校验未通过", zap.Error(err))
			return 0, i18n.NewError(ctx, code.PasskeyVerificationFailed)
		}
	}

	if row == nil {
		// 验签通过就一定走过 handler、row 一定有值。真出现 nil 只能是库的行为变了，
		// 那也绝不能在一个鉴权端点上以 panic 收场。
		logger.Ctx(ctx).Error("passkey_svc: 校验通过却没有取到凭证行")
		return 0, i18n.NewInternalError(ctx, code.ServerError)
	}
	if err := checkSignCount(ctx, row.SignCount, parsed.Response.AuthenticatorData.Counter); err != nil {
		logger.Ctx(ctx).Warn("passkey_svc: 签名计数器回退，拒绝这次登录",
			zap.Int64("userId", row.UserID), zap.Int64("passkeyId", row.ID),
			zap.Uint32("stored", row.SignCount),
			zap.Uint32("presented", parsed.Response.AuthenticatorData.Counter))
		return 0, err
	}
	// 账号闸门排在建立会话之前，与 GitHub 回调同一处判定：验签通过只说明密钥没问题，
	// 说明不了这个账号还能用。
	if err := gateCheck(ctx, row.UserID); err != nil {
		return 0, err
	}

	s.touch(ctx, row, parsed.Response.AuthenticatorData.Counter)
	return row.UserID, nil
}

// checkSignCount 实现决策 13：只在**双方都非零**且这次没有前进时拒绝。
//
// 同步型认证器（iCloud 钥匙串、各家密码管理器）恒返回 0，把 0 当回退会让这类密钥
// 第二次登录就失败——而它们正是绝大多数用户手里的那一种。判得出来的时候才判。
//
// 「没有前进」而不是「严格变小」：计数器每用一次必须自增，持平同样是克隆信号。
func checkSignCount(ctx context.Context, stored, presented uint32) error {
	if stored != 0 && presented != 0 && presented <= stored {
		return i18n.NewError(ctx, code.PasskeyCounterRollback)
	}
	return nil
}

// gateCheck 过账号闸门。闸门只在完整装配（bootstrap.RegisterDefaults）之后存在，
// 未装配的进程按不判定处理——与 middleware/account_gate.go 同一约定，生产上一定
// 装配这件事由 bootstrap 的单测钉住。
func gateCheck(ctx context.Context, userID int64) error {
	gate := user_svc.Gate()
	if gate == nil {
		return nil
	}
	return gate.Check(ctx, userID)
}

// touch 写回签名计数器与最后使用时间。
//
// 写失败只记 warn、登录照常成立：这一步是收尾，此刻凭证已经验过、闸门已经过了，
// 让一次写库抖动把用户挡在门外，比让计数器基准晚一轮更新糟得多。
func (s *passkeySvc) touch(ctx context.Context, row *webauthn_credential_entity.WebAuthnCredential,
	presented uint32) {
	// 计数器只增不减：presented 为 0（同步型认证器）时保留库里那个非零基准，
	// 否则一次「合法的 0」就会把回退判定的基准永久清零。
	next := row.SignCount
	if presented > next {
		next = presented
	}
	if err := webauthn_credential_repo.WebAuthnCredential().
		TouchUsage(ctx, row.ID, next, time.Now().UnixMilli()); err != nil {
		logger.Ctx(ctx).Warn("passkey_svc: 写回签名计数器与最后使用时间失败",
			zap.Int64("passkeyId", row.ID), zap.Error(err))
	}
}

// credentialOwner 按凭证 ID 反查出这把密钥所属的账号视图。登录不要求任何标识，
// 这是全部身份信息的来源。
func (s *passkeySvc) credentialOwner(ctx context.Context, rawID []byte) (
	*webauthnUser, *webauthn_credential_entity.WebAuthnCredential, error) {
	row, err := webauthn_credential_repo.WebAuthnCredential().FindByCredentialID(ctx, rawID)
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 按凭证 ID 反查失败", zap.Error(err))
		return nil, nil, errCredentialLookup
	}
	if row == nil {
		return nil, nil, errCredentialUnknown
	}
	handle, err := user_repo.User().WebAuthnHandle(ctx, row.UserID)
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 取 user handle 失败",
			zap.Int64("userId", row.UserID), zap.Error(err))
		return nil, nil, errCredentialLookup
	}
	if len(handle) == 0 {
		// 账号没有 handle，却有一把凭证：这一对已经对不上了（handle 是注册时落定的，
		// 之后绝不会变），只能当这把密钥不属于任何可用账号。
		logger.Ctx(ctx).Warn("passkey_svc: 凭证所属账号没有 user handle",
			zap.Int64("userId", row.UserID), zap.Int64("passkeyId", row.ID))
		return nil, nil, errCredentialUnknown
	}
	return &webauthnUser{
		handle: handle,
		credentials: []webauthn.Credential{{
			ID:        row.CredentialID,
			PublicKey: row.PublicKey,
			Transport: splitTransports(row.Transports),
			// 备份标志要原样交回去：库会拿它跟这次回应里的 BE 位对，对不上说明
			// 这把凭证的性质变了（BE 按规范终生不变）。
			Flags: webauthn.CredentialFlags{
				BackupEligible: row.BackupEligible, BackupState: row.BackupState,
			},
			Authenticator: webauthn.Authenticator{AAGUID: row.AAGUID, SignCount: row.SignCount},
		}},
	}, row, nil
}

func (s *passkeySvc) storeLoginChallenge(ctx context.Context, session *webauthn.SessionData) error {
	body, err := json.Marshal(session)
	if err != nil {
		return err
	}
	return s.rc.Set(ctx, loginChallengeKey(session.Challenge), body, challengeTTL).Err()
}

// takeLoginChallenge 取出并当场删掉登录 challenge：一次登录只能用一次，同一段回应
// 重放不能再换出第二个会话。
func (s *passkeySvc) takeLoginChallenge(ctx context.Context, challenge string) (
	*webauthn.SessionData, error) {
	if challenge == "" {
		return nil, i18n.NewError(ctx, code.PasskeyChallengeInvalid)
	}
	body, err := s.rc.GetDel(ctx, loginChallengeKey(challenge)).Bytes()
	switch {
	case err == nil:
	case errors.Is(err, goredis.Nil):
		// 没有、过期了、或者压根不是本服务发出的——三者对用户是同一件事：重来一次。
		return nil, i18n.NewError(ctx, code.PasskeyChallengeInvalid)
	default:
		logger.Ctx(ctx).Error("passkey_svc: 读取登录 challenge 失败", zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	session := &webauthn.SessionData{}
	if err := json.Unmarshal(body, session); err != nil {
		return nil, i18n.NewError(ctx, code.PasskeyChallengeInvalid)
	}
	return session, nil
}

func (s *passkeySvc) List(ctx context.Context, userID int64) ([]Passkey, error) {
	rows, err := webauthn_credential_repo.WebAuthnCredential().ListByUser(ctx, userID)
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 读取通行密钥清单失败",
			zap.Int64("userId", userID), zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	out := make([]Passkey, 0, len(rows))
	for _, row := range rows {
		out = append(out, *toPasskey(row))
	}
	return out, nil
}

func (s *passkeySvc) Delete(ctx context.Context, userID, id int64) error {
	deleted, err := webauthn_credential_repo.WebAuthnCredential().DeleteByUser(ctx, userID, id)
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 删除通行密钥失败",
			zap.Int64("userId", userID), zap.Int64("passkeyId", id), zap.Error(err))
		return i18n.NewInternalError(ctx, code.ServerError)
	}
	if !deleted {
		// 不属于本账号与压根不存在给同一个结论：区分开来等于告诉调用方
		// 「这个 id 存在，只是不是你的」。
		return i18n.NewNotFoundError(ctx, code.PasskeyNotFound)
	}
	return nil
}

// ---- 内部装配 ----

func (s *passkeySvc) checkCap(ctx context.Context, userID int64) error {
	n, err := webauthn_credential_repo.WebAuthnCredential().CountByUser(ctx, userID)
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 统计通行密钥数量失败",
			zap.Int64("userId", userID), zap.Error(err))
		return i18n.NewInternalError(ctx, code.ServerError)
	}
	if n >= int64(s.cfg.MaxPerAccount) {
		return i18n.NewErrorWithStatus(ctx, http.StatusConflict, code.PasskeyLimitReached)
	}
	return nil
}

// registrationUser 组出交给 go-webauthn 的账号视图，以及要列进 excludeCredentials
// 的已有凭证。
func (s *passkeySvc) registrationUser(ctx context.Context, userID int64) (
	*webauthnUser, []protocol.CredentialDescriptor, error) {
	u, err := user_repo.User().Find(ctx, userID)
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 取账号失败", zap.Int64("userId", userID), zap.Error(err))
		return nil, nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	if u == nil {
		return nil, nil, i18n.NewUnauthorizedError(ctx, code.UserNotFound)
	}
	handle, err := s.handle(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := webauthn_credential_repo.WebAuthnCredential().ListByUser(ctx, userID)
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 读取已有通行密钥失败",
			zap.Int64("userId", userID), zap.Error(err))
		return nil, nil, i18n.NewInternalError(ctx, code.ServerError)
	}

	credentials := make([]webauthn.Credential, 0, len(rows))
	exclude := make([]protocol.CredentialDescriptor, 0, len(rows))
	for _, row := range rows {
		transports := splitTransports(row.Transports)
		credentials = append(credentials, webauthn.Credential{
			ID: row.CredentialID, PublicKey: row.PublicKey, Transport: transports,
		})
		// 把已有凭证列进 excludeCredentials，浏览器据此挡住「同一把认证器注册两次」。
		// 它只是提示，真正的裁决在凭证 ID 的全局唯一索引上。
		exclude = append(exclude, protocol.CredentialDescriptor{
			Type: protocol.PublicKeyCredentialType, CredentialID: row.CredentialID, Transport: transports,
		})
	}
	return &webauthnUser{
		handle: handle,
		// name / displayName 照常给邮箱与显示名：它们本来就是给用户在密码管理器里
		// 认出「这把密钥是哪个账号的」用的。决策 12 管的是 **handle**，不是这两项。
		name:        u.Email,
		displayName: u.DisplayName,
		credentials: credentials,
	}, exclude, nil
}

// handle 取账号的 user handle，没有就地生成一份。
//
// 惰性生成：绝大多数账号一辈子不注册通行密钥，没有理由在建号时就给每个账号灌一份
// 随机数。写入是条件写，多副本同时首次注册时由数据库裁决，竞败方回头读已落定的那份
// ——认证器里存的是先落定的那一份，拿自己生成的继续走会让这把密钥永远对不上账号。
func (s *passkeySvc) handle(ctx context.Context, userID int64) ([]byte, error) {
	existing, err := user_repo.User().WebAuthnHandle(ctx, userID)
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 取 user handle 失败",
			zap.Int64("userId", userID), zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	if len(existing) > 0 {
		return existing, nil
	}

	fresh := make([]byte, handleLen)
	if _, err := rand.Read(fresh); err != nil {
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	won, err := user_repo.User().SetWebAuthnHandleIfEmpty(ctx, userID, fresh)
	if err != nil {
		logger.Ctx(ctx).Error("passkey_svc: 写入 user handle 失败",
			zap.Int64("userId", userID), zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	if won {
		return fresh, nil
	}

	settled, err := user_repo.User().WebAuthnHandle(ctx, userID)
	if err != nil || len(settled) == 0 {
		logger.Ctx(ctx).Error("passkey_svc: 竞败后仍取不到已落定的 user handle",
			zap.Int64("userId", userID), zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	return settled, nil
}

func (s *passkeySvc) storeChallenge(ctx context.Context, sessionID string, session *webauthn.SessionData) error {
	body, err := json.Marshal(session)
	if err != nil {
		return err
	}
	return s.rc.Set(ctx, challengeKey(sessionID), body, challengeTTL).Err()
}

// takeChallenge 取出并**当场删掉** challenge：一次注册只能用一次，重放同一段回应
// 不该再注册出第二把密钥。GETDEL 让「取」和「删」是一次往返、由 Redis 原子完成。
func (s *passkeySvc) takeChallenge(ctx context.Context, sessionID string) (*webauthn.SessionData, error) {
	if sessionID == "" {
		return nil, i18n.NewError(ctx, code.PasskeyChallengeInvalid)
	}
	body, err := s.rc.GetDel(ctx, challengeKey(sessionID)).Bytes()
	switch {
	case err == nil:
	case errors.Is(err, goredis.Nil):
		// 没有、过期了、或者压根不是这条会话开的——三者对用户是同一件事：重来一次。
		return nil, i18n.NewError(ctx, code.PasskeyChallengeInvalid)
	default:
		logger.Ctx(ctx).Error("passkey_svc: 读取 challenge 失败", zap.Error(err))
		return nil, i18n.NewInternalError(ctx, code.ServerError)
	}
	session := &webauthn.SessionData{}
	if err := json.Unmarshal(body, session); err != nil {
		return nil, i18n.NewError(ctx, code.PasskeyChallengeInvalid)
	}
	return session, nil
}

// normalizeName 收口名字：必填、限长。绑定层的 max 只挡得住走 HTTP 那条路，
// 而「名字必须落得进 varchar(64)」是这一层的事实。
func normalizeName(ctx context.Context, in string) (string, error) {
	name := strings.TrimSpace(in)
	if name == "" || utf8.RuneCountInString(name) > MaxNameLen {
		return "", i18n.NewError(ctx, code.InvalidParameter)
	}
	return name, nil
}

func toPasskey(row *webauthn_credential_entity.WebAuthnCredential) *Passkey {
	return &Passkey{
		ID: row.ID, Name: row.Name, CreatedAt: row.Createtime, LastUsedAt: row.LastUsedAt,
	}
}

func joinTransports(in []protocol.AuthenticatorTransport) string {
	out := make([]string, 0, len(in))
	for _, t := range in {
		if s := strings.TrimSpace(string(t)); s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, ",")
}

func splitTransports(in string) []protocol.AuthenticatorTransport {
	if in == "" {
		return nil
	}
	parts := strings.Split(in, ",")
	out := make([]protocol.AuthenticatorTransport, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, protocol.AuthenticatorTransport(p))
		}
	}
	return out
}

// webauthnUser 是交给 go-webauthn 的账号视图。
type webauthnUser struct {
	handle      []byte
	name        string
	displayName string
	credentials []webauthn.Credential
}

func (u *webauthnUser) WebAuthnID() []byte   { return u.handle }
func (u *webauthnUser) WebAuthnName() string { return u.name }

func (u *webauthnUser) WebAuthnDisplayName() string {
	if u.displayName == "" {
		return u.name
	}
	return u.displayName
}

func (u *webauthnUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }
