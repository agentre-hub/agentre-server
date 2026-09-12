package device_token_repo

import (
	"context"
	"time"

	"github.com/cago-frame/cago/database/db"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_token_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source device_token.go -destination mock_device_token_repo/mock_device_token.go

type DeviceTokenRepo interface {
	Create(ctx context.Context, e *device_token_entity.DeviceToken) error
	FindByHash(ctx context.Context, hash string) (*device_token_entity.DeviceToken, error)
	// FindByAccessHash 按 access token 摘要取行，查不到返回 (nil, nil)。
	FindByAccessHash(ctx context.Context, hash string) (*device_token_entity.DeviceToken, error)
	// Revoke 返回受影响行数，由 service 判读竞态结果。
	Revoke(ctx context.Context, id, nowMs int64) (int64, error)
	RevokeChain(ctx context.Context, deviceID, nowMs int64) error
	// DeleteByDevice 删掉一台设备名下的全部令牌行。
	DeleteByDevice(ctx context.Context, deviceID int64) error
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
	return dbutil.FindOne[device_token_entity.DeviceToken](db.Ctx(ctx).Where("refresh_token_hash=?", hash))
}

// FindByAccessHash 走 uk_dtokens_access_hash 的等值查找。
func (r *repo) FindByAccessHash(ctx context.Context, hash string) (*device_token_entity.DeviceToken, error) {
	return dbutil.FindOne[device_token_entity.DeviceToken](db.Ctx(ctx).Where("access_token_hash=?", hash))
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

// DeleteByDevice 删掉一台设备名下的全部令牌行：重新激活一台已撤销的设备时，撤销前签发的
// access / refresh token 不得随设备复活。一台设备的行数只是它自己的轮换链，不必分批。
func (r *repo) DeleteByDevice(ctx context.Context, deviceID int64) error {
	return db.Ctx(ctx).Where("device_id=?", deviceID).Delete(&device_token_entity.DeviceToken{}).Error
}

// cleanupBatchSize 是清理 DELETE 每一批的行数上限。这张表增长很快——access TTL
// 15 分钟、refresh 每次轮换插一行,90 天窗口下稳态几百万行——一条不分批的 DELETE
// 会把 next-key 锁铺满它扫过的范围,期间落在同一范围上的令牌刷新全被挡住。
const cleanupBatchSize = 1000

// DeleteRevokedBefore 删掉满足
//
//	(revoked_at != 0 AND revoked_at < ?) OR refresh_expires_at < ?
//
// 的行,但拆成两条各自带索引的语句:OR 只要有一侧定位不了,整条就退化成全表扫;拆开之后
// 每一侧都是自己那条索引上的范围扫描(idx_dtokens_revoked 与 idx_dtokens_refresh_expiry)。
//
// 行集合与单条 OR 语句完全相同:同时满足两侧的行由第一条删走,第二条自然就找不到它了。
func (r *repo) DeleteRevokedBefore(ctx context.Context, cutoffMs int64) error {
	if err := r.deleteBatched(ctx, "revoked_at != 0 AND revoked_at < ?", cutoffMs); err != nil {
		return err
	}
	return r.deleteBatched(ctx, "refresh_expires_at < ?", cutoffMs)
}

// deleteBatched 按批删,直到某一批没删满——没删满就说明够到底了。
func (r *repo) deleteBatched(ctx context.Context, where string, cutoffMs int64) error {
	for {
		res := db.Ctx(ctx).Where(where, cutoffMs).
			Limit(cleanupBatchSize).
			Delete(&device_token_entity.DeviceToken{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected < cleanupBatchSize {
			return nil
		}
	}
}
