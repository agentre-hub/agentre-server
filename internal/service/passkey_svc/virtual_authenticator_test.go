package passkey_svc

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/stretchr/testify/require"
)

// 认证器数据里的标志位（WebAuthn §6.1）。
const (
	flagUserPresent            = 0x01
	flagUserVerified           = 0x04
	flagBackupEligible         = 0x08
	flagBackupState            = 0x10
	flagAttestedCredentialData = 0x40
)

// virtualAuthenticator 是测试用的最小认证器：ES256 密钥 + "none" attestation。
//
// 注册这条路上没有任何东西可以「造好一次存进 fixture」——challenge 由服务端每次现生成，
// clientDataJSON 必须带着那个 challenge，attestationObject 又必须带着与它同一次注册的
// 公钥。所以要在单测里走通「begin → 认证器 → finish」，只能在测试侧真的做一次注册。
//
// 生产代码一行都不共用它：验签、CBOR/COSE 解析、origin 与 challenge 比对全部在
// go-webauthn 里（决策 11）。这里只负责把浏览器该发过来的那段 JSON 拼出来。
type virtualAuthenticator struct {
	credentialID   []byte
	aaguid         []byte
	key            *ecdsa.PrivateKey
	signCount      uint32
	backupEligible bool
	backupState    bool
	transports     []string
}

func newVirtualAuthenticator(t *testing.T, credentialID string) *virtualAuthenticator {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	return &virtualAuthenticator{
		credentialID: []byte(credentialID),
		// 全零 AAGUID 是同步型认证器（iCloud 钥匙串、各家密码管理器）的常态。
		aaguid:         make([]byte, 16),
		key:            key,
		signCount:      0,
		backupEligible: true,
		backupState:    true,
		transports:     []string{"internal", "hybrid"},
	}
}

// coseKey 返回 COSE_Key 编码的 ES256 公钥：kty=EC2(2)、alg=ES256(-7)、crv=P-256(1)。
//
// 坐标从 PublicKey.Bytes() 的 SEC 1 非压缩编码里切出来（0x04 || X || Y，P-256 下
// 共 65 字节），而不是读已废弃的 X / Y 字段。
func (a *virtualAuthenticator) coseKey(t *testing.T) []byte {
	t.Helper()
	uncompressed, err := a.key.PublicKey.Bytes()
	require.NoError(t, err)
	require.Len(t, uncompressed, 65)
	out, err := webauthncbor.Marshal(map[int]any{
		1: 2, 3: -7, -1: 1, -2: uncompressed[1:33], -3: uncompressed[33:65],
	})
	require.NoError(t, err)
	return out
}

// authData 拼出 authenticatorData：rpIdHash || flags || signCount || attestedCredentialData。
func (a *virtualAuthenticator) authData(t *testing.T, rpID string) []byte {
	t.Helper()
	rpIDHash := sha256.Sum256([]byte(rpID))

	flags := byte(flagUserPresent | flagUserVerified | flagAttestedCredentialData)
	if a.backupEligible {
		flags |= flagBackupEligible
	}
	if a.backupState {
		flags |= flagBackupState
	}

	out := make([]byte, 0, 128)
	out = append(out, rpIDHash[:]...)
	out = append(out, flags)
	out = binary.BigEndian.AppendUint32(out, a.signCount)
	out = append(out, a.aaguid...)
	out = binary.BigEndian.AppendUint16(out, uint16(len(a.credentialID)))
	out = append(out, a.credentialID...)
	return append(out, a.coseKey(t)...)
}

// attestationResponse 返回浏览器 navigator.credentials.create() 之后会 POST 上来的那段 JSON。
func (a *virtualAuthenticator) attestationResponse(t *testing.T, rpID, origin, challenge string) []byte {
	t.Helper()

	clientData, err := json.Marshal(map[string]any{
		"type":        "webauthn.create",
		"challenge":   challenge,
		"origin":      origin,
		"crossOrigin": false,
	})
	require.NoError(t, err)

	attestationObject, err := webauthncbor.Marshal(map[string]any{
		"fmt":      "none",
		"attStmt":  map[string]any{},
		"authData": a.authData(t, rpID),
	})
	require.NoError(t, err)

	b64 := base64.RawURLEncoding.EncodeToString
	out, err := json.Marshal(map[string]any{
		"id":                      b64(a.credentialID),
		"rawId":                   b64(a.credentialID),
		"type":                    "public-key",
		"authenticatorAttachment": "platform",
		"response": map[string]any{
			"clientDataJSON":    b64(clientData),
			"attestationObject": b64(attestationObject),
			"transports":        a.transports,
		},
	})
	require.NoError(t, err)
	return out
}

// assertionAuthData 拼出登录用的 authenticatorData：rpIdHash || flags || signCount。
//
// 与注册那份的区别是**没有** AT 标志、也不带 attestedCredentialData：登录时认证器
// 只证明自己还握着私钥，不再交付公钥。
func (a *virtualAuthenticator) assertionAuthData(t *testing.T, rpID string) []byte {
	t.Helper()
	rpIDHash := sha256.Sum256([]byte(rpID))

	flags := byte(flagUserPresent | flagUserVerified)
	if a.backupEligible {
		flags |= flagBackupEligible
	}
	if a.backupState {
		flags |= flagBackupState
	}

	out := make([]byte, 0, 37)
	out = append(out, rpIDHash[:]...)
	out = append(out, flags)
	return binary.BigEndian.AppendUint32(out, a.signCount)
}

// assertionResponse 返回浏览器 navigator.credentials.get() 之后会 POST 上来的那段 JSON。
//
// userHandle 一定要带：可发现凭证正是靠它说明「这把密钥是谁的」，登录路径上服务端
// 一开始并不知道来的是谁。
func (a *virtualAuthenticator) assertionResponse(t *testing.T, rpID, origin, challenge string,
	userHandle []byte) []byte {
	t.Helper()

	clientData, err := json.Marshal(map[string]any{
		"type":        "webauthn.get",
		"challenge":   challenge,
		"origin":      origin,
		"crossOrigin": false,
	})
	require.NoError(t, err)

	authData := a.assertionAuthData(t, rpID)
	clientDataHash := sha256.Sum256(clientData)
	// 签名覆盖 authenticatorData || SHA-256(clientDataJSON)（WebAuthn §6.3.3）。
	digest := sha256.Sum256(append(append([]byte{}, authData...), clientDataHash[:]...))
	signature, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	require.NoError(t, err)

	b64 := base64.RawURLEncoding.EncodeToString
	out, err := json.Marshal(map[string]any{
		"id":                      b64(a.credentialID),
		"rawId":                   b64(a.credentialID),
		"type":                    "public-key",
		"authenticatorAttachment": "platform",
		"response": map[string]any{
			"clientDataJSON":    b64(clientData),
			"authenticatorData": b64(authData),
			"signature":         b64(signature),
			"userHandle":        b64(userHandle),
		},
	})
	require.NoError(t, err)
	return out
}
