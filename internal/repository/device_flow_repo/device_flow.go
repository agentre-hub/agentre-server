package device_flow_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"

	"agentre-server/internal/model/entity/device_flow_entity"
)

//go:generate mockgen -source device_flow.go -destination mock_device_flow_repo/mock_device_flow.go

type DeviceFlowRepo interface {
	Create(ctx context.Context, e *device_flow_entity.DeviceFlowCode) error
	FindByDeviceCode(ctx context.Context, deviceCode string) (*device_flow_entity.DeviceFlowCode, error)
	FindPendingByUserCode(ctx context.Context, userCode string) (*device_flow_entity.DeviceFlowCode, error)
	Approve(ctx context.Context, userCode string, userID, nowMs int64) error
	Deny(ctx context.Context, userCode string, nowMs int64) error
	MarkConsumed(ctx context.Context, deviceCode string, nowMs int64) error
	UpdateLastPolled(ctx context.Context, deviceCode string, nowMs int64) error
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
	ret := &device_flow_entity.DeviceFlowCode{}
	err := db.Ctx(ctx).Where("device_code=?", dc).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

func (r *repo) FindPendingByUserCode(ctx context.Context, uc string) (*device_flow_entity.DeviceFlowCode, error) {
	ret := &device_flow_entity.DeviceFlowCode{}
	err := db.Ctx(ctx).
		Where("user_code=? AND consumed_at=0 AND denied_at=0", uc).
		First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

func (r *repo) Approve(ctx context.Context, uc string, userID, nowMs int64) error {
	res := db.Ctx(ctx).Model(&device_flow_entity.DeviceFlowCode{}).
		Where("user_code=? AND consumed_at=0 AND denied_at=0 AND expires_at > ?", uc, nowMs).
		Updates(map[string]interface{}{"authorized_user_id": userID, "approved_at": nowMs})
	return res.Error
}

func (r *repo) Deny(ctx context.Context, uc string, nowMs int64) error {
	return db.Ctx(ctx).Model(&device_flow_entity.DeviceFlowCode{}).
		Where("user_code=? AND consumed_at=0 AND denied_at=0", uc).
		Update("denied_at", nowMs).Error
}

func (r *repo) MarkConsumed(ctx context.Context, dc string, nowMs int64) error {
	return db.Ctx(ctx).Model(&device_flow_entity.DeviceFlowCode{}).
		Where("device_code=?", dc).
		Update("consumed_at", nowMs).Error
}

func (r *repo) UpdateLastPolled(ctx context.Context, dc string, nowMs int64) error {
	return db.Ctx(ctx).Model(&device_flow_entity.DeviceFlowCode{}).
		Where("device_code=?", dc).
		Update("last_polled_at", nowMs).Error
}

func (r *repo) DeleteExpiredBefore(ctx context.Context, cutoffMs int64) error {
	return db.Ctx(ctx).Where("expires_at < ?", cutoffMs).
		Delete(&device_flow_entity.DeviceFlowCode{}).Error
}
