package sync_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
)

//go:generate mockgen -source local_path.go -destination mock_sync_repo/mock_local_path.go

type SyncLocalPathRepo interface {
	// ReplaceSnapshot 用整份快照替换某台设备的本机路径清单：上报组没有删除时间，
	// 删除靠「这次快照里没有它」生效。
	ReplaceSnapshot(ctx context.Context, userID, deviceID int64, items []*sync_entity.DeviceLocalPath) error
	// DeleteByDevice 删除某台设备名下全部本机路径记录（R18：设备记录被删除时，
	// 它的上报清单一并消失）。device_id 是全局自增主键，天然只属于一个账号，
	// 不需要再传 user_id 校验归属。
	DeleteByDevice(ctx context.Context, deviceID int64) error
	// ListByDevice 取某台设备上报的整份本机路径清单，供设备展开页判断
	// 「这台机器上哪些项目已配置」——只看归属，不对外暴露路径正文（R19）。
	ListByDevice(ctx context.Context, userID, deviceID int64) ([]*sync_entity.DeviceLocalPath, error)
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

func (r *localPathRepo) DeleteByDevice(ctx context.Context, deviceID int64) error {
	return db.Ctx(ctx).Where("device_id=?", deviceID).Delete(&sync_entity.DeviceLocalPath{}).Error
}

func (r *localPathRepo) ListByDevice(ctx context.Context, userID, deviceID int64) ([]*sync_entity.DeviceLocalPath, error) {
	var out []*sync_entity.DeviceLocalPath
	if err := db.Ctx(ctx).Where("user_id=? AND device_id=?", userID, deviceID).Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
