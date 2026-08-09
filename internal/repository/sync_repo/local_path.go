package sync_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"

	"agentre-server/internal/model/entity/sync_entity"
)

//go:generate mockgen -source local_path.go -destination mock_sync_repo/mock_local_path.go

type SyncLocalPathRepo interface {
	// ReplaceSnapshot 用整份快照替换某台设备的本机路径清单：上报组没有删除时间，
	// 删除靠「这次快照里没有它」生效。
	ReplaceSnapshot(ctx context.Context, userID, deviceID int64, items []*sync_entity.DeviceLocalPath) error
}

var defaultLocalPath SyncLocalPathRepo

func SyncLocalPath() SyncLocalPathRepo          { return defaultLocalPath }
func RegisterSyncLocalPath(i SyncLocalPathRepo) { defaultLocalPath = i }
func NewSyncLocalPath() SyncLocalPathRepo       { return &localPathRepo{} }

type localPathRepo struct{}

// ReplaceSnapshot 的清空与重写在同一个事务里：中途失败会让服务端的清单空掉，
// 而上报组没有版本号可以判断「这份清单是不是残缺的」。
func (r *localPathRepo) ReplaceSnapshot(
	ctx context.Context, userID, deviceID int64, items []*sync_entity.DeviceLocalPath,
) error {
	return db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id=? AND device_id=?", userID, deviceID).
			Delete(&sync_entity.DeviceLocalPath{}).Error; err != nil {
			return err
		}
		if len(items) == 0 {
			return nil
		}
		return tx.Create(items).Error
	})
}
