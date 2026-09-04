package bootstrap

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
)

func autoGenConfig(dir string) *ServerConfig {
	return &ServerConfig{JWT: JWTConfig{
		ActiveKID: "local-1",
		Keys: []JWTKeyConfig{{
			KID:               "local-1",
			PrivateKeyPEMPath: filepath.Join(dir, "jwt.key"),
			PublicKeyPEMPath:  filepath.Join(dir, "jwt.pub"),
		}},
		AccessTTL: 15 * time.Minute,
	}}
}

// 补出来的这把要真能签发：只写出两个文件不算数，格式不对照样在 NewKeyRing 那里 Fatal。
func TestEnsureJWTKeys_GeneratesUsableKeyPairWhenEnabled(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "keys")
	cfg := autoGenConfig(dir)
	t.Setenv(EnvJWTAutoGenerate, "1")

	assert.NoError(t, EnsureJWTKeys(cfg))

	info, err := os.Stat(cfg.JWT.Keys[0].PrivateKeyPEMPath)
	assert.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "私钥不能是别人也读得到的权限")

	privPEM, err := os.ReadFile(cfg.JWT.Keys[0].PrivateKeyPEMPath)
	assert.NoError(t, err)
	pubPEM, err := os.ReadFile(cfg.JWT.Keys[0].PublicKeyPEMPath)
	assert.NoError(t, err)
	signer, err := jwt.NewKeyRing("local-1",
		[]jwt.Key{{ID: "local-1", PrivatePEM: privPEM, PublicPEM: pubPEM}},
		JWTIssuer, JWTAudience, cfg.JWT.AccessTTL)
	assert.NoError(t, err)
	assert.NotNil(t, signer)
}

// 默认必须是关的：多副本各生成一把，令牌换个副本就验不过，而且是静默的。
func TestEnsureJWTKeys_DoesNothingWhenSwitchOff(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "keys")
	cfg := autoGenConfig(dir)

	assert.NoError(t, EnsureJWTKeys(cfg))

	_, err := os.Stat(cfg.JWT.Keys[0].PrivateKeyPEMPath)
	assert.True(t, os.IsNotExist(err), "开关没开就不该生成任何东西")
}

// 覆盖已有密钥等于把所有已签发的令牌一次性作废。
func TestEnsureJWTKeys_KeepsExistingKeys(t *testing.T) {
	dir := t.TempDir()
	cfg := autoGenConfig(dir)
	assert.NoError(t, os.WriteFile(cfg.JWT.Keys[0].PrivateKeyPEMPath, []byte("existing-private"), 0o600))
	assert.NoError(t, os.WriteFile(cfg.JWT.Keys[0].PublicKeyPEMPath, []byte("existing-public"), 0o644))
	t.Setenv(EnvJWTAutoGenerate, "1")

	assert.NoError(t, EnsureJWTKeys(cfg))

	priv, err := os.ReadFile(cfg.JWT.Keys[0].PrivateKeyPEMPath)
	assert.NoError(t, err)
	assert.Equal(t, "existing-private", string(priv))
	pub, err := os.ReadFile(cfg.JWT.Keys[0].PublicKeyPEMPath)
	assert.NoError(t, err)
	assert.Equal(t, "existing-public", string(pub))
}

// 非 active 项是轮换留下的历史公钥，本来就没有私钥；补一把等于凭空造个 kid。
func TestEnsureJWTKeys_OnlyFillsActiveKID(t *testing.T) {
	dir := t.TempDir()
	cfg := autoGenConfig(dir)
	cfg.JWT.Keys = append(cfg.JWT.Keys, JWTKeyConfig{
		KID:              "retired-1",
		PublicKeyPEMPath: filepath.Join(dir, "retired.pub"),
	})
	t.Setenv(EnvJWTAutoGenerate, "1")

	assert.NoError(t, EnsureJWTKeys(cfg))

	_, err := os.Stat(filepath.Join(dir, "retired.pub"))
	assert.True(t, os.IsNotExist(err), "只补 active kid 那一把")
}

// 开关开着却没给路径是配置写错了：让 loadPEM 去报「读不到 pem」指不回真正的原因。
func TestEnsureJWTKeys_ErrorsWhenActiveKeyHasNoPaths(t *testing.T) {
	cfg := &ServerConfig{JWT: JWTConfig{
		ActiveKID: "local-1",
		Keys:      []JWTKeyConfig{{KID: "local-1"}},
	}}
	t.Setenv(EnvJWTAutoGenerate, "1")

	err := EnsureJWTKeys(cfg)

	assert.Error(t, err)
}
