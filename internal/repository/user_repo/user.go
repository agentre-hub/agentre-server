// Package user_repo 维护 users 表读写。
package user_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/consts"

	"agentre-hub/internal/model/entity/user_entity"
)

//go:generate mockgen -source user.go -destination mock_user_repo/mock_user.go

type UserRepo interface {
	Create(ctx context.Context, u *user_entity.User) error
	Find(ctx context.Context, id int64) (*user_entity.User, error)
	FindByEmail(ctx context.Context, email string) (*user_entity.User, error)
	Update(ctx context.Context, u *user_entity.User) error
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
	ret := &user_entity.User{}
	err := db.Ctx(ctx).Where("id=? AND status=?", id, consts.ACTIVE).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

func (u *userRepo) FindByEmail(ctx context.Context, email string) (*user_entity.User, error) {
	ret := &user_entity.User{}
	err := db.Ctx(ctx).Where("email=? AND status=?", email, consts.ACTIVE).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

func (u *userRepo) Update(ctx context.Context, e *user_entity.User) error {
	return db.Ctx(ctx).Save(e).Error
}
