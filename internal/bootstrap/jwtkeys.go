package bootstrap

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// EnvJWTAutoGenerate 默认关，只有单机且密钥落在持久卷上才该开：多副本各生成一把，
// 同一个 kid 对应不同私钥，令牌换个副本就验不过，而且是静默的。
const EnvJWTAutoGenerate = "AGENTRE_SERVER_JWT_AUTO_GENERATE"

const jwtAutoGenerateBits = 2048

// EnsureJWTKeys 在开关打开且 active kid 的私钥不存在时补一把 RSA 密钥对。
// 已存在的绝不覆盖——覆盖等于把所有已签发的令牌一次性作废。
func EnsureJWTKeys(cfg *ServerConfig) error {
	if !envTruthy(EnvJWTAutoGenerate) {
		return nil
	}
	key, ok := activeJWTKey(cfg.JWT)
	if !ok {
		return fmt.Errorf("jwt 自动生成: 配置里没有 active_kid %q 对应的密钥项", cfg.JWT.ActiveKID)
	}
	if key.PrivateKeyPEMPath == "" || key.PublicKeyPEMPath == "" {
		return fmt.Errorf("jwt 自动生成: active_kid %q 必须同时配上 private_key_pem_path 与 public_key_pem_path",
			key.KID)
	}
	switch _, err := os.Stat(key.PrivateKeyPEMPath); {
	case err == nil:
		return nil
	case !os.IsNotExist(err):
		return fmt.Errorf("jwt 自动生成: 探测 %s: %w", key.PrivateKeyPEMPath, err)
	}

	priv, err := rsa.GenerateKey(rand.Reader, jwtAutoGenerateBits)
	if err != nil {
		return fmt.Errorf("jwt 自动生成: 生成密钥: %w", err)
	}
	privDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return fmt.Errorf("jwt 自动生成: 编码私钥: %w", err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		return fmt.Errorf("jwt 自动生成: 编码公钥: %w", err)
	}

	if err := writeNewFile(key.PrivateKeyPEMPath, pem.EncodeToMemory(
		&pem.Block{Type: "PRIVATE KEY", Bytes: privDER}), 0o600); err != nil {
		// 撞上 O_EXCL 说明另一个进程刚写完，用它那把
		if os.IsExist(err) {
			return nil
		}
		return fmt.Errorf("jwt 自动生成: 写私钥 %s: %w", key.PrivateKeyPEMPath, err)
	}
	if err := writeNewFile(key.PublicKeyPEMPath, pem.EncodeToMemory(
		&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER}), 0o644); err != nil && !os.IsExist(err) {
		return fmt.Errorf("jwt 自动生成: 写公钥 %s: %w", key.PublicKeyPEMPath, err)
	}
	log.Printf("jwt: %s 不存在，已自动生成 RSA-%d 密钥对（kid=%q）；"+
		"这把密钥要随部署持久保留，丢了等于所有设备重新登录",
		key.PrivateKeyPEMPath, jwtAutoGenerateBits, key.KID)
	return nil
}

func activeJWTKey(cfg JWTConfig) (JWTKeyConfig, bool) {
	for _, key := range cfg.Keys {
		if key.KID == cfg.ActiveKID {
			return key, true
		}
	}
	return JWTKeyConfig{}, false
}

// writeNewFile 用 O_EXCL 而不是先 Stat 再写：两个进程同时起来时，Stat 与写之间的
// 空档足够两边都判成「不存在」，后写的那把会盖掉先写的。
func writeNewFile(path string, content []byte, perm os.FileMode) error {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(content); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
