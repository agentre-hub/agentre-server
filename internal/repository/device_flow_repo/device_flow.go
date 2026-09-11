package device_flow_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_flow_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source device_flow.go -destination mock_device_flow_repo/mock_device_flow.go

// cleanupBatchSize 与 device_token_repo 的清理常量一致：过期码可能积到很大，
// 不分批的一条 DELETE 会把 next-key 锁铺满它扫过的整个范围。
const cleanupBatchSize = 1000

type DeviceFlowRepo interface {
	Create(ctx context.Context, e *device_flow_entity.DeviceFlowCode) error
	FindByDeviceCode(ctx context.Context, deviceCode string) (*device_flow_entity.DeviceFlowCode, error)
	FindPendingByUserCode(ctx context.Context, userCode string) (*device_flow_entity.DeviceFlowCode, error)
	// Approve / Deny / MarkConsumed / UpdateLastPolledIfDue 返回受影响行数，
	// 由 service 判读竞态结果。
	Approve(ctx context.Context, userCode string, userID, nowMs int64) (int64, error)
	Deny(ctx context.Context, userCode string, nowMs int64) (int64, error)
	MarkConsumed(ctx context.Context, deviceCode string, nowMs int64) (int64, error)
	// UpdateLastPolledIfDue 只在 last_polled_at <= nowMs-minGapMs 时才更新，把
	// 「读间隔是否够、再无条件写」的 check-then-act 收进一条条件 UPDATE：两个并发
	// 或重复的轮询打到同一行时，数据库只让其中一个改到行，另一个凭 0 行判 slow_down。
	UpdateLastPolledIfDue(ctx context.Context, deviceCode string, nowMs, minGapMs int64) (int64, error)
	DeleteExpiredBefore(ctx context.Context, cutoffMs int64) error
}

var defaultRepo DeviceFlowRepo

func DeviceFlow() DeviceFlowRepo          { return defaultRepo }
func RegisterDeviceFlow(i DeviceFlowRepo) { defaultRepo = i }
func NewDeviceFlow() DeviceFlowRepo       { return &repo{} }

type repo struct{}

func (r *repo) Create(ctx context.Context, e *device_flow_entity.DeviceFlowCode) error {
	return db.Ctx(ctx).Create(e).Error
}

func (r *repo) FindByDeviceCode(ctx context.Context, dc string) (*device_flow_entity.DeviceFlowCode, error) {
	return dbutil.FindOne[device_flow_entity.DeviceFlowCode](db.Ctx(ctx).Where("device_code=?", dc))
}

func (r *repo) FindPendingByUserCode(ctx context.Context, uc string) (*device_flow_entity.DeviceFlowCode, error) {
	return dbutil.FindOne[device_flow_entity.DeviceFlowCode](
		db.Ctx(ctx).Where("user_code=? AND consumed_at=0 AND denied_at=0", uc))
}

func (r *repo) Approve(ctx context.Context, uc string, userID, nowMs int64) (int64, error) {
	res := db.Ctx(ctx).Model(&device_flow_entity.DeviceFlowCode{}).
		Where("user_code=? AND consumed_at=0 AND denied_at=0 AND expires_at > ?", uc, nowMs).
		Updates(map[string]interface{}{"authorized_user_id": userID, "approved_at": nowMs})
	return res.RowsAffected, res.Error
}

func (r *repo) Deny(ctx context.Context, uc string, nowMs int64) (int64, error) {
	res := db.Ctx(ctx).Model(&device_flow_entity.DeviceFlowCode{}).
		Where("user_code=? AND consumed_at=0 AND denied_at=0", uc).
		Update("denied_at", nowMs)
	return res.RowsAffected, res.Error
}

// MarkConsumed 的 consumed_at=0 条件让并发换取只有一个请求改到行；denied_at=0 与
// Approve / Deny 的条件集对齐：service 里的 IsDenied() 只是抢跑检查，用户点「拒绝」
// 的事务若在那之后才提交，少了这个条件的 UPDATE 照样命中 1 行，设备就在用户明确
// 拒绝之后仍然拿到了 token。
func (r *repo) MarkConsumed(ctx context.Context, dc string, nowMs int64) (int64, error) {
	res := db.Ctx(ctx).Model(&device_flow_entity.DeviceFlowCode{}).
		Where("device_code=? AND consumed_at=0 AND denied_at=0", dc).
		Update("consumed_at", nowMs)
	return res.RowsAffected, res.Error
}

func (r *repo) UpdateLastPolledIfDue(ctx context.Context, dc string, nowMs, minGapMs int64) (int64, error) {
	res := db.Ctx(ctx).Model(&device_flow_entity.DeviceFlowCode{}).
		Where("device_code=? AND last_polled_at <= ?", dc, nowMs-minGapMs).
		Update("last_polled_at", nowMs)
	return res.RowsAffected, res.Error
}

// DeleteExpiredBefore 按 cleanupBatchSize 行一批删，直到某一批没删满——没删满
// 就说明够到底了。与 device_token_repo.deleteBatched 是同一个理由、同一个常量。
func (r *repo) DeleteExpiredBefore(ctx context.Context, cutoffMs int64) error {
	for {
		res := db.Ctx(ctx).Where("expires_at < ?", cutoffMs).
			Limit(cleanupBatchSize).
			Delete(&device_flow_entity.DeviceFlowCode{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected < cleanupBatchSize {
			return nil
		}
	}
}
