package sync_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source avatar.go -destination mock_sync_repo/mock_avatar.go

type SyncAvatarRepo interface {
	// Find 按（账号, 内容哈希）取头像正文，没有返回 (nil, nil)。
	Find(ctx context.Context, userID int64, contentHash string) (*sync_entity.SyncAvatar, error)
	// Save 按（账号, 内容哈希）落库；同一份内容重复上传不产生第二行。
	Save(ctx context.Context, a *sync_entity.SyncAvatar) error
	// DeleteUnreferencedBefore 回收 createtime 早于 cutoff、且在同一账号下没有任何
	// 存活 Agent 引用的头像正文（R16a），返回删掉的行数。
	DeleteUnreferencedBefore(ctx context.Context, cutoff int64) (int64, error)
}

var defaultAvatar SyncAvatarRepo

func SyncAvatar() SyncAvatarRepo          { return defaultAvatar }
func RegisterSyncAvatar(i SyncAvatarRepo) { defaultAvatar = i }
func NewSyncAvatar() SyncAvatarRepo       { return &avatarRepo{} }

type avatarRepo struct{}

func (r *avatarRepo) Find(ctx context.Context, userID int64, contentHash string) (*sync_entity.SyncAvatar, error) {
	return dbutil.FindOne[sync_entity.SyncAvatar](
		db.Ctx(ctx).Where("user_id=? AND content_hash=?", userID, contentHash))
}

// Save 走 DO NOTHING：主键就是内容哈希，同一份内容重复上传没有任何要更新的东西，
// 覆盖只会白白改写 createtime。
func (r *avatarRepo) Save(ctx context.Context, a *sync_entity.SyncAvatar) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(a).Error
}

// deleteUnreferencedAvatarsSQL 是 R16a 的「无人引用即可回收」。
//
// 写成一条相关子查询而不是「先查引用集合、再删」有两个原因：引用集合与删除之间的
// 空档里会有新的 Agent 上行，分两步就会误删刚被引用上的那一份；以及 o.user_id =
// a.user_id 这个相关条件让「有没有人引用」严格按账号回答——sync_avatars 的主键是
// （账号, 哈希），同一张图可以同时属于两个账号，用别人账号的引用决定这一行的生死
// 既会误留也会误删。
//
// 只有 kind='agent' 且 deleted_at=0 的行算引用：墓碑不是引用（它的正文本来就是空
// 对象），别的类型压根不带头像。
//
// 比的是 o.avatar_hash 这一列而不是在语句里现算 JSON：函数谓词定位不了索引，那样
// 每个候选头像行都要把该账号的 sync_objects 整份读上来逐行解一次。avatar_hash 是
// payload 上的生成列（migrations/202609040106_workspace_sync.go），四个条件因此一起落在
// idx_sync_objects_avatar (user_id, kind, deleted_at, avatar_hash) 上。
//
// createtime < cutoff 是安全垫：cutoff 取的是墓碑窗口，一台离线设备最多可以在窗口
// 内才上行（R6a），正文先到、引用它的 Agent 后到这个次序因此是允许的，窗口内的
// 头像一律留着。
const deleteUnreferencedAvatarsSQL = `
DELETE FROM sync_avatars AS a
WHERE a.createtime < ?
  AND NOT EXISTS (
    SELECT 1 FROM sync_objects AS o
    WHERE o.user_id = a.user_id
      AND o.kind = 'agent'
      AND o.deleted_at = 0
      AND o.avatar_hash = a.content_hash
  )
LIMIT ?`

// DeleteUnreferencedBefore 分批回收。这张表每行带一份 mediumtext 头像,一条不分批
// 的 DELETE 既把 next-key 锁铺满扫过的范围,又要把删掉的正文全部写进 undo/binlog。
// 收敛条件与 DeleteTombstonesBefore 相同:这一批没删满就说明够到底了。
func (r *avatarRepo) DeleteUnreferencedBefore(ctx context.Context, cutoff int64) (int64, error) {
	var total int64
	for {
		res := db.Ctx(ctx).Exec(deleteUnreferencedAvatarsSQL, cutoff, cleanupBatchSize)
		if res.Error != nil {
			return total, res.Error
		}
		total += res.RowsAffected
		if res.RowsAffected < cleanupBatchSize {
			return total, nil
		}
	}
}
