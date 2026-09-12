// Package user_svc 编排账号创建 / 查询。
package user_svc

import (
	"context"
	"time"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/consts"
	"gorm.io/gorm"

	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_identity_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/dberr"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_identity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
)

// uk_users_email_active、uk_user_identities_provider_uid：两个并发的同邮箱 /
// 同 GitHub identity 首次登录都会走到路径 3（全新建号），必然有一个撞上这两个
// 唯一键之一（要求 6）。两者都不是真正的错误——只是对方先提交，赢家已经把号建好
// 了——回查找路径重新走一遍就能拿到那一行。
var retryableDuplicateKeys = []string{
	"uk_users_email_active",
	"uk_user_identities_provider_uid",
}

func isRetryableGithubLoginRace(err error) bool {
	for _, idx := range retryableDuplicateKeys {
		if dberr.IsDuplicateKey(err, idx) {
			return true
		}
	}
	return false
}

type UserSvc interface {
	FindOrCreateFromGithub(ctx context.Context, p GithubProfile) (*user_entity.User, error)
	Find(ctx context.Context, id int64) (*user_entity.User, error)
	// GithubLogin 返回这个账号绑定的 GitHub 登录名；没绑过是常态（通行密钥注册
	// 的账号），回空串且不报错。
	GithubLogin(ctx context.Context, userID int64) (string, error)
}

type userSvc struct{}

var defaultUser = &userSvc{}

func User() UserSvc { return defaultUser }

func (s *userSvc) Find(ctx context.Context, id int64) (*user_entity.User, error) {
	return user_repo.User().Find(ctx, id)
}

func (s *userSvc) GithubLogin(ctx context.Context, userID int64) (string, error) {
	ident, err := user_identity_repo.UserIdentity().FindByUserAndProvider(
		ctx, userID, user_identity_entity.ProviderGithub)
	if err != nil || ident == nil {
		return "", err
	}
	return ident.ProviderLogin, nil
}

// FindOrCreateFromGithub 查找路径（provider_uid → email → 全新建号）本身不加锁，
// 两个并发的首次登录都能走到「都查不到、都去建号」这一步。落库时数据库的唯一键
// 会挡住其中一个：那次撞键不是故障，是「对方赢了」——重新走一遍查找路径正好读到
// 赢家刚提交的那一行。只重查一次：真出故障或者真的连续两次都撞上，就照常报错，
// 不无限重试。
func (s *userSvc) FindOrCreateFromGithub(ctx context.Context, p GithubProfile) (*user_entity.User, error) {
	u, err := s.findOrCreateFromGithubOnce(ctx, p)
	if err != nil && isRetryableGithubLoginRace(err) {
		u, err = s.findOrCreateFromGithubOnce(ctx, p)
	}
	return u, err
}

func (s *userSvc) findOrCreateFromGithubOnce(ctx context.Context, p GithubProfile) (*user_entity.User, error) {
	ident, err := user_identity_repo.UserIdentity().FindByProviderUID(ctx, user_identity_entity.ProviderGithub, p.GithubID)
	if err != nil {
		return nil, err
	}

	// 路径 1：identity 已存在。按 user_id 取账号行且不过滤状态——identity 行存在是被封
	// 账号的常态，用会过滤 status=ACTIVE 的 Find 会把封禁行当成「不存在」返回 (nil, nil)，
	// 调用方随后对 nil 解引用。这里改用 FindIgnoreStatus + Check，让封禁/其它不可用状态
	// 变成一个可辨认的错误，而不是悄悄丢账号。
	if ident != nil {
		u, err := user_repo.User().FindIgnoreStatus(ctx, ident.UserID)
		if err != nil {
			return nil, err
		}
		if err := u.Check(ctx); err != nil {
			return nil, err
		}
		return u, nil
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

	// 路径 3：全新 user + 序列行 + identity（一个事务）。序列行紧随 user 行预建：
	// 缺行的两个新账号并发首次取号会在 NextVersion 的回落分支上死锁（决策 20）。
	now := time.Now().UnixMilli()
	display := p.DisplayName
	if display == "" {
		display = p.Login
	}
	newUser := &user_entity.User{
		Email:       p.Email,
		DisplayName: display,
		AvatarURL:   p.AvatarURL,
		Status:      consts.ACTIVE,
		Createtime:  now,
		Updatetime:  now,
	}
	err = db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		txCtx := db.WithContextDB(ctx, tx)
		if err := user_repo.User().Create(txCtx, newUser); err != nil {
			return err
		}
		if err := sync_repo.SyncState().EnsureSeq(txCtx, newUser.ID); err != nil {
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
