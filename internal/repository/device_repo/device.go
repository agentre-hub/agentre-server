package device_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/consts"

	"agentre-server/internal/model/entity/device_entity"
)

//go:generate mockgen -source device.go -destination mock_device_repo/mock_device.go

type DeviceRepo interface {
	Find(ctx context.Context, id int64) (*device_entity.Device, error)
	FindByFingerprint(ctx context.Context, userID int64, fingerprint string) (*device_entity.Device, error)
	Upsert(ctx context.Context, d *device_entity.Device) error
	Touch(ctx context.Context, id, nowMs int64) error
	Revoke(ctx context.Context, id, nowMs int64) error
	ListByUser(ctx context.Context, userID int64) ([]*device_entity.Device, error)
}

var defaultRepo DeviceRepo

func Device() DeviceRepo          { return defaultRepo }
func RegisterDevice(i DeviceRepo) { defaultRepo = i }
func NewDevice() DeviceRepo       { return &repo{} }

type repo struct{}

func (r *repo) Find(ctx context.Context, id int64) (*device_entity.Device, error) {
	ret := &device_entity.Device{}
	err := db.Ctx(ctx).Where("id=?", id).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

func (r *repo) FindByFingerprint(ctx context.Context, userID int64, fp string) (*device_entity.Device, error) {
	ret := &device_entity.Device{}
	err := db.Ctx(ctx).Where("user_id=? AND fingerprint=?", userID, fp).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

// Upsert 按 (user_id, fingerprint) 查找：命中 → UPDATE；未命中 → INSERT。d.ID 会被设置。
func (r *repo) Upsert(ctx context.Context, d *device_entity.Device) error {
	existing, err := r.FindByFingerprint(ctx, d.UserID, d.Fingerprint)
	if err != nil {
		return err
	}
	if existing != nil {
		d.ID = existing.ID
		d.Createtime = existing.Createtime
		return db.Ctx(ctx).Save(d).Error
	}
	return db.Ctx(ctx).Create(d).Error
}

func (r *repo) Touch(ctx context.Context, id, nowMs int64) error {
	return db.Ctx(ctx).Model(&device_entity.Device{}).Where("id=?", id).
		Updates(map[string]interface{}{"last_seen_at": nowMs, "updatetime": nowMs}).Error
}

func (r *repo) Revoke(ctx context.Context, id, nowMs int64) error {
	return db.Ctx(ctx).Model(&device_entity.Device{}).Where("id=?", id).
		Updates(map[string]interface{}{"status": consts.DELETE, "updatetime": nowMs}).Error
}

func (r *repo) ListByUser(ctx context.Context, userID int64) ([]*device_entity.Device, error) {
	var out []*device_entity.Device
	if err := db.Ctx(ctx).Where("user_id=? AND status=?", userID, consts.ACTIVE).
		Order("last_seen_at DESC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
