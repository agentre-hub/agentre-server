// Package sync_repo 是工作区多端同步的数据访问层。
package sync_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"

	"agentre-server/internal/model/entity/sync_entity"
	"agentre-server/internal/pkg/dberr"
)

//go:generate mockgen -source object.go -destination mock_sync_repo/mock_object.go

type SyncObjectRepo interface {
	// Find 按（账号, 同步标识）取一行，查不到返回 (nil, nil)。墓碑也会被取到——
	// R6 靠它挡住复活。
	Find(ctx context.Context, userID int64, syncID string) (*sync_entity.SyncObject, error)
	// FindLocationByNaturalKey 按（账号, 项目同步标识, agentred 指纹）取存活的那条
	// 路径记录，查不到返回 (nil, nil)。
	FindLocationByNaturalKey(ctx context.Context, userID int64, projectSyncID, fingerprint string) (*sync_entity.SyncObject, error)
	// Save 按（账号, 同步标识）落库，且只在版本号更大时才覆盖已有行。
	Save(ctx context.Context, obj *sync_entity.SyncObject) error
	// Tombstone 把一行标成墓碑并给它一个新版本，让删除本身也能被下行游标带走。
	// 返回受影响行数：已经是墓碑时为 0，由 service 决定这意味着什么。
	Tombstone(ctx context.Context, id, version, nowMs int64) (int64, error)
	// ListSince 按版本游标增量取，版本升序。
	ListSince(ctx context.Context, userID, cursor int64, limit int) ([]*sync_entity.SyncObject, error)
	// ListByKinds 取账号下这些类型里全部存活的行（墓碑不返回），不分页——
	// web 控制台读账号级快照（总览页的 Agent 清单、设备展开的项目清单）要的是
	// 当前状态的完整集合，不是同步用的增量游标。
	ListByKinds(ctx context.Context, userID int64, kinds []string) ([]*sync_entity.SyncObject, error)
	// DeleteTombstonesBefore 真正删掉删除时间早于 cutoff 的墓碑行（决策 9），
	// 返回删掉的行数。cutoff 由 service 按墓碑窗口算出：窗口内的墓碑必须留着，
	// 它是尚未拉取的设备赖以知道「这行被删了」的唯一凭据。
	DeleteTombstonesBefore(ctx context.Context, cutoff int64) (int64, error)
}

var defaultObject SyncObjectRepo

func SyncObject() SyncObjectRepo          { return defaultObject }
func RegisterSyncObject(i SyncObjectRepo) { defaultObject = i }
func NewSyncObject() SyncObjectRepo       { return &objectRepo{} }

type objectRepo struct{}

func (r *objectRepo) Find(ctx context.Context, userID int64, syncID string) (*sync_entity.SyncObject, error) {
	ret := &sync_entity.SyncObject{}
	err := db.Ctx(ctx).Where("user_id=? AND sync_id=?", userID, syncID).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

// FindLocationByNaturalKey 只看存活的那一行：墓碑不占（账号, 项目, 指纹），
// 否则删掉再建就建不回来了。这与 uk_sync_objects_location 这个部分唯一索引同源。
func (r *objectRepo) FindLocationByNaturalKey(
	ctx context.Context, userID int64, projectSyncID, fingerprint string,
) (*sync_entity.SyncObject, error) {
	ret := &sync_entity.SyncObject{}
	err := db.Ctx(ctx).Where(
		"user_id=? AND kind=? AND project_sync_id=? AND agentred_fingerprint=? AND deleted_at=0",
		userID, sync_entity.KindProjectLocation, projectSyncID, fingerprint,
	).First(ret).Error
	if err != nil {
		if db.RecordNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return ret, nil
}

// Save 按（账号, 同步标识）落库，且只在版本号更大时才覆盖已有行。
//
// **为什么不是一条 INSERT … ON DUPLICATE KEY UPDATE。** MySQL 的 ON DUPLICATE KEY
// 命中的是**任意**唯一键，而 sync_objects 上有两个：uk_sync_objects_identity 和
// uk_sync_objects_location。自然键被另一个 sync_id 占着时（R4b 竞态的兜底），那条
// 语句不会报错，而是去 UPDATE 别人那一行——身份键留旧的、内容换成新的，本次上行的
// sync_id 从来没落库，调用方却拿到成功。客户端于是永远重推同一个 sync_id，每次都
// 把别人那行再覆盖一遍。gorm 的 clause.OnConflict{Columns: …} 在 MySQL 方言下只是
// 装饰，收不住这件事；MySQL 官方文档同样建议多唯一键的表别用 ON DUPLICATE KEY。
//
// 所以按 MySQL 的写法拆成两步，两步都由数据库裁决、都不是先读后写：
//
//  1. 一条带版本条件的 UPDATE。命中 = 覆盖成功；并发的两次上行由行锁串行，落后的
//     那次条件不成立、改不动任何东西。命中时 version 必然与原值不同（条件就是
//     version<?），所以 RowsAffected 一定是 1，不会因为「匹配到但没变化」而落到第 2 步。
//     createtime 不在赋值列里：命中已有行时保留它首次落地的时间。
//  2. UPDATE 没命中说明行还不存在（或已被并发插入抢先），走一条**不带**
//     ON DUPLICATE 的 INSERT，让唯一键自己说话：
//     撞 uk_sync_objects_identity = 行已存在且版本不比本次小，本次是 R4 的竞败方，
//     这是预期内的正常路径，吞掉；
//     撞 uk_sync_objects_location = 自然键上另一行还活着，这是 R4b 的兜底，必须响，
//     原样上抛。
func (r *objectRepo) Save(ctx context.Context, obj *sync_entity.SyncObject) error {
	updated := db.Ctx(ctx).Model(&sync_entity.SyncObject{}).
		Where("user_id=? AND sync_id=? AND version<?", obj.UserID, obj.SyncID, obj.Version).
		Updates(map[string]interface{}{
			"kind":                 obj.Kind,
			"project_sync_id":      obj.ProjectSyncID,
			"agentred_fingerprint": obj.AgentredFingerprint,
			"payload":              obj.Payload,
			"version":              obj.Version,
			"sync_updated_at":      obj.SyncUpdatedAt,
			"source_device_id":     obj.SourceDeviceID,
			"deleted_at":           obj.DeletedAt,
			"updatetime":           obj.Updatetime,
		})
	if updated.Error != nil {
		return updated.Error
	}
	if updated.RowsAffected > 0 {
		return nil
	}

	err := db.Ctx(ctx).Create(obj).Error
	if dberr.IsDuplicateKey(err, "uk_sync_objects_identity") {
		return nil
	}
	return err
}

func (r *objectRepo) Tombstone(ctx context.Context, id, version, nowMs int64) (int64, error) {
	res := db.Ctx(ctx).Model(&sync_entity.SyncObject{}).
		Where("id=? AND deleted_at=0", id).
		Updates(map[string]interface{}{"deleted_at": nowMs, "version": version, "updatetime": nowMs})
	return res.RowsAffected, res.Error
}

func (r *objectRepo) ListSince(ctx context.Context, userID, cursor int64, limit int) ([]*sync_entity.SyncObject, error) {
	var out []*sync_entity.SyncObject
	if err := db.Ctx(ctx).Where("user_id=? AND version>?", userID, cursor).
		Order("version ASC").Limit(limit).Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteTombstonesBefore 的两个条件都是必须的：deleted_at>0 把存活的行排除在外，
// deleted_at<cutoff 把还在窗口内的墓碑排除在外。少任何一个都不是「回收」而是数据
// 丢失——存活行被删，或者删除本身在到达所有端之前就消失了（R6）。
//
// 一条语句扫全表、不分账号：每一行都只按它自己的 user_id 归属被删，一个账号的
// 回收不可能碰到另一个账号的行。
func (r *objectRepo) DeleteTombstonesBefore(ctx context.Context, cutoff int64) (int64, error) {
	res := db.Ctx(ctx).Where("deleted_at>0 AND deleted_at<?", cutoff).
		Delete(&sync_entity.SyncObject{})
	return res.RowsAffected, res.Error
}

func (r *objectRepo) ListByKinds(ctx context.Context, userID int64, kinds []string) ([]*sync_entity.SyncObject, error) {
	var out []*sync_entity.SyncObject
	if err := db.Ctx(ctx).Where("user_id=? AND kind IN ? AND deleted_at=0", userID, kinds).
		Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
