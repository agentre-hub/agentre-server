// Package user_repo 维护 users 表读写。
package user_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/consts"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source user.go -destination mock_user_repo/mock_user.go

type UserRepo interface {
	Create(ctx context.Context, u *user_entity.User) error
	Find(ctx context.Context, id int64) (*user_entity.User, error)
	// FindIgnoreStatus 按 id 取账号行且不过滤状态：封禁 / 其它非 ACTIVE 状态的行也会被
	// 取回，交给 user_entity.Check 判定，而不是被 Find 的 status=ACTIVE 过滤成 (nil, nil)。
	FindIgnoreStatus(ctx context.Context, id int64) (*user_entity.User, error)
	FindByEmail(ctx context.Context, email string) (*user_entity.User, error)
	Update(ctx context.Context, u *user_entity.User) error
	// WebAuthnHandle 取该账号的 WebAuthn user handle；从未生成过时返回空。
	//
	// handle 不在 user_entity.User 上：那个结构体是 Save 的写入面，多一个字段就意味着
	// 每一次账号更新都会连带重写这一列，而它一旦发出去就绝不能变（可发现凭证把它存进了
	// 认证器）。单独一对读写方法把它圈在这里。
	WebAuthnHandle(ctx context.Context, id int64) ([]byte, error)
	// SetWebAuthnHandleIfEmpty 只在该列仍为空时写入，返回是否由本次写入落定。
	// 多副本同时首次注册通行密钥时，由数据库裁决谁先写成，竞败方拿 false 回头再读一次。
	SetWebAuthnHandleIfEmpty(ctx context.Context, id int64, handle []byte) (bool, error)
}

var defaultUser UserRepo

func User() UserRepo          { return defaultUser }
func RegisterUser(i UserRepo) { defaultUser = i }
func NewUser() UserRepo       { return &userRepo{} }

type userRepo struct{}

func (u *userRepo) Create(ctx context.Context, e *user_entity.User) error {
	return db.Ctx(ctx).Create(e).Error
}

func (u *userRepo) Find(ctx context.Context, id int64) (*user_entity.User, error) {
	return dbutil.FindOne[user_entity.User](db.Ctx(ctx).Where("id=? AND status=?", id, consts.ACTIVE))
}

func (u *userRepo) FindIgnoreStatus(ctx context.Context, id int64) (*user_entity.User, error) {
	return dbutil.FindOne[user_entity.User](db.Ctx(ctx).Where("id=?", id))
}

func (u *userRepo) FindByEmail(ctx context.Context, email string) (*user_entity.User, error) {
	return dbutil.FindOne[user_entity.User](db.Ctx(ctx).Where("email=? AND status=?", email, consts.ACTIVE))
}

func (u *userRepo) Update(ctx context.Context, e *user_entity.User) error {
	return db.Ctx(ctx).Save(e).Error
}

func (u *userRepo) WebAuthnHandle(ctx context.Context, id int64) ([]byte, error) {
	var row struct {
		WebAuthnHandle []byte `gorm:"column:webauthn_handle"`
	}
	if err := db.Ctx(ctx).Model(&user_entity.User{}).Select("webauthn_handle").
		Where("id=?", id).Limit(1).Scan(&row).Error; err != nil {
		return nil, err
	}
	return row.WebAuthnHandle, nil
}

func (u *userRepo) SetWebAuthnHandleIfEmpty(ctx context.Context, id int64, handle []byte) (bool, error) {
	res := db.Ctx(ctx).Model(&user_entity.User{}).
		Where("id=? AND (webauthn_handle IS NULL OR webauthn_handle='')", id).
		Update("webauthn_handle", handle)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}
