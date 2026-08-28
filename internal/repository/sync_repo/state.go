package sync_repo

import (
	"context"
	"time"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source state.go -destination mock_sync_repo/mock_state.go

type SyncStateRepo interface {
	// NextVersion 从账号级序列原子取走 n 个版本号，返回其中最大的那个（即本次
	// 分配到的最后一个版本）。多副本并发下由数据库裁决，进程内计数器不行。
	NextVersion(ctx context.Context, userID int64, n int64) (int64, error)
	// CurrentVersion 取账号级序列**当前的头**（最近一次分配出去的版本号），
	// 不推进它；账号还没分配过任何版本时返回 0。
	//
	// 它回答的是「这个账号的历史到哪为止」：设备送来的游标大于它，那段历史就不是
	// 本账号发出的（库被重建，或换了一套服务端）。
	CurrentVersion(ctx context.Context, userID int64) (int64, error)
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

// NextVersion 的递增与取值必须由数据库一次做完。先读后写在多副本并发上行时会双双读到
// 同一个值、两次上行拿到同一个版本号，R4 的「较大者胜」立刻失去可比性。
//
// MySQL 没有 RETURNING，这里用它自己的写法：INSERT … ON DUPLICATE KEY UPDATE 里把新值
// 套进 LAST_INSERT_ID(expr)，该函数在设置的同时把值记在**连接**上，紧接着一条
// SELECT LAST_INSERT_ID() 就能取回。递增由行锁串行化。外面那层事务不是为了原子性，
// 而是为了把两条语句钉在同一条连接上——LAST_INSERT_ID 是连接级的，走连接池会取到别人的值。
func (r *stateRepo) NextVersion(ctx context.Context, userID int64, n int64) (int64, error) {
	now := time.Now().UnixMilli()
	var version int64
	err := db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`INSERT INTO sync_account_seqs (user_id, version_seq, updatetime)
VALUES (?, LAST_INSERT_ID(?), ?)
ON DUPLICATE KEY UPDATE version_seq = LAST_INSERT_ID(version_seq + ?), updatetime = ?`,
			userID, n, now, n, now).Error; err != nil {
			return err
		}
		return tx.Raw("SELECT LAST_INSERT_ID()").Scan(&version).Error
	})
	if err != nil {
		return 0, err
	}
	return version, nil
}

// CurrentVersion 只读序列的当前值，绝不推进它——推进要么由 NextVersion 一次做完，
// 要么就不该发生。sync_account_seqs 刻意没有 entity（见 sync_entity 的注释），这里
// 因此是一条原生 SELECT；没有这一行说明该账号一个版本都没分配过，返回 0 而不是错误
// ——那是「历史为空」，不是「查不到」。
func (r *stateRepo) CurrentVersion(ctx context.Context, userID int64) (int64, error) {
	var version int64
	if err := db.Ctx(ctx).
		Raw("SELECT version_seq FROM sync_account_seqs WHERE user_id = ?", userID).
		Scan(&version).Error; err != nil {
		return 0, err
	}
	return version, nil
}

func (r *stateRepo) FindDeviceState(ctx context.Context, userID, deviceID int64) (*sync_entity.DeviceSyncState, error) {
	return dbutil.FindOne[sync_entity.DeviceSyncState](
		db.Ctx(ctx).Where("user_id=? AND device_id=?", userID, deviceID))
}

func (r *stateRepo) TouchDeviceState(ctx context.Context, userID, deviceID, nowMs int64) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "device_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"last_sync_at", "updatetime"}),
	}).Create(&sync_entity.DeviceSyncState{
		UserID: userID, DeviceID: deviceID, LastSyncAt: nowMs, Updatetime: nowMs,
	}).Error
}
