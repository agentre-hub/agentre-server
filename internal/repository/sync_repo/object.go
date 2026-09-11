// Package sync_repo 是工作区多端同步的数据访问层。
package sync_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source object.go -destination mock_sync_repo/mock_object.go

type SyncObjectRepo interface {
	// Find 按（账号, 同步标识）取一行，查不到返回 (nil, nil)。墓碑也会被取到——
	// R6 靠它挡住复活。
	Find(ctx context.Context, userID int64, syncID string) (*sync_entity.SyncObject, error)
	// FindLocationByNaturalKey 按（账号, 项目同步标识, agentred 指纹）取存活的那条
	// 路径记录，查不到返回 (nil, nil)。
	FindLocationByNaturalKey(ctx context.Context, userID int64, projectSyncID, fingerprint string) (*sync_entity.SyncObject, error)
	// FindCLIOverlayByNaturalKey 按（账号, backend 同步标识, 指纹）取存活的 CLI 覆盖。
	FindCLIOverlayByNaturalKey(ctx context.Context, userID int64, backendSyncID, fingerprint string) (*sync_entity.SyncObject, error)
	// FindMany 按（账号, 同步标识）一次取回多行，按同步标识归档；库里没有的不在结果里。
	// 墓碑同样会被取到。
	FindMany(ctx context.Context, userID int64, syncIDs []string) (map[string]*sync_entity.SyncObject, error)
	// FindLiveByNaturalKeys 一次取回这些自然键上存活的那一行（至多一行，唯一键保证），
	// 按自然键归档；没有存活行的键不在结果里。
	FindLiveByNaturalKeys(ctx context.Context, userID int64, keys []NaturalKey) (map[NaturalKey]*sync_entity.SyncObject, error)
	// Save 按（账号, 同步标识）落库，且只在版本号更大时才覆盖已有行。
	Save(ctx context.Context, obj *sync_entity.SyncObject) error
	// CreateBatch 按块把一批新对象普通 INSERT 进去（不带 ON DUPLICATE KEY UPDATE），
	// 撞上任一唯一键都原样上抛。
	CreateBatch(ctx context.Context, objs []*sync_entity.SyncObject) error
	// Tombstone 把一行标成墓碑并给它一个新版本，让删除本身也能被下行游标带走。
	// 返回受影响行数：已经是墓碑时为 0，由 service 决定这意味着什么。
	Tombstone(ctx context.Context, id, version, nowMs int64) (int64, error)
	// ListSince 按版本游标增量取，版本升序。
	ListSince(ctx context.Context, userID, cursor int64, limit int) ([]*sync_entity.SyncObject, error)
	// ListByKinds 取账号下这些类型里全部存活的行（墓碑不返回），不分页——
	// web 控制台读账号级快照（总览页的 Agent 清单、设备展开的项目清单）要的是
	// 当前状态的完整集合，不是同步用的增量游标。R6 的级联删除同样用它取回账号下
	// 的存活执行目标，再在 Go 里按载荷里的 backend_sync_id 挑出引用者
	// （见 sync_svc.tombstoneExecTargetsOf）。
	ListByKinds(ctx context.Context, userID int64, kinds []string) ([]*sync_entity.SyncObject, error)
	// ListLiveByFingerprint 取账号下这些类型里、agentred_fingerprint 命中某台机器的
	// 全部**存活**行：一台设备离开账号时，只属于它的那些行据此圈定并落墓碑。
	// 已经是墓碑的行不返回——再落一次只会白占一个版本号。
	// fingerprint 由调用方保证非空（空串是「当前这台桌面端」的相对引用，见
	// sync_svc.PurgeDeviceSyncObjects）。
	ListLiveByFingerprint(ctx context.Context, userID int64, fingerprint string, kinds []string) ([]*sync_entity.SyncObject, error)
	// DeleteTombstonesBefore 真正删掉删除时间早于 cutoff 的墓碑行（决策 9），
	// 返回删掉的行数。cutoff 由 service 按墓碑窗口算出：窗口内的墓碑必须留着，
	// 它是尚未拉取的设备赖以知道「这行被删了」的唯一凭据。
	DeleteTombstonesBefore(ctx context.Context, cutoff int64) (int64, error)
}

// NaturalKey 是带自然键的对象（路径记录、CLI 覆盖）在账号内的自然键，与
// uk_sync_objects_natural 同列：scope_sync_id 装什么取决于 kind。
type NaturalKey struct {
	Kind                string
	ScopeSyncID         string
	AgentredFingerprint string
}

// syncObjectBatchSize 是批量读写一条语句里的行数上限，与 api/sync 一批的上限同值：
// 满载的一次 Push 读与新建各是一条语句。
const syncObjectBatchSize = 500

var defaultObject SyncObjectRepo

func SyncObject() SyncObjectRepo          { return defaultObject }
func RegisterSyncObject(i SyncObjectRepo) { defaultObject = i }
func NewSyncObject() SyncObjectRepo       { return &objectRepo{} }

type objectRepo struct{}

func (r *objectRepo) Find(ctx context.Context, userID int64, syncID string) (*sync_entity.SyncObject, error) {
	return dbutil.FindOne[sync_entity.SyncObject](db.Ctx(ctx).Where("user_id=? AND sync_id=?", userID, syncID))
}

// FindLocationByNaturalKey 只看存活的那一行：墓碑不占（账号, 项目, 指纹），
// 否则删掉再建就建不回来了。这与 uk_sync_objects_natural 这个部分唯一索引同源。
func (r *objectRepo) FindLocationByNaturalKey(
	ctx context.Context, userID int64, projectSyncID, fingerprint string,
) (*sync_entity.SyncObject, error) {
	return r.findLiveByNaturalKey(ctx, userID, sync_entity.KindProjectLocation, projectSyncID, fingerprint)
}

func (r *objectRepo) FindCLIOverlayByNaturalKey(
	ctx context.Context, userID int64, backendSyncID, fingerprint string,
) (*sync_entity.SyncObject, error) {
	return r.findLiveByNaturalKey(ctx, userID, sync_entity.KindAgentBackendCLI, backendSyncID, fingerprint)
}

func (r *objectRepo) findLiveByNaturalKey(
	ctx context.Context, userID int64, kind, projectSyncID, fingerprint string,
) (*sync_entity.SyncObject, error) {
	return dbutil.FindOne[sync_entity.SyncObject](db.Ctx(ctx).Where(
		"user_id=? AND kind=? AND scope_sync_id=? AND agentred_fingerprint=? AND deleted_at=0",
		userID, kind, projectSyncID, fingerprint,
	))
}

// Save 按（账号, 同步标识）落库，且只在版本号更大时才覆盖已有行。
//
// **为什么不是一条 INSERT … ON DUPLICATE KEY UPDATE。** MySQL 的 ON DUPLICATE KEY
// 命中的是**任意**唯一键，而 sync_objects 上有两个：uk_sync_objects_identity、
// uk_sync_objects_natural。自然键被另一个 sync_id
// 占着时（R4b 竞态的兜底），那条
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
//     ON DUPLICATE 的 INSERT，让唯一键自己说话。两个唯一键撞上了都原样上抛：
//     撞 uk_sync_objects_natural 是 R4b 的兜底（自然键上另一行还活着）；
//     撞 uk_sync_objects_identity 则说明这一行在库里的版本不比本次小，而版本号是在
//     写入事务里从账号序列取的（sync_svc.Push），那一行的排他锁持到提交——先取到号的
//     一定先提交，落后的那次版本号更大、UPDATE 必然命中。所以它出现就是个坏掉的不变量。
//
// **一个都不能吞。** 吞掉等于「这一行从来没落库，调用方却拿到成功」：Push 会据此回
// 给设备一句 Accepted 加一个库里根本不存在的版本号，这次上行就此消失，两端都以为写
// 成功了。上抛最坏只是整批失败，客户端重推时会取到一个更大的版本号、走回 UPDATE。
func (r *objectRepo) Save(ctx context.Context, obj *sync_entity.SyncObject) error {
	updated := db.Ctx(ctx).Model(&sync_entity.SyncObject{}).
		Where("user_id=? AND sync_id=? AND version<?", obj.UserID, obj.SyncID, obj.Version).
		Updates(map[string]interface{}{
			"kind":                 obj.Kind,
			"scope_sync_id":        obj.ScopeSyncID,
			"agentred_fingerprint": obj.AgentredFingerprint,
			"payload":              obj.Payload,
			"version":              obj.Version,
			"updated_at":           obj.SyncUpdatedAt,
			"origin_fingerprint":   obj.OriginFingerprint,
			"deleted_at":           obj.DeletedAt,
			"updatetime":           obj.Updatetime,
		})
	if updated.Error != nil {
		return updated.Error
	}
	if updated.RowsAffected > 0 {
		return nil
	}

	return db.Ctx(ctx).Create(obj).Error
}

// FindMany 按块发 `sync_id IN`。sync_id 是 utf8mb4_0900_bin，库里的相等就是 Go 里的
// 字符串相等，所以可以直接按它归档。
func (r *objectRepo) FindMany(ctx context.Context, userID int64, syncIDs []string) (map[string]*sync_entity.SyncObject, error) {
	out := make(map[string]*sync_entity.SyncObject, len(syncIDs))
	for start := 0; start < len(syncIDs); start += syncObjectBatchSize {
		var rows []*sync_entity.SyncObject
		if err := db.Ctx(ctx).Where("user_id=? AND sync_id IN ?", userID,
			syncIDs[start:min(start+syncObjectBatchSize, len(syncIDs))]).Find(&rows).Error; err != nil {
			return nil, err
		}
		for _, row := range rows {
			out[row.SyncID] = row
		}
	}
	return out, nil
}

// FindLiveByNaturalKeys 的谓词写在 uk_sync_objects_natural 的列上。live_natural_key 是
// 生成列：存活且属于带自然键的 kind 时等于 kind，否则为 NULL——与 findLiveByNaturalKey
// 的「kind=? AND deleted_at=0」同义，而行构造器 IN 整个落在那条唯一键上。三列都是
// utf8mb4_0900_bin，按 Go 字符串归档与库里的相等一致。
func (r *objectRepo) FindLiveByNaturalKeys(
	ctx context.Context, userID int64, keys []NaturalKey,
) (map[NaturalKey]*sync_entity.SyncObject, error) {
	out := make(map[NaturalKey]*sync_entity.SyncObject, len(keys))
	for start := 0; start < len(keys); start += syncObjectBatchSize {
		chunk := keys[start:min(start+syncObjectBatchSize, len(keys))]
		tuples := make([][]interface{}, 0, len(chunk))
		for _, k := range chunk {
			tuples = append(tuples, []interface{}{k.ScopeSyncID, k.AgentredFingerprint, k.Kind})
		}
		var rows []*sync_entity.SyncObject
		if err := db.Ctx(ctx).Where(
			"user_id=? AND (scope_sync_id, agentred_fingerprint, live_natural_key) IN ?", userID, tuples,
		).Find(&rows).Error; err != nil {
			return nil, err
		}
		for _, row := range rows {
			out[NaturalKey{Kind: row.Kind, ScopeSyncID: row.ScopeSyncID, AgentredFingerprint: row.AgentredFingerprint}] = row
		}
	}
	return out, nil
}

// CreateBatch 每块一条多行 INSERT，**不带** ON DUPLICATE KEY UPDATE，理由同 Save：
// 两条唯一键撞上哪条都原样上抛。某一块失败就停下，调用方的事务据此整批回滚。
func (r *objectRepo) CreateBatch(ctx context.Context, objs []*sync_entity.SyncObject) error {
	for start := 0; start < len(objs); start += syncObjectBatchSize {
		chunk := objs[start:min(start+syncObjectBatchSize, len(objs))]
		if err := db.Ctx(ctx).Create(&chunk).Error; err != nil {
			return err
		}
	}
	return nil
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
// cleanupBatchSize 是清理类 DELETE 每一批的行数上限。
//
// 不分批的一条 DELETE 在 InnoDB 上会把 next-key 锁铺满它扫过的范围。这两张表都是
// 稳态几十万到几百万行、每天/每小时回收一次的形状,一次回收可能删掉其中一大片,
// 期间落在同一范围上的写全被挡在那把锁后面。分批之后每批各自提交,锁的持有时间被
// 切成一小段一小段。
const cleanupBatchSize = 1000

func (r *objectRepo) DeleteTombstonesBefore(ctx context.Context, cutoff int64) (int64, error) {
	var total int64
	for {
		res := db.Ctx(ctx).Where("deleted_at>0 AND deleted_at<?", cutoff).
			Limit(cleanupBatchSize).
			Delete(&sync_entity.SyncObject{})
		if res.Error != nil {
			return total, res.Error
		}
		total += res.RowsAffected
		// 没删满说明够到底了。删满就得再来一批——剩下的行数无从得知。
		if res.RowsAffected < cleanupBatchSize {
			return total, nil
		}
	}
}

func (r *objectRepo) ListByKinds(ctx context.Context, userID int64, kinds []string) ([]*sync_entity.SyncObject, error) {
	var out []*sync_entity.SyncObject
	if err := db.Ctx(ctx).Where("user_id=? AND kind IN ? AND deleted_at=0", userID, kinds).
		Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

func (r *objectRepo) ListLiveByFingerprint(
	ctx context.Context, userID int64, fingerprint string, kinds []string,
) ([]*sync_entity.SyncObject, error) {
	var out []*sync_entity.SyncObject
	if err := db.Ctx(ctx).Where(
		"user_id=? AND kind IN ? AND agentred_fingerprint=? AND deleted_at=0",
		userID, kinds, fingerprint,
	).Order("id ASC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
