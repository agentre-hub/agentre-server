package sync_repo

import (
	"context"
	"time"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"agentre-server/internal/model/entity/sync_entity"
)

//go:generate mockgen -source state.go -destination mock_sync_repo/mock_state.go

type SyncStateRepo interface {
	// NextVersion 从账号级序列原子取走 n 个版本号，返回其中最大的那个（即本次
	// 分配到的最后一个版本）。多副本并发下由数据库裁决，进程内计数器不行。
	NextVersion(ctx context.Context, userID int64, n int64) (int64, error)
	// FindDeviceState 取某台设备最近一次成功同步的记录，没有返回 (nil, nil)
	// ——那是首次登录的设备，不算超窗口。
	FindDeviceState(ctx context.Context, userID, deviceID int64) (*sync_entity.DeviceSyncState, error)
	// TouchDeviceState 记下这台设备本次成功同步的时间。
	TouchDeviceState(ctx context.Context, userID, deviceID, nowMs int64) error
}

var defaultState SyncStateRepo

func SyncState() SyncStateRepo          { return defaultState }
func RegisterSyncState(i SyncStateRepo) { defaultState = i }
func NewSyncState() SyncStateRepo       { return &stateRepo{} }

type stateRepo struct{}

// NextVersion 必须是一条语句。先读后写在多副本并发上行时会双双读到同一个值、
// 两次上行拿到同一个版本号，R4 的「较大者胜」立刻失去可比性；INSERT … ON
// CONFLICT DO UPDATE … RETURNING 把递增与取值合成一次，由数据库的行锁串行化。
func (r *stateRepo) NextVersion(ctx context.Context, userID int64, n int64) (int64, error) {
	if n <= 0 {
		n = 1
	}
	now := time.Now().UnixMilli()
	var version int64
	err := db.Ctx(ctx).Raw(`INSERT INTO sync_account_seqs (user_id, version_seq, updatetime)
VALUES (?, ?, ?)
ON CONFLICT (user_id) DO UPDATE SET version_seq = sync_account_seqs.version_seq + ?, updatetime = ?
RETURNING version_seq`, userID, n, now, n, now).Scan(&version).Error
	if err != nil {
		return 0, err
	}
	return version, nil
}

func (r *stateRepo) FindDeviceState(ctx context.Context, userID, deviceID int64) (*sync_entity.DeviceSyncState, error) {
	ret := &sync_entity.DeviceSyncState{}
	err := db.Ctx(ctx).Where("user_id=? AND device_id=?", userID, deviceID).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

func (r *stateRepo) TouchDeviceState(ctx context.Context, userID, deviceID, nowMs int64) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "device_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"last_sync_at", "updatetime"}),
	}).Create(&sync_entity.DeviceSyncState{
		UserID: userID, DeviceID: deviceID, LastSyncAt: nowMs, Updatetime: nowMs,
	}).Error
}
