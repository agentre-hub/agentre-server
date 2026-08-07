package device_token_repo

import (
	"context"
	"time"

	"github.com/cago-frame/cago/database/db"

	"agentre-server/internal/model/entity/device_token_entity"
)

//go:generate mockgen -source device_token.go -destination mock_device_token_repo/mock_device_token.go

type DeviceTokenRepo interface {
	Create(ctx context.Context, e *device_token_entity.DeviceToken) error
	FindByHash(ctx context.Context, hash string) (*device_token_entity.DeviceToken, error)
	// Revoke 返回受影响行数，由 service 判读竞态结果。
	Revoke(ctx context.Context, id, nowMs int64) (int64, error)
	RevokeChain(ctx context.Context, deviceID, nowMs int64) error
	TouchLastUsed(ctx context.Context, id, nowMs int64) error
	DeleteRevokedBefore(ctx context.Context, cutoffMs int64) error
}

var defaultRepo DeviceTokenRepo

func DeviceToken() DeviceTokenRepo          { return defaultRepo }
func RegisterDeviceToken(i DeviceTokenRepo) { defaultRepo = i }
func NewDeviceToken() DeviceTokenRepo       { return &repo{} }

type repo struct{}

func (r *repo) Create(ctx context.Context, e *device_token_entity.DeviceToken) error {
	if e.Createtime == 0 {
		e.Createtime = time.Now().UnixMilli()
	}
	return db.Ctx(ctx).Create(e).Error
}

func (r *repo) FindByHash(ctx context.Context, hash string) (*device_token_entity.DeviceToken, error) {
	ret := &device_token_entity.DeviceToken{}
	err := db.Ctx(ctx).Where("refresh_token_hash=?", hash).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

// Revoke 的 revoked_at=0 条件让并发轮换只有一个请求改到行。
func (r *repo) Revoke(ctx context.Context, id, nowMs int64) (int64, error) {
	res := db.Ctx(ctx).Model(&device_token_entity.DeviceToken{}).
		Where("id=? AND revoked_at=0", id).
		Update("revoked_at", nowMs)
	return res.RowsAffected, res.Error
}

func (r *repo) RevokeChain(ctx context.Context, deviceID, nowMs int64) error {
	return db.Ctx(ctx).Model(&device_token_entity.DeviceToken{}).
		Where("device_id=? AND revoked_at=0", deviceID).
		Update("revoked_at", nowMs).Error
}

func (r *repo) TouchLastUsed(ctx context.Context, id, nowMs int64) error {
	return db.Ctx(ctx).Model(&device_token_entity.DeviceToken{}).Where("id=?", id).
		Update("last_used_at", nowMs).Error
}

func (r *repo) DeleteRevokedBefore(ctx context.Context, cutoffMs int64) error {
	return db.Ctx(ctx).
		Where("(revoked_at != 0 AND revoked_at < ?) OR refresh_expires_at < ?", cutoffMs, cutoffMs).
		Delete(&device_token_entity.DeviceToken{}).Error
}
