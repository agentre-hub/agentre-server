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

// NextVersion 的递增必须由数据库一条语句做完。先读后写在多副本并发上行时会双双读到
// 同一个值、两次上行拿到同一个版本号，R4 的「较大者胜」立刻失去可比性。
//
// 推进先走一条只按 user_id 定位的普通 UPDATE，命中 0 行（账号第一次取号，那一行还
// 不存在）才落回 INSERT … ON DUPLICATE KEY UPDATE。不是一上来就 upsert，是因为锁的
// 范围：MySQL 9.7 实测（.dev-kit/artifacts/db-perf-fixes/nextversion-lock/），upsert
// 命中已有行时除了那一行，还在主键的 supremum 伪记录上持一把 X 锁到提交，别的账号的
// 取号都要等它——Push 把取号放在整批写入的事务里，一个账号的长事务于是串行化全站。
// 普通 UPDATE 只持这一行的 X 锁：同账号仍然串行（「取号顺序 == 提交顺序」不变），他
// 账号互不等待。首次取号的回落仍要 ON DUPLICATE：同账号两次首次取号并发时两边 UPDATE
// 都命中 0 行，后到的 INSERT 必须由它接住并推进同一行，而不是撞唯一键失败。
//
// MySQL 没有 RETURNING，所以推进和取回是两条语句，钉在同一个事务里：那一行的排他锁
// 由推进持到提交，期间没有别人能改它，紧随其后的 SELECT 读到的因此就是本次分配到
// 的值。事务在这里是**必需的**而不是修饰——没有它，两条语句之间会挤进另一个副本的
// 推进，取回的就是别人的号。
//
// 取回**不能**走 LAST_INSERT_ID()。这张表现在有一个 AUTO_INCREMENT 的 id 主键，而一次
// 真的插入了行的 INSERT 会把自增值写进同一个连接级变量，把 LAST_INSERT_ID(expr) 存进去
// 的版本号顶掉；每个账号第一次分配因此会拿回 id 而不是版本号（MySQL 9.7 实测：期望 5、
// 实得 1）。落库的 version_seq 始终正确，错的只有交回调用方的那个数。
func (r *stateRepo) NextVersion(ctx context.Context, userID int64, n int64) (int64, error) {
	now := time.Now().UnixMilli()
	var version int64
	err := db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		updated := tx.Exec(`UPDATE sync_account_seqs SET version_seq = version_seq + ?, updatetime = ? WHERE user_id = ?`,
			n, now, userID)
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected == 0 {
			if err := tx.Exec(`INSERT INTO sync_account_seqs (user_id, version_seq, updatetime)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE version_seq = version_seq + ?, updatetime = ?`,
				userID, n, now, n, now).Error; err != nil {
				return err
			}
		}
		return tx.Raw("SELECT version_seq FROM sync_account_seqs WHERE user_id = ?", userID).
			Scan(&version).Error
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
