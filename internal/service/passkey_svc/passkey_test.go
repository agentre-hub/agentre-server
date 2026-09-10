package passkey_svc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/webauthn_credential_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo/mock_user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/webauthn_credential_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/webauthn_credential_repo/mock_webauthn_credential_repo"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

const (
	testRPID   = "example.com"
	testOrigin = "https://example.com"
	testUserID = int64(7)
	testSID    = "sid-1"
)

func testConfig() Config {
	return Config{
		RPID:          testRPID,
		RPDisplayName: "AgentRe",
		// 允许列表刻意有两项：开发态前端在 5174、后端在 8443，只按 PublicURL 推一个
		// origin 的话本地与 e2e 全部验不过（决策 15）。
		Origins:       []string{testOrigin, "http://127.0.0.1:5174"},
		MaxPerAccount: 3,
	}
}

// setup 装上 repo mock 与一台独享 miniredis（好 FastForward 观察 challenge 的 TTL），
// 返回的工厂每调一次就造一个**新的 svc 实例 + 新的 Redis 连接**——多副本部署下
// begin 与 finish 会落在不同副本上，用它来把「另一个副本」演出来。
func setup(t *testing.T) (*mock_user_repo.MockUserRepo,
	*mock_webauthn_credential_repo.MockWebAuthnCredentialRepo, *miniredis.Miniredis, func() PasskeySvc) {
	t.Helper()
	ctrl := gomock.NewController(t)
	users := mock_user_repo.NewMockUserRepo(ctrl)
	creds := mock_webauthn_credential_repo.NewMockWebAuthnCredentialRepo(ctrl)
	user_repo.RegisterUser(users)
	webauthn_credential_repo.RegisterWebAuthnCredential(creds)
	// 用完摘掉：单例是包级的，留着它会跨用例活下去——后面任何一个用例碰到这两个
	// repo，都会撞上一个 ctrl 已经 Finish 掉的 mock，报出与真因毫无关系的
	// 「Controller.Call after Finish」。
	t.Cleanup(func() {
		user_repo.RegisterUser(nil)
		webauthn_credential_repo.RegisterWebAuthnCredential(nil)
	})

	mini := miniredis.RunT(t)
	return users, creds, mini, func() PasskeySvc {
		rc := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
		t.Cleanup(func() { _ = rc.Close() })
		return New(rc, testConfig())
	}
}

type creationOptions struct {
	RP struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"rp"`
	User struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		DisplayName string `json:"displayName"`
	} `json:"user"`
	Challenge              string `json:"challenge"`
	Attestation            string `json:"attestation"`
	AuthenticatorSelection struct {
		ResidentKey        string `json:"residentKey"`
		RequireResidentKey bool   `json:"requireResidentKey"`
		UserVerification   string `json:"userVerification"`
	} `json:"authenticatorSelection"`
	ExcludeCredentials []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	} `json:"excludeCredentials"`
}

func parseOptions(t *testing.T, raw json.RawMessage) creationOptions {
	t.Helper()
	var out creationOptions
	require.NoError(t, json.Unmarshal(raw, &out))
	return out
}

func b64(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

func assertCode(t *testing.T, err error, want int) {
	t.Helper()
	var he *httputils.Error
	require.ErrorAs(t, err, &he)
	assert.Equal(t, want, he.Code)
}

// expectAccount 是「取账号 + 取已生成的 handle」这组常规期望。
func expectAccount(users *mock_user_repo.MockUserRepo, handle []byte) {
	users.EXPECT().Find(gomock.Any(), testUserID).
		Return(&user_entity.User{ID: testUserID, Email: "a@b.com", DisplayName: "阿伟"}, nil).AnyTimes()
	users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(handle, nil).AnyTimes()
}

func fixedHandle() []byte { return []byte("0123456789abcdef0123456789abcdef") }

// 注册选项必须是可发现凭证（residentKey required）——登录时不要求任何标识，全靠它；
// 并且要把该账号已有的凭证列进 excludeCredentials，免得同一把认证器被注册两次。
// challenge 落 Redis、与当前会话绑定、带短 TTL（决策 14）。
func TestBeginRegistration_DiscoverableAndExcludesExistingCredentials(t *testing.T) {
	users, creds, mini, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(1), nil)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(
		[]*webauthn_credential_entity.WebAuthnCredential{
			{ID: 1, CredentialID: []byte("cred-a"), Transports: "internal"},
		}, nil)

	raw, err := newSvc().BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)
	opts := parseOptions(t, raw)

	assert.Equal(t, "required", opts.AuthenticatorSelection.ResidentKey)
	assert.True(t, opts.AuthenticatorSelection.RequireResidentKey)
	assert.Equal(t, "preferred", opts.AuthenticatorSelection.UserVerification)
	assert.Equal(t, testRPID, opts.RP.ID)
	assert.Equal(t, "AgentRe", opts.RP.Name)
	require.Len(t, opts.ExcludeCredentials, 1)
	assert.Equal(t, b64("cred-a"), opts.ExcludeCredentials[0].ID)
	assert.Equal(t, "public-key", opts.ExcludeCredentials[0].Type)

	// 隐私（决策 12）：user handle 既不是邮箱也不是自增 id。
	assert.Equal(t, b64(string(fixedHandle())), opts.User.ID)
	assert.NotEqual(t, b64("a@b.com"), opts.User.ID)
	assert.NotEqual(t, b64("7"), opts.User.ID)
	// 名字与显示名照常给邮箱与显示名：它们本来就是要在密码管理器里认账号用的。
	assert.Equal(t, "a@b.com", opts.User.Name)
	assert.Equal(t, "阿伟", opts.User.DisplayName)

	assert.True(t, mini.Exists(challengeKey(testSID)), "challenge 必须在 Redis 上，不能在进程内存里")
	ttl := mini.TTL(challengeKey(testSID))
	assert.Greater(t, ttl, time.Duration(0))
	assert.LessOrEqual(t, ttl, challengeTTL)
}

// 端到端：begin 落在一个副本上、finish 落在**另一个**副本上，注册照样成立——
// challenge 在 Redis 里，两跳之间没有任何进程内状态。
func TestRegistration_BeginOnOneReplicaFinishesOnAnother(t *testing.T) {
	users, creds, _, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(0), nil).Times(2)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)

	replicaA := newSvc()
	raw, err := replicaA.BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)
	opts := parseOptions(t, raw)

	auth := newVirtualAuthenticator(t, "cred-new")
	body := auth.attestationResponse(t, testRPID, testOrigin, opts.Challenge)

	var saved *webauthn_credential_entity.WebAuthnCredential
	creds.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, c *webauthn_credential_entity.WebAuthnCredential) error {
			c.ID = 11
			saved = c
			return nil
		})

	replicaB := newSvc()
	got, err := replicaB.FinishRegistration(context.Background(), FinishRegistration{
		UserID: testUserID, SessionID: testSID, Name: "我的 MacBook", Response: body,
	})
	require.NoError(t, err)

	assert.Equal(t, int64(11), got.ID)
	assert.Equal(t, "我的 MacBook", got.Name)
	assert.NotZero(t, got.CreatedAt)
	assert.Zero(t, got.LastUsedAt, "刚注册的密钥从没用过，不能显示成刚刚用过")

	require.NotNil(t, saved)
	assert.Equal(t, testUserID, saved.UserID)
	assert.Equal(t, []byte("cred-new"), saved.CredentialID)
	assert.NotEmpty(t, saved.PublicKey, "公钥必须落库，否则这把密钥永远验不了签")
	assert.Len(t, saved.AAGUID, 16)
	assert.Equal(t, "internal,hybrid", saved.Transports)
	assert.True(t, saved.BackupEligible)
	assert.True(t, saved.BackupState)
	// 名字是用户输入的那个，不从 AAGUID 猜设备型号。
	assert.Equal(t, "我的 MacBook", saved.Name)
}

// challenge 用一次就作废：同一段回应重放不能再注册出第二把。
func TestFinishRegistration_ChallengeIsSingleUse(t *testing.T) {
	users, creds, _, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(0), nil).Times(2)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)
	creds.EXPECT().Create(gomock.Any(), gomock.Any()).Return(nil)

	svc := newSvc()
	raw, err := svc.BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)
	body := newVirtualAuthenticator(t, "cred-new").
		attestationResponse(t, testRPID, testOrigin, parseOptions(t, raw).Challenge)

	in := FinishRegistration{UserID: testUserID, SessionID: testSID, Name: "k", Response: body}
	_, err = svc.FinishRegistration(context.Background(), in)
	require.NoError(t, err)

	_, err = svc.FinishRegistration(context.Background(), in)
	assertCode(t, err, code.PasskeyChallengeInvalid)
}

// challenge 过期后 finish 明确报「本次操作已过期」，而不是笼统的校验失败。
func TestFinishRegistration_ExpiredChallengeIsItsOwnFailure(t *testing.T) {
	users, creds, mini, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(0), nil)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)

	svc := newSvc()
	raw, err := svc.BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)
	body := newVirtualAuthenticator(t, "cred-new").
		attestationResponse(t, testRPID, testOrigin, parseOptions(t, raw).Challenge)

	mini.FastForward(challengeTTL + time.Minute)

	_, err = svc.FinishRegistration(context.Background(), FinishRegistration{
		UserID: testUserID, SessionID: testSID, Name: "k", Response: body,
	})
	assertCode(t, err, code.PasskeyChallengeInvalid)
}

// challenge 与会话绑定：别的会话拿着同一段回应完成不了注册。
func TestFinishRegistration_ChallengeIsBoundToTheSession(t *testing.T) {
	users, creds, _, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(0), nil)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)

	svc := newSvc()
	raw, err := svc.BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)
	body := newVirtualAuthenticator(t, "cred-new").
		attestationResponse(t, testRPID, testOrigin, parseOptions(t, raw).Challenge)

	_, err = svc.FinishRegistration(context.Background(), FinishRegistration{
		UserID: testUserID, SessionID: "another-sid", Name: "k", Response: body,
	})
	assertCode(t, err, code.PasskeyChallengeInvalid)
}

// origin 不在允许列表里就不算数——这是 origin 校验真的跑起来了的证据。
func TestFinishRegistration_ForeignOriginRejected(t *testing.T) {
	users, creds, _, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	// 只判一次上限：origin 校验在它之前就把这次注册否掉了。
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(0), nil)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)

	svc := newSvc()
	raw, err := svc.BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)
	body := newVirtualAuthenticator(t, "cred-new").
		attestationResponse(t, testRPID, "https://evil.example", parseOptions(t, raw).Challenge)

	_, err = svc.FinishRegistration(context.Background(), FinishRegistration{
		UserID: testUserID, SessionID: testSID, Name: "k", Response: body,
	})
	assertCode(t, err, code.PasskeyVerificationFailed)
}

// 已经注册过的认证器再来一次，撞的是凭证 ID 的全局唯一键——要说成「已经注册过了」，
// 不是 500。excludeCredentials 只是提示，浏览器可以不理会。
func TestFinishRegistration_AlreadyRegisteredAuthenticator(t *testing.T) {
	users, creds, _, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(0), nil).Times(2)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)
	creds.EXPECT().Create(gomock.Any(), gomock.Any()).Return(webauthn_credential_repo.ErrCredentialTaken)

	svc := newSvc()
	raw, err := svc.BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)
	body := newVirtualAuthenticator(t, "cred-a").
		attestationResponse(t, testRPID, testOrigin, parseOptions(t, raw).Challenge)

	_, err = svc.FinishRegistration(context.Background(), FinishRegistration{
		UserID: testUserID, SessionID: testSID, Name: "k", Response: body,
	})
	assertCode(t, err, code.PasskeyAlreadyRegistered)
}

// 超上限在 begin 就明确拒绝：不能先让用户在认证器上按一遍指纹、再告诉他不行。
// 拒绝时也不许留下 challenge。
func TestBeginRegistration_RefusedAtTheCap(t *testing.T) {
	users, creds, mini, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(3), nil)

	_, err := newSvc().BeginRegistration(context.Background(), testUserID, testSID)
	assertCode(t, err, code.PasskeyLimitReached)
	assert.False(t, mini.Exists(challengeKey(testSID)))
}

// finish 再判一次上限：begin 与 finish 之间隔着用户操作认证器的那几秒，同一账号在
// 另一个浏览器里完全可以把额度用满。只在 begin 判等于把上限做成了建议。
func TestFinishRegistration_RefusedWhenTheCapFilledMeanwhile(t *testing.T) {
	users, creds, _, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	gomock.InOrder(
		creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(2), nil),
		creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(3), nil),
	)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)

	svc := newSvc()
	raw, err := svc.BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)
	body := newVirtualAuthenticator(t, "cred-new").
		attestationResponse(t, testRPID, testOrigin, parseOptions(t, raw).Challenge)

	_, err = svc.FinishRegistration(context.Background(), FinishRegistration{
		UserID: testUserID, SessionID: testSID, Name: "k", Response: body,
	})
	assertCode(t, err, code.PasskeyLimitReached)
}

// 名字必填、限长，由服务端把关：绑定层的 max 只挡得住走 HTTP 那条路。
func TestFinishRegistration_NameRequiredAndCapped(t *testing.T) {
	users, creds, _, newSvc := setup(t)
	expectAccount(users, fixedHandle())
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(0), nil).AnyTimes()
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil).AnyTimes()

	svc := newSvc()
	// 超长用例的字符要真的是字符：原来的 `string(make([]rune, MaxNameLen+1))` 是
	// 65 个 NUL，它被拒只是因为 TrimSpace 不剥 NUL——一次巧合，不是判据。
	for _, name := range []string{"", "   ", strings.Repeat("x", MaxNameLen+1),
		strings.Repeat("名", MaxNameLen+1)} {
		_, err := svc.FinishRegistration(context.Background(), FinishRegistration{
			UserID: testUserID, SessionID: testSID, Name: name, Response: []byte("{}"),
		})
		assertCode(t, err, code.InvalidParameter)
	}

	// 收下的那一侧同样要钉住：只测拒绝的话，> 写成 >= 谁也发现不了，而那会让
	// 「正好 64 个字符」这个合法名字被拒。判据是**字符数**不是字节数——「名」是
	// 3 字节，按字节算这一条会误拒。此处不再走 InvalidParameter，而是往下走到
	// challenge 那一步（本用例没存过 challenge，所以是 PasskeyChallengeInvalid）。
	_, err := svc.FinishRegistration(context.Background(), FinishRegistration{
		UserID: testUserID, SessionID: testSID,
		Name: strings.Repeat("名", MaxNameLen), Response: []byte("{}"),
	})
	assertCode(t, err, code.PasskeyChallengeInvalid)
}

// handle 惰性生成：绝大多数账号一辈子不注册通行密钥，没有理由给它们都灌一份随机数。
// 生成出来的既不是邮箱也不是自增 id，而且长度用满规范给的那 32 字节。
func TestBeginRegistration_GeneratesHandleLazily(t *testing.T) {
	users, creds, _, newSvc := setup(t)
	users.EXPECT().Find(gomock.Any(), testUserID).
		Return(&user_entity.User{ID: testUserID, Email: "a@b.com", DisplayName: "阿伟"}, nil)
	users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(nil, nil)
	var generated []byte
	users.EXPECT().SetWebAuthnHandleIfEmpty(gomock.Any(), testUserID, gomock.Any()).
		DoAndReturn(func(_ context.Context, _ int64, h []byte) (bool, error) {
			generated = h
			return true, nil
		})
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(0), nil)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)

	raw, err := newSvc().BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)

	assert.Len(t, generated, handleLen)
	assert.NotEqual(t, []byte("a@b.com"), generated)
	assert.Equal(t, b64(string(generated)), parseOptions(t, raw).User.ID)
}

// 两个副本同时首次注册时，写不进去的那个必须回头把已经落定的 handle 读回来用，
// 而不是拿着自己生成的那份继续走——认证器里存的是先落定的那一份。
func TestBeginRegistration_RaceLoserAdoptsTheWinnersHandle(t *testing.T) {
	users, creds, _, newSvc := setup(t)
	winner := []byte("wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww")
	users.EXPECT().Find(gomock.Any(), testUserID).
		Return(&user_entity.User{ID: testUserID, Email: "a@b.com"}, nil)
	gomock.InOrder(
		users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(nil, nil),
		users.EXPECT().SetWebAuthnHandleIfEmpty(gomock.Any(), testUserID, gomock.Any()).Return(false, nil),
		users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(winner, nil),
	)
	creds.EXPECT().CountByUser(gomock.Any(), testUserID).Return(int64(0), nil)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(nil, nil)

	raw, err := newSvc().BeginRegistration(context.Background(), testUserID, testSID)
	require.NoError(t, err)
	assert.Equal(t, b64(string(winner)), parseOptions(t, raw).User.ID)
}

// 清单给出名字、创建时间、最后使用时间——公钥与凭证 ID 一个都不出去。
func TestList_ReturnsNameCreatedAndLastUsed(t *testing.T) {
	_, creds, _, newSvc := setup(t)
	creds.EXPECT().ListByUser(gomock.Any(), testUserID).Return(
		[]*webauthn_credential_entity.WebAuthnCredential{
			{ID: 2, Name: "手机", Createtime: 2000, LastUsedAt: 3000, CredentialID: []byte("cred-b")},
			{ID: 1, Name: "安全钥匙", Createtime: 1000, LastUsedAt: 0, CredentialID: []byte("cred-a")},
		}, nil)

	got, err := newSvc().List(context.Background(), testUserID)
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, Passkey{ID: 2, Name: "手机", CreatedAt: 2000, LastUsedAt: 3000}, got[0])
	assert.Equal(t, Passkey{ID: 1, Name: "安全钥匙", CreatedAt: 1000, LastUsedAt: 0}, got[1])
}

// 删到零把也照常允许：GitHub 登录始终是回退路径，所以不需要恢复码，也不需要
// 「至少留一把」这种半吊子保护（决策 9）。
func TestDelete_AllowsRemovingTheLastOne(t *testing.T) {
	_, creds, _, newSvc := setup(t)
	creds.EXPECT().DeleteByUser(gomock.Any(), testUserID, int64(11)).Return(true, nil)

	require.NoError(t, newSvc().Delete(context.Background(), testUserID, 11))
}

// 删别人的 / 已经没了的：明确报「通行密钥不存在」，不能静默成功。
func TestDelete_MissingIsNotFound(t *testing.T) {
	_, creds, _, newSvc := setup(t)
	creds.EXPECT().DeleteByUser(gomock.Any(), testUserID, int64(11)).Return(false, nil)

	assertCode(t, newSvc().Delete(context.Background(), testUserID, 11), code.PasskeyNotFound)
}

// ---- 登录 ----

type assertionOptions struct {
	Challenge          string `json:"challenge"`
	RelyingPartyID     string `json:"rpId"`
	UserVerification   string `json:"userVerification"`
	AllowedCredentials []struct {
		ID string `json:"id"`
	} `json:"allowCredentials"`
}

func parseAssertionOptions(t *testing.T, raw json.RawMessage) assertionOptions {
	t.Helper()
	var out assertionOptions
	require.NoError(t, json.Unmarshal(raw, &out))
	return out
}

// installGate 装上**真**账号闸门（miniredis + 已注册的 repo mock）：登录路径上「账号
// 还能用吗」这一问必须走生产那条判定链路，桩掉它就等于没测封禁。
func installGate(t *testing.T, mini *miniredis.Miniredis,
	users *mock_user_repo.MockUserRepo, status int) {
	t.Helper()
	users.EXPECT().FindIgnoreStatus(gomock.Any(), testUserID).
		Return(&user_entity.User{ID: testUserID, Status: status}, nil).AnyTimes()
	rc := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	user_svc.SetGate(user_svc.NewGate(rc, time.Minute))
	t.Cleanup(func() {
		user_svc.SetGate(nil)
		_ = rc.Close()
	})
}

// storedCredential 是这把认证器注册完之后库里那一行。
func storedCredential(t *testing.T, auth *virtualAuthenticator,
	signCount uint32) *webauthn_credential_entity.WebAuthnCredential {
	t.Helper()
	return &webauthn_credential_entity.WebAuthnCredential{
		ID: 11, UserID: testUserID, CredentialID: auth.credentialID,
		PublicKey: auth.coseKey(t), AAGUID: auth.aaguid, SignCount: signCount,
		Transports: "internal,hybrid", Name: "我的 MacBook",
		BackupEligible: auth.backupEligible, BackupState: auth.backupState,
	}
}

// 登录选项不要求任何标识：allowCredentials 留空，由浏览器自己弹选择器（决策 10）。
// 这一步一次都不许碰账号库或凭证表——碰了就说明它在按某个标识找账号，而「先填邮箱」
// 正是这条路径刻意不做的事（那会长出一个账号枚举面）。repo mock 没有任何期望，
// 任何一次调用都会让这个用例红。
func TestBeginLogin_AsksForNoIdentifierAndLeavesAllowCredentialsEmpty(t *testing.T) {
	_, _, mini, newSvc := setup(t)

	raw, err := newSvc().BeginLogin(context.Background())
	require.NoError(t, err)
	opts := parseAssertionOptions(t, raw)

	assert.Empty(t, opts.AllowedCredentials, "allowCredentials 必须留空")
	assert.Equal(t, testRPID, opts.RelyingPartyID)
	assert.NotEmpty(t, opts.Challenge)

	assert.True(t, mini.Exists(loginChallengeKey(opts.Challenge)),
		"challenge 必须在 Redis 上，不能在进程内存里")
	ttl := mini.TTL(loginChallengeKey(opts.Challenge))
	assert.Greater(t, ttl, time.Duration(0))
	assert.LessOrEqual(t, ttl, challengeTTL)
}

// 端到端：begin 落在一个副本、finish 落在**另一个**副本，登录照样成立；不输入任何
// 标识，账号是按凭证 ID 反查出来的。通过后写回计数器与最后使用时间。
// 同一段回应再来一次只能是「本次操作已过期」——challenge 用一次就没了。
func TestLogin_BeginOnOneReplicaFinishesOnAnother(t *testing.T) {
	users, creds, mini, newSvc := setup(t)
	installGate(t, mini, users, consts.ACTIVE)

	auth := newVirtualAuthenticator(t, "cred-a")
	auth.signCount = 6
	creds.EXPECT().FindByCredentialID(gomock.Any(), []byte("cred-a")).
		Return(storedCredential(t, auth, 5), nil)
	users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(fixedHandle(), nil)
	var usedAt int64
	creds.EXPECT().TouchUsage(gomock.Any(), int64(11), uint32(6), gomock.Any()).
		DoAndReturn(func(_ context.Context, _ int64, _ uint32, at int64) error {
			usedAt = at
			return nil
		})

	replicaA := newSvc()
	raw, err := replicaA.BeginLogin(context.Background())
	require.NoError(t, err)
	body := auth.assertionResponse(t, testRPID, testOrigin,
		parseAssertionOptions(t, raw).Challenge, fixedHandle())

	replicaB := newSvc()
	userID, err := replicaB.FinishLogin(context.Background(), body)
	require.NoError(t, err)
	assert.Equal(t, testUserID, userID)
	assert.NotZero(t, usedAt, "最后使用时间必须写回，否则清单永远显示「从未使用」")

	// 重放同一段回应：challenge 已经被取走，第二次只能是「本次操作已过期」。
	// 上面每个 EXPECT 都只准调一次，真走下去还会额外炸在 mock 上。
	_, err = replicaB.FinishLogin(context.Background(), body)
	assertCode(t, err, code.PasskeyChallengeInvalid)
}

// 被封账号验签通过也进不来：闸门排在建立会话之前，与 GitHub 回调同一处判定。
// 连「刚用过」都不许记——记了说明代码在闸门之后还往下走了。
func TestFinishLogin_BannedAccountRefusedBeforeAnySession(t *testing.T) {
	users, creds, mini, newSvc := setup(t)
	installGate(t, mini, users, consts.BAN)

	auth := newVirtualAuthenticator(t, "cred-a")
	creds.EXPECT().FindByCredentialID(gomock.Any(), []byte("cred-a")).
		Return(storedCredential(t, auth, 0), nil)
	users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(fixedHandle(), nil)

	svc := newSvc()
	raw, err := svc.BeginLogin(context.Background())
	require.NoError(t, err)
	body := auth.assertionResponse(t, testRPID, testOrigin,
		parseAssertionOptions(t, raw).Challenge, fixedHandle())

	_, err = svc.FinishLogin(context.Background(), body)
	assertCode(t, err, code.UserBanned)
}

// 同步型认证器（iCloud 钥匙串、各家密码管理器）恒返回计数器 0：把 0 当回退，这类
// 密钥第二次登录就会被自己挡在门外（决策 13）。连登两次必须都成立。
func TestFinishLogin_SynchronisingAuthenticatorAlwaysReportsZero(t *testing.T) {
	users, creds, mini, newSvc := setup(t)
	installGate(t, mini, users, consts.ACTIVE)

	auth := newVirtualAuthenticator(t, "cred-a") // signCount 恒为 0
	creds.EXPECT().FindByCredentialID(gomock.Any(), []byte("cred-a")).
		Return(storedCredential(t, auth, 0), nil).Times(2)
	users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(fixedHandle(), nil).Times(2)
	creds.EXPECT().TouchUsage(gomock.Any(), int64(11), uint32(0), gomock.Any()).Return(nil).Times(2)

	svc := newSvc()
	for i := 1; i <= 2; i++ {
		raw, err := svc.BeginLogin(context.Background())
		require.NoError(t, err)
		body := auth.assertionResponse(t, testRPID, testOrigin,
			parseAssertionOptions(t, raw).Challenge, fixedHandle())

		userID, err := svc.FinishLogin(context.Background(), body)
		require.NoErrorf(t, err, "第 %d 次登录", i)
		assert.Equal(t, testUserID, userID)
	}
}

// 双方都非零、而且这次比库里那次小：这是真回退（克隆认证器的信号），拒绝，
// 并且给自己的错误码——不能压成一句「登录失败」。计数器与最后使用时间都不许写回。
func TestFinishLogin_GenuineCounterRollbackRefused(t *testing.T) {
	users, creds, mini, newSvc := setup(t)
	installGate(t, mini, users, consts.ACTIVE)

	auth := newVirtualAuthenticator(t, "cred-a")
	auth.signCount = 3
	creds.EXPECT().FindByCredentialID(gomock.Any(), []byte("cred-a")).
		Return(storedCredential(t, auth, 5), nil)
	users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(fixedHandle(), nil)

	svc := newSvc()
	raw, err := svc.BeginLogin(context.Background())
	require.NoError(t, err)
	body := auth.assertionResponse(t, testRPID, testOrigin,
		parseAssertionOptions(t, raw).Challenge, fixedHandle())

	_, err = svc.FinishLogin(context.Background(), body)
	assertCode(t, err, code.PasskeyCounterRollback)
}

// 库里认不出这把凭证（密钥已被删、或者换了服务端）：自己的错误码，不是「校验未通过」，
// 也不是 500。
func TestFinishLogin_UnknownCredentialIsItsOwnFailure(t *testing.T) {
	_, creds, _, newSvc := setup(t)

	auth := newVirtualAuthenticator(t, "cred-gone")
	creds.EXPECT().FindByCredentialID(gomock.Any(), []byte("cred-gone")).Return(nil, nil)

	svc := newSvc()
	raw, err := svc.BeginLogin(context.Background())
	require.NoError(t, err)
	body := auth.assertionResponse(t, testRPID, testOrigin,
		parseAssertionOptions(t, raw).Challenge, fixedHandle())

	_, err = svc.FinishLogin(context.Background(), body)
	assertCode(t, err, code.PasskeyCredentialUnknown)
}

// origin 不在允许列表里：自己的错误码。而且要在碰账号库之前就否掉——repo mock 没有
// 任何期望，查一次库这个用例就红。
func TestFinishLogin_ForeignOriginIsItsOwnFailure(t *testing.T) {
	_, _, _, newSvc := setup(t)

	auth := newVirtualAuthenticator(t, "cred-a")
	svc := newSvc()
	raw, err := svc.BeginLogin(context.Background())
	require.NoError(t, err)
	body := auth.assertionResponse(t, testRPID, "https://evil.example",
		parseAssertionOptions(t, raw).Challenge, fixedHandle())

	_, err = svc.FinishLogin(context.Background(), body)
	assertCode(t, err, code.PasskeyOriginNotAllowed)
}

// challenge 过期：明确说「本次操作已过期，重来一次」，而不是笼统的校验失败——
// 用户从 begin 到按下指纹之间隔着多久，只有他自己知道。
func TestFinishLogin_ExpiredChallengeIsItsOwnFailure(t *testing.T) {
	_, _, mini, newSvc := setup(t)

	auth := newVirtualAuthenticator(t, "cred-a")
	svc := newSvc()
	raw, err := svc.BeginLogin(context.Background())
	require.NoError(t, err)
	body := auth.assertionResponse(t, testRPID, testOrigin,
		parseAssertionOptions(t, raw).Challenge, fixedHandle())

	mini.FastForward(challengeTTL + time.Minute)

	_, err = svc.FinishLogin(context.Background(), body)
	assertCode(t, err, code.PasskeyChallengeInvalid)
}

// 从来没有发出过的 challenge：同样是「本次操作已过期」，并且不许查库——伪造一段
// 回应就能触发一次凭证反查的话，这个端点就成了免费的凭证探测器。
func TestFinishLogin_UnissuedChallengeNeverReachesTheDatabase(t *testing.T) {
	_, _, _, newSvc := setup(t)

	auth := newVirtualAuthenticator(t, "cred-a")
	body := auth.assertionResponse(t, testRPID, testOrigin,
		base64.RawURLEncoding.EncodeToString([]byte("never-issued-challenge")), fixedHandle())

	_, err := newSvc().FinishLogin(context.Background(), body)
	assertCode(t, err, code.PasskeyChallengeInvalid)
}

// 签名对不上库里的公钥（伪造的回应）：这才是「校验未通过」那一档，与上面几种
// 各自分开。
func TestFinishLogin_ForgedSignatureFailsVerification(t *testing.T) {
	users, creds, mini, newSvc := setup(t)
	installGate(t, mini, users, consts.ACTIVE)

	registered := newVirtualAuthenticator(t, "cred-a")
	forger := newVirtualAuthenticator(t, "cred-a") // 同一个凭证 ID，另一把私钥
	creds.EXPECT().FindByCredentialID(gomock.Any(), []byte("cred-a")).
		Return(storedCredential(t, registered, 0), nil)
	users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(fixedHandle(), nil)

	svc := newSvc()
	raw, err := svc.BeginLogin(context.Background())
	require.NoError(t, err)
	body := forger.assertionResponse(t, testRPID, testOrigin,
		parseAssertionOptions(t, raw).Challenge, fixedHandle())

	_, err = svc.FinishLogin(context.Background(), body)
	assertCode(t, err, code.PasskeyVerificationFailed)
}

// 库里存着一个非零基准、这次却带 0 上来：0 的含义是「这台认证器不报计数器」，
// 不是回退（决策 13 的「双方都非零」正是为它写的）。放行，而且**不许**把库里那个
// 基准降成 0——降了，此后任何真回退都判不出来了。
func TestFinishLogin_ZeroCounterAgainstAStoredBaselineIsNotARollback(t *testing.T) {
	users, creds, mini, newSvc := setup(t)
	installGate(t, mini, users, consts.ACTIVE)

	auth := newVirtualAuthenticator(t, "cred-a") // signCount 恒为 0
	creds.EXPECT().FindByCredentialID(gomock.Any(), []byte("cred-a")).
		Return(storedCredential(t, auth, 5), nil)
	users.EXPECT().WebAuthnHandle(gomock.Any(), testUserID).Return(fixedHandle(), nil)
	creds.EXPECT().TouchUsage(gomock.Any(), int64(11), uint32(5), gomock.Any()).Return(nil)

	svc := newSvc()
	raw, err := svc.BeginLogin(context.Background())
	require.NoError(t, err)
	body := auth.assertionResponse(t, testRPID, testOrigin,
		parseAssertionOptions(t, raw).Challenge, fixedHandle())

	userID, err := svc.FinishLogin(context.Background(), body)
	require.NoError(t, err)
	assert.Equal(t, testUserID, userID)
}
