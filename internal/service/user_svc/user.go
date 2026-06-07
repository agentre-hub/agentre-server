// Package user_svc 编排账号创建 / 查询。
package user_svc

import (
	"context"
	"time"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/consts"
	"gorm.io/gorm"

	"agentre-server/internal/model/entity/user_entity"
	"agentre-server/internal/model/entity/user_identity_entity"
	"agentre-server/internal/repository/user_identity_repo"
	"agentre-server/internal/repository/user_repo"
)

type UserSvc interface {
	FindOrCreateFromGithub(ctx context.Context, p GithubProfile) (*user_entity.User, error)
	Find(ctx context.Context, id int64) (*user_entity.User, error)
}

type userSvc struct{}

var defaultUser = &userSvc{}

func User() UserSvc { return defaultUser }

func (s *userSvc) Find(ctx context.Context, id int64) (*user_entity.User, error) {
	return user_repo.User().Find(ctx, id)
}

func (s *userSvc) FindOrCreateFromGithub(ctx context.Context, p GithubProfile) (*user_entity.User, error) {
	ident, err := user_identity_repo.UserIdentity().FindByProviderUID(ctx, user_identity_entity.ProviderGithub, p.GithubID)
	if err != nil {
		return nil, err
	}

	// 路径 1：identity 已存在
	if ident != nil {
		return user_repo.User().Find(ctx, ident.UserID)
	}

	// 路径 2：email 已存在 → 绑定新 identity
	existing, err := user_repo.User().FindByEmail(ctx, p.Email)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if err := s.createIdentity(ctx, existing.ID, p); err != nil {
			return nil, err
		}
		return existing, nil
	}

	// 路径 3：全新 user + identity（一个事务）
	now := time.Now().UnixMilli()
	display := p.DisplayName
	if display == "" {
		display = p.Login
	}
	newUser := &user_entity.User{
		Email:         p.Email,
		EmailVerified: true,
		DisplayName:   display,
		AvatarURL:     p.AvatarURL,
		Status:        consts.ACTIVE,
		Createtime:    now,
		Updatetime:    now,
	}
	err = db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		txCtx := db.WithContextDB(ctx, tx)
		if err := user_repo.User().Create(txCtx, newUser); err != nil {
			return err
		}
		return s.createIdentity(txCtx, newUser.ID, p)
	})
	if err != nil {
		return nil, err
	}
	return newUser, nil
}

func (s *userSvc) createIdentity(ctx context.Context, userID int64, p GithubProfile) error {
	now := time.Now().UnixMilli()
	raw := p.RawProfile
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	return user_identity_repo.UserIdentity().Create(ctx, &user_identity_entity.UserIdentity{
		UserID:        userID,
		Provider:      user_identity_entity.ProviderGithub,
		ProviderUID:   p.GithubID,
		ProviderLogin: p.Login,
		Email:         p.Email,
		RawProfile:    raw,
		Createtime:    now,
		Updatetime:    now,
	})
}
