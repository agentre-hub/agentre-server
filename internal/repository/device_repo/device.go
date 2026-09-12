package device_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/consts"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source device.go -destination mock_device_repo/mock_device.go

type DeviceRepo interface {
	Find(ctx context.Context, id int64) (*device_entity.Device, error)
	FindByFingerprint(ctx context.Context, userID int64, fingerprint string) (*device_entity.Device, error)
	Upsert(ctx context.Context, d *device_entity.Device) error
	Touch(ctx context.Context, id, nowMs int64) error
	// UpdateVersion 按新值刷新这台设备的 version。调用方（mirror_svc，镜像握手成功后）
	// 自己先比过当前值才决定要不要调它——这条方法本身不做条件判断，直接写。
	UpdateVersion(ctx context.Context, id int64, version string, nowMs int64) error
	Revoke(ctx context.Context, id, nowMs int64) error
	ListByUser(ctx context.Context, userID int64) ([]*device_entity.Device, error)
}

var defaultRepo DeviceRepo

func Device() DeviceRepo          { return defaultRepo }
func RegisterDevice(i DeviceRepo) { defaultRepo = i }
func NewDevice() DeviceRepo       { return &repo{} }

type repo struct{}

func (r *repo) Find(ctx context.Context, id int64) (*device_entity.Device, error) {
	return dbutil.FindOne[device_entity.Device](db.Ctx(ctx).Where("id=?", id))
}

// FindByFingerprint 按 (user_id, fingerprint) 查一台设备，查不到返回 (nil, nil)。
// Upsert 已不再用它（改走数据库原子 upsert），relay_svc 解析中继目标时用。
func (r *repo) FindByFingerprint(ctx context.Context, userID int64, fp string) (*device_entity.Device, error) {
	return dbutil.FindOne[device_entity.Device](db.Ctx(ctx).Where("user_id=? AND fingerprint=?", userID, fp))
}

// Upsert 按 (user_id, fingerprint) 落库：走 uk_devices_user_fingerprint 的
// ON DUPLICATE KEY UPDATE 由数据库原子裁决。devices 上只有这一个唯一键，所以这条
// 语句命中的必然是它——多唯一键的表不能这么写（见 sync_repo.Save）。
//
// MySQL 没有 RETURNING，所以写入后在同一事务内读回最终行来填充 d：命中已有设备时
// 拿到的是它原来的 id 与 createtime。
//
// 不写成「先按 (user_id, fingerprint) 查、再 Save/Create」：那是先查后写，两个已授权的
// device_code 共用同一 (user_id, fingerprint) 并发换取时会双双查空、双双 INSERT，
// 竞败方撞唯一索引，拿到的是一个唯一约束错误（映射成 500）而不是任何约定的 OAuth 错误。
//
// createtime 不在赋值列里：命中已有设备时保留它首次注册的时间。
func (r *repo) Upsert(ctx context.Context, d *device_entity.Device) error {
	return db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "user_id"}, {Name: "fingerprint"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"name", "kind", "platform", "version",
				"last_seen_at", "status", "updatetime",
			}),
		}).Create(d).Error; err != nil {
			return err
		}
		final := &device_entity.Device{}
		if err := tx.Where("user_id=? AND fingerprint=?", d.UserID, d.Fingerprint).First(final).Error; err != nil {
			return err
		}
		*d = *final
		return nil
	})
}

func (r *repo) Touch(ctx context.Context, id, nowMs int64) error {
	return db.Ctx(ctx).Model(&device_entity.Device{}).Where("id=?", id).
		Updates(map[string]interface{}{"last_seen_at": nowMs, "updatetime": nowMs}).Error
}

func (r *repo) UpdateVersion(ctx context.Context, id int64, version string, nowMs int64) error {
	return db.Ctx(ctx).Model(&device_entity.Device{}).Where("id=?", id).
		Updates(map[string]interface{}{"version": version, "updatetime": nowMs}).Error
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
