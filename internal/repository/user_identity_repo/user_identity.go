package user_identity_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"

	"agentre-hub/internal/model/entity/user_identity_entity"
)

//go:generate mockgen -source user_identity.go -destination mock_user_identity_repo/mock_user_identity.go

type UserIdentityRepo interface {
	Create(ctx context.Context, e *user_identity_entity.UserIdentity) error
	FindByProviderUID(ctx context.Context, provider, providerUID string) (*user_identity_entity.UserIdentity, error)
	ListByUser(ctx context.Context, userID int64) ([]*user_identity_entity.UserIdentity, error)
}

var defaultRepo UserIdentityRepo

func UserIdentity() UserIdentityRepo          { return defaultRepo }
func RegisterUserIdentity(i UserIdentityRepo) { defaultRepo = i }
func NewUserIdentity() UserIdentityRepo       { return &repo{} }

type repo struct{}

func (r *repo) Create(ctx context.Context, e *user_identity_entity.UserIdentity) error {
	return db.Ctx(ctx).Create(e).Error
}

func (r *repo) FindByProviderUID(ctx context.Context, provider, uid string) (*user_identity_entity.UserIdentity, error) {
	ret := &user_identity_entity.UserIdentity{}
	err := db.Ctx(ctx).Where("provider=? AND provider_uid=?", provider, uid).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

func (r *repo) ListByUser(ctx context.Context, userID int64) ([]*user_identity_entity.UserIdentity, error) {
	var out []*user_identity_entity.UserIdentity
	if err := db.Ctx(ctx).Where("user_id=?", userID).Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
