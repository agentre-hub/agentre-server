// Package exec_order_repo 是「每台设备自己的执行目标排列」的数据访问层。
package exec_order_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"agentre-server/internal/model/entity/exec_order_entity"
)

//go:generate mockgen -source exec_order.go -destination mock_exec_order_repo/mock_exec_order.go

type ExecOrderRepo interface {
	// Find 取某台设备对某个 Agent 的排列；没有这一行时返回 (nil, nil)——「这台设备
	// 还没排过序」是常态，不是错误。
	Find(ctx context.Context, userID, deviceID int64, agentSyncID string) (*exec_order_entity.DeviceExecTargetOrder, error)
	// ListByDevice 一次取某台设备对全部 Agent 的排列，供总览页一屏渲染多个 Agent
	// 卡片时不必按 Agent 逐条查库。
	ListByDevice(ctx context.Context, userID, deviceID int64) ([]*exec_order_entity.DeviceExecTargetOrder, error)
	// Save 整体替换一条排列（决策 13：排列永远被整体读写）。
	Save(ctx context.Context, o *exec_order_entity.DeviceExecTargetOrder) error
	// DeleteByDevice 删除某台设备名下全部排列：设备被解除授权 / 删除时，它的顺序
	// 一并消失。device_id 是全局自增主键、天然只属于一个账号，不需要再传 user_id
	// 校验归属（与 sync_repo.SyncLocalPath().DeleteByDevice 同一约定）。
	DeleteByDevice(ctx context.Context, deviceID int64) error
}

var defaultRepo ExecOrderRepo

func ExecOrder() ExecOrderRepo          { return defaultRepo }
func RegisterExecOrder(i ExecOrderRepo) { defaultRepo = i }
func NewExecOrder() ExecOrderRepo       { return &repo{} }

type repo struct{}

func (r *repo) Find(
	ctx context.Context, userID, deviceID int64, agentSyncID string,
) (*exec_order_entity.DeviceExecTargetOrder, error) {
	ret := &exec_order_entity.DeviceExecTargetOrder{}
	err := db.Ctx(ctx).Where("user_id=? AND device_id=? AND agent_sync_id=?",
		userID, deviceID, agentSyncID).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

func (r *repo) ListByDevice(
	ctx context.Context, userID, deviceID int64,
) ([]*exec_order_entity.DeviceExecTargetOrder, error) {
	var out []*exec_order_entity.DeviceExecTargetOrder
	if err := db.Ctx(ctx).Where("user_id=? AND device_id=?", userID, deviceID).
		Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

// Save 是一条语句的 upsert：同一 (user_id, device_id, agent_sync_id) 再排一次要覆盖
// 旧排列，由数据库原子裁决。先查再写会在两个标签页同时提交时双双走到 INSERT，
// 竞败方撞主键拿到一个约束错误。表上只有主键这一个唯一键，所以 ON DUPLICATE KEY
// 命中的必然是它。
func (r *repo) Save(ctx context.Context, o *exec_order_entity.DeviceExecTargetOrder) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "user_id"}, {Name: "device_id"}, {Name: "agent_sync_id"},
		},
		DoUpdates: clause.AssignmentColumns([]string{"order_json", "updatetime"}),
	}).Create(o).Error
}

func (r *repo) DeleteByDevice(ctx context.Context, deviceID int64) error {
	return db.Ctx(ctx).Where("device_id=?", deviceID).
		Delete(&exec_order_entity.DeviceExecTargetOrder{}).Error
}
