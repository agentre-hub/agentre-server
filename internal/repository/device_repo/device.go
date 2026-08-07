package device_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/consts"
	"gorm.io/gorm/clause"

	"agentre-server/internal/model/entity/device_entity"
)

//go:generate mockgen -source device.go -destination mock_device_repo/mock_device.go

type DeviceRepo interface {
	Find(ctx context.Context, id int64) (*device_entity.Device, error)
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

// Upsert 按 (user_id, fingerprint) 落库：走 uk_devices_user_fingerprint 的
// ON CONFLICT ... DO UPDATE，一条语句由数据库原子裁决。d.ID 与 d.Createtime 由
// RETURNING 回填。
//
// 不写成「先按 (user_id, fingerprint) 查、再 Save/Create」：那是先查后写，两个已授权的
// device_code 共用同一 (user_id, fingerprint) 并发换取时会双双查空、双双 INSERT，
// 竞败方撞唯一索引，拿到的是一个唯一约束错误（映射成 500）而不是任何约定的 OAuth 错误。
//
// createtime 不在赋值列里：命中已有设备时保留它首次注册的时间。
func (r *repo) Upsert(ctx context.Context, d *device_entity.Device) error {
	return db.Ctx(ctx).Clauses(
		clause.OnConflict{
			Columns: []clause.Column{{Name: "user_id"}, {Name: "fingerprint"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"name", "kind", "platform", "version",
				"capabilities", "last_seen_at", "status", "updatetime",
			}),
		},
		clause.Returning{Columns: []clause.Column{{Name: "id"}, {Name: "createtime"}}},
	).Create(d).Error
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
