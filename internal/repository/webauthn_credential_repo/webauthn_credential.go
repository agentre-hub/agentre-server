// Package webauthn_credential_repo 维护 webauthn_credentials 表读写（通行密钥）。
package webauthn_credential_repo

import (
	"context"
	"errors"

	"github.com/cago-frame/cago/database/db"

	"github.com/agentre-hub/agentre-server/internal/model/entity/webauthn_credential_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/dberr"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source webauthn_credential.go -destination mock_webauthn_credential_repo/mock_webauthn_credential.go

// credentialIDIndex 是凭证 ID 上的全局唯一键。撞它意味着这把认证器已经注册过——
// 可能是本账号（用户绕过了 excludeCredentials），也可能是别的账号。
const credentialIDIndex = "uk_webauthn_credentials_credential_id"

// ErrCredentialTaken 是「这把认证器已经注册过」。单独立一个哨兵错误，是因为它与
// 真正的写库故障处置完全不同：前者要变成一句用户看得懂的话，后者是 500。
var ErrCredentialTaken = errors.New("webauthn credential already registered")

type WebAuthnCredentialRepo interface {
	// Create 落一把新密钥。撞上凭证 ID 唯一键时返回 ErrCredentialTaken。
	Create(ctx context.Context, c *webauthn_credential_entity.WebAuthnCredential) error
	// ListByUser 返回该账号全部密钥，最近添加的在前。
	ListByUser(ctx context.Context, userID int64) ([]*webauthn_credential_entity.WebAuthnCredential, error)
	// CountByUser 返回该账号已有的密钥数，用于上限判定。
	CountByUser(ctx context.Context, userID int64) (int64, error)
	// FindByCredentialID 按凭证 ID 反查密钥行；认不出来的凭证返回 (nil, nil)。
	//
	// 登录不要求任何标识（决策 10），这是唯一的入口：凭证 ID 上有全局唯一索引，
	// 因此至多一行。刻意不带 user_id ——带上就等于要求登录方先说自己是谁。
	FindByCredentialID(ctx context.Context, credentialID []byte) (
		*webauthn_credential_entity.WebAuthnCredential, error)
	// TouchUsage 记下这把密钥刚被用过：写回签名计数器与最后使用时间。
	TouchUsage(ctx context.Context, id int64, signCount uint32, usedAt int64) error
	// DeleteByUser 删掉该账号名下的一把密钥，返回是否真的删到了行。
	DeleteByUser(ctx context.Context, userID, id int64) (bool, error)
}

var defaultRepo WebAuthnCredentialRepo

func WebAuthnCredential() WebAuthnCredentialRepo          { return defaultRepo }
func RegisterWebAuthnCredential(i WebAuthnCredentialRepo) { defaultRepo = i }
func NewWebAuthnCredential() WebAuthnCredentialRepo       { return &repo{} }

type repo struct{}

func (r *repo) Create(ctx context.Context, c *webauthn_credential_entity.WebAuthnCredential) error {
	err := db.Ctx(ctx).Create(c).Error
	if dberr.IsDuplicateKey(err, credentialIDIndex) {
		return ErrCredentialTaken
	}
	return err
}

func (r *repo) ListByUser(ctx context.Context, userID int64) (
	[]*webauthn_credential_entity.WebAuthnCredential, error) {
	var out []*webauthn_credential_entity.WebAuthnCredential
	// 按 id 倒序而不是 createtime：同一毫秒内加的两把密钥用 createtime 排不出稳定次序，
	// 而自增 id 天然就是添加顺序。
	if err := db.Ctx(ctx).Where("user_id=?", userID).Order("id DESC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

func (r *repo) CountByUser(ctx context.Context, userID int64) (int64, error) {
	var n int64
	if err := db.Ctx(ctx).Model(&webauthn_credential_entity.WebAuthnCredential{}).
		Where("user_id=?", userID).Count(&n).Error; err != nil {
		return 0, err
	}
	return n, nil
}

func (r *repo) FindByCredentialID(ctx context.Context, credentialID []byte) (
	*webauthn_credential_entity.WebAuthnCredential, error) {
	// 认不出来的凭证是常态（密钥已被删、换了服务端），不是故障：与 user_repo.Find
	// 同一约定（(nil, nil)），交给上层给出一句人话。
	return dbutil.FindOne[webauthn_credential_entity.WebAuthnCredential](
		db.Ctx(ctx).Where("credential_id=?", credentialID))
}

func (r *repo) TouchUsage(ctx context.Context, id int64, signCount uint32, usedAt int64) error {
	// 只更新这三列：整行 Save 会把公钥、凭证 ID 一并重写，而它们注册之后就不该再变。
	return db.Ctx(ctx).Model(&webauthn_credential_entity.WebAuthnCredential{}).
		Where("id=?", id).
		Updates(map[string]any{
			"sign_count": signCount, "last_used_at": usedAt, "updatetime": usedAt,
		}).Error
}

func (r *repo) DeleteByUser(ctx context.Context, userID, id int64) (bool, error) {
	// id 与 user_id 同时进 WHERE：只按 id 删的话，任何登录用户都能删掉别人的密钥。
	res := db.Ctx(ctx).Where("id=? AND user_id=?", id, userID).
		Delete(&webauthn_credential_entity.WebAuthnCredential{})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}
