// Package sync_repo 是工作区多端同步的数据访问层。
package sync_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"agentre-server/internal/model/entity/sync_entity"
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

// Save 是一条语句的条件 upsert：命中（user_id, sync_id）时只有版本号更大的那次
// 写入才覆盖。多副本并发上行同一行时由数据库裁决，先查后写会让落后的那次把更新
// 的那一版盖掉。createtime 不在赋值列里：命中已有行时保留它首次落地的时间。
func (r *objectRepo) Save(ctx context.Context, obj *sync_entity.SyncObject) error {
	assignments := map[string]interface{}{}
	for _, column := range []string{
		"kind", "project_sync_id", "agentred_fingerprint", "payload",
		"version", "sync_updated_at", "source_device_id", "deleted_at", "updatetime",
	} {
		assignments[column] = gorm.Expr(
			"IF(VALUES(`version`) > `version`, VALUES(`" + column + "`), `" + column + "`)",
		)
	}
	return db.Ctx(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "sync_id"}},
		DoUpdates: clause.Assignments(assignments),
	}).Create(obj).Error
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
