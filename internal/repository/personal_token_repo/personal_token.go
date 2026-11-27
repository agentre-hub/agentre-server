package personal_token_repo

import (
	"context"
	"time"

	"github.com/cago-frame/cago/database/db"

	"github.com/agentre-hub/agentre-server/internal/model/entity/personal_token_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source personal_token.go -destination mock_personal_token_repo/mock_personal_token.go

// PersonalTokenRepo 是 personal_tokens 的数据访问。查不到的单行读取一律返回 (nil, nil)。
type PersonalTokenRepo interface {
	// Create 落一枚新 token。名字撞上 uk_personal_tokens_user_name 时原样上抛驱动错误，
	// 由 service 认领成「名字已被占用」。
	Create(ctx context.Context, e *personal_token_entity.PersonalToken) error
	Find(ctx context.Context, id int64) (*personal_token_entity.PersonalToken, error)
	// FindByHash 按密钥摘要取行（bearer 解析的唯一入口）。
	FindByHash(ctx context.Context, hash string) (*personal_token_entity.PersonalToken, error)
	FindByName(ctx context.Context, userID int64, name string) (*personal_token_entity.PersonalToken, error)
	// ListByUser 交出账号下全部 token，按创建先后排列。
	ListByUser(ctx context.Context, userID int64) ([]*personal_token_entity.PersonalToken, error)
	// UpdateSecret 把一行换成 e 上的新密钥与期限（token_hash / lifetime_ms / expires_at /
	// rotated_at），名字、范围与对端指纹不动。只在这一行的密钥仍是 prevHash 时写：并发的
	// 另一次轮换先换掉了它，这一次就不落（受影响 0 行），免得交出一枚已经被覆盖的密钥。
	// 返回受影响行数。
	UpdateSecret(ctx context.Context, e *personal_token_entity.PersonalToken, prevHash string) (int64, error)
	// DeleteByName 吊销（硬删）账号下的一枚 token，返回受影响行数。
	DeleteByName(ctx context.Context, userID int64, name string) (int64, error)
	// TouchLastUsed 记下最近使用时刻。
	TouchLastUsed(ctx context.Context, id, nowMs int64) error
}

var defaultRepo PersonalTokenRepo

func PersonalToken() PersonalTokenRepo          { return defaultRepo }
func RegisterPersonalToken(i PersonalTokenRepo) { defaultRepo = i }
func NewPersonalToken() PersonalTokenRepo       { return &repo{} }

type repo struct{}

func (r *repo) Create(ctx context.Context, e *personal_token_entity.PersonalToken) error {
	if e.Createtime == 0 {
		e.Createtime = time.Now().UnixMilli()
	}
	if e.Updatetime == 0 {
		e.Updatetime = e.Createtime
	}
	return db.Ctx(ctx).Create(e).Error
}

func (r *repo) Find(ctx context.Context, id int64) (*personal_token_entity.PersonalToken, error) {
	return dbutil.FindOne[personal_token_entity.PersonalToken](db.Ctx(ctx).Where("id=?", id))
}

// FindByHash 走 uk_personal_tokens_token_hash 的等值查找。
func (r *repo) FindByHash(ctx context.Context, hash string) (*personal_token_entity.PersonalToken, error) {
	return dbutil.FindOne[personal_token_entity.PersonalToken](db.Ctx(ctx).Where("token_hash=?", hash))
}

// FindByName 走 uk_personal_tokens_user_name；name 列大小写不敏感，与唯一键同一个判据。
func (r *repo) FindByName(ctx context.Context, userID int64, name string) (*personal_token_entity.PersonalToken, error) {
	return dbutil.FindOne[personal_token_entity.PersonalToken](db.Ctx(ctx).Where("user_id=? AND name=?", userID, name))
}

func (r *repo) ListByUser(ctx context.Context, userID int64) ([]*personal_token_entity.PersonalToken, error) {
	var out []*personal_token_entity.PersonalToken
	if err := db.Ctx(ctx).Where("user_id=?", userID).Order("id").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

func (r *repo) UpdateSecret(ctx context.Context, e *personal_token_entity.PersonalToken, prevHash string) (int64, error) {
	res := db.Ctx(ctx).Model(&personal_token_entity.PersonalToken{}).Where("id=? AND token_hash=?", e.ID, prevHash).Updates(map[string]any{
		"token_hash":  e.TokenHash,
		"lifetime_ms": e.LifetimeMs,
		"expires_at":  e.ExpiresAt,
		"rotated_at":  e.RotatedAt,
		"updatetime":  time.Now().UnixMilli(),
	})
	return res.RowsAffected, res.Error
}

func (r *repo) DeleteByName(ctx context.Context, userID int64, name string) (int64, error) {
	res := db.Ctx(ctx).Where("user_id=? AND name=?", userID, name).Delete(&personal_token_entity.PersonalToken{})
	return res.RowsAffected, res.Error
}

func (r *repo) TouchLastUsed(ctx context.Context, id, nowMs int64) error {
	return db.Ctx(ctx).Model(&personal_token_entity.PersonalToken{}).Where("id=?", id).
		Update("last_used_at", nowMs).Error
}
