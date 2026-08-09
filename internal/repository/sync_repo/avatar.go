package sync_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"agentre-server/internal/model/entity/sync_entity"
)

//go:generate mockgen -source avatar.go -destination mock_sync_repo/mock_avatar.go

type SyncAvatarRepo interface {
	// Find 按（账号, 内容哈希）取头像正文，没有返回 (nil, nil)。
	Find(ctx context.Context, userID int64, contentHash string) (*sync_entity.SyncAvatar, error)
	// Save 按（账号, 内容哈希）落库；同一份内容重复上传不产生第二行。
	Save(ctx context.Context, a *sync_entity.SyncAvatar) error
}

var defaultAvatar SyncAvatarRepo

func SyncAvatar() SyncAvatarRepo          { return defaultAvatar }
func RegisterSyncAvatar(i SyncAvatarRepo) { defaultAvatar = i }
func NewSyncAvatar() SyncAvatarRepo       { return &avatarRepo{} }

type avatarRepo struct{}

func (r *avatarRepo) Find(ctx context.Context, userID int64, contentHash string) (*sync_entity.SyncAvatar, error) {
	ret := &sync_entity.SyncAvatar{}
	err := db.Ctx(ctx).Where("user_id=? AND content_hash=?", userID, contentHash).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

// Save 走 DO NOTHING：主键就是内容哈希，同一份内容重复上传没有任何要更新的东西，
// 覆盖只会白白改写 createtime。
func (r *avatarRepo) Save(ctx context.Context, a *sync_entity.SyncAvatar) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(a).Error
}
