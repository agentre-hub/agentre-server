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
	ListAccessJTIByDevice(ctx context.Context, deviceID int64) ([]string, error)
	ListRevokedJTIByUser(ctx context.Context, userID, windowStartMs int64) ([]string, error)
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
	return dbutil.FindOne[device_token_entity.DeviceToken](db.Ctx(ctx).Where("refresh_token_hash=?", hash))
}

// ListAccessJTIByDevice 返回该设备全部已签发 access token 的 jti
// （含已被刷新轮换、但 access token 仍在其短有效期内可能被接受的旧行）。
func (r *repo) ListAccessJTIByDevice(ctx context.Context, deviceID int64) ([]string, error) {
	var jtis []string
	err := db.Ctx(ctx).Model(&device_token_entity.DeviceToken{}).
		Where("device_id=? AND access_jti != ''", deviceID).
		Pluck("access_jti", &jtis).Error
	if err != nil {
		return nil, err
	}
	return jtis, nil
}

// ListRevokedJTIByUser 返回该账号（跨其名下全部设备）已吊销、且签发时间
// 距今仍在 AccessTTL 窗口内（createtime >= windowStartMs，即仍可能验签通过）
// 的 access token jti。数据源同样是 device_tokens.access_jti（含刷新轮换出的
// 旧 access token），联表 devices 按 user_id 过滤，不扫 Redis key。
func (r *repo) ListRevokedJTIByUser(ctx context.Context, userID, windowStartMs int64) ([]string, error) {
	var jtis []string
	err := db.Ctx(ctx).Model(&device_token_entity.DeviceToken{}).
		Joins("JOIN devices ON devices.id = device_tokens.device_id").
		Where("devices.user_id = ? AND device_tokens.revoked_at != 0 AND device_tokens.access_jti != '' AND device_tokens.createtime >= ?",
			userID, windowStartMs).
		Pluck("device_tokens.access_jti", &jtis).Error
	if err != nil {
		return nil, err
	}
	return jtis, nil
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

// cleanupBatchSize 是清理 DELETE 每一批的行数上限。这张表增长很快——access TTL
// 15 分钟、refresh 每次轮换插一行,90 天窗口下稳态几百万行——一条不分批的 DELETE
// 会把 next-key 锁铺满它扫过的范围,期间落在同一范围上的令牌刷新全被挡住。
const cleanupBatchSize = 1000

// DeleteRevokedBefore 把从前那条
//
//	(revoked_at != 0 AND revoked_at < ?) OR refresh_expires_at < ?
//
// 拆成两条各自带索引的语句。OR 只要有一侧定位不了,整条就退化成全表扫;拆开之后
// 每一侧都是自己那条索引上的范围扫描(idx_dtokens_revoked 与 idx_dtokens_refresh_expiry)。
//
// 行集合与拆之前完全相同:同时满足两侧的行由第一条删走,第二条自然就找不到它了。
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
