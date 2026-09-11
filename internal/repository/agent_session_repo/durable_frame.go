package agent_session_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
)

//go:generate mockgen -source durable_frame.go -destination mock_agent_session_repo/mock_durable_frame.go

// DurableFrameRepo is the data access seam for agent_session_durable_frames.
type DurableFrameRepo interface {
	// WriteFrames batch-writes frames replayed off a peer's own notification
	// log, keyed by (user_id, conversation_id, seq) — this table's one unique
	// key. A frame that was already written lands on that
	// key and is a no-op, not a duplicate row or an error: attach's live
	// notifications and a reconnect's pull-based catch-up both call this, and
	// their windows overlap by construction, so the same frame arriving twice
	// must settle once (写入路径「按序重放补齐缺口」的幂等前提). Writing zero
	// frames never touches the database.
	WriteFrames(ctx context.Context, frames []*agent_session_entity.DurableFrame) error
	// ListFramesBySeq returns one session's frames with seq strictly greater
	// than fromSeq (the caller's own cursor, exclusive — mirrors
	// wire.SessionPullParams.Cursor), ordered seq ascending and capped at
	// limit for paging through a large backlog. Scoped by (user_id,
	// conversation_id): a read that drops user_id leaks another account's
	// transcript.
	ListFramesBySeq(
		ctx context.Context, userID int64, conversationID string, fromSeq int64, limit int,
	) ([]*agent_session_entity.DurableFrame, error)
	// ListFramesBefore reads the same session **backwards**: up to limit rows
	// with seq strictly less than beforeSeq, newest first. beforeSeq 0 means
	// "from the newest row". Scoped by the same two identity columns.
	//
	// Descending is not a formatting choice. The detail page wants a
	// conversation's *last* stretch, and the caller accumulates it newest-first
	// against a budget (2026-08-21-transcript-tail-loading 决策 7); ordering
	// ascending and applying limit would return the oldest n rows of the whole
	// conversation instead — the exact opposite of what was asked for.
	ListFramesBefore(
		ctx context.Context, userID int64, conversationID string, beforeSeq int64, limit int,
	) ([]*agent_session_entity.DurableFrame, error)
	// DeleteFrames 清掉一条对话在这个身份键下的全部帧。两条路都用它：账号里删掉
	// 这条对话时清 server 那一份（决策 6），以及对端的帧编号倒退回去时把旧的
	// 整段先清干净——WriteFrames 是 DO NOTHING，不清就是旧帧原地胜出。
	// 一条都没有时是 no-op 而不是错误：删除与复位都要幂等。
	DeleteFrames(ctx context.Context, userID int64, conversationID string) error
}

var defaultDurableFrame DurableFrameRepo

func DurableFrame() DurableFrameRepo          { return defaultDurableFrame }
func RegisterDurableFrame(i DurableFrameRepo) { defaultDurableFrame = i }
func NewDurableFrame() DurableFrameRepo       { return &durableFrameRepo{} }

type durableFrameRepo struct{}

// WriteFrames 是一条批量 INSERT ... ON DUPLICATE KEY UPDATE `user_id`=`user_id`
// （clause.OnConflict{DoNothing:true}，与 sync_repo.avatarRepo.Save 同一写法）：
// 赋值右边就是被赋的那一列，命中已有行时一个字节都不改，于是重放同一批帧时已经落库
// 的那些行原样保留，不产生第二行也不报错。
// agent_session_durable_frames 上只有主键 (user_id, conversation_id, seq)
// 这一个键，DoNothing 因此收敛到它。
func (r *durableFrameRepo) WriteFrames(ctx context.Context, frames []*agent_session_entity.DurableFrame) error {
	if len(frames) == 0 {
		return nil
	}
	return db.Ctx(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&frames).Error
}

func (r *durableFrameRepo) ListFramesBySeq(
	ctx context.Context, userID int64, conversationID string, fromSeq int64, limit int,
) ([]*agent_session_entity.DurableFrame, error) {
	var out []*agent_session_entity.DurableFrame
	if err := db.Ctx(ctx).Where(
		"user_id=? AND conversation_id=? AND seq>?",
		userID, conversationID, fromSeq,
	).Order("seq ASC").Limit(limit).Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

// ListFramesBefore 与 ListFramesBySeq 是同一张表的两个方向。上界为 0 时**不发**
// seq<0 那一段条件——发出去会一行都取不到，详情页于是把一条有内容的对话显示成空的。
func (r *durableFrameRepo) ListFramesBefore(
	ctx context.Context, userID int64, conversationID string, beforeSeq int64, limit int,
) ([]*agent_session_entity.DurableFrame, error) {
	var out []*agent_session_entity.DurableFrame
	// 条件拼成**一条** Where 而不是链式两条：链式会生成 `WHERE (a AND b) AND c`，
	// 与同一张表上 ListFramesBySeq 的形状不一样，两条读语句的 SQL 从此对不上眼。
	cond := "user_id=? AND conversation_id=?"
	args := []any{userID, conversationID}
	if beforeSeq > 0 {
		cond += " AND seq<?"
		args = append(args, beforeSeq)
	}
	if err := db.Ctx(ctx).Where(cond, args...).
		Order("seq DESC").Limit(limit).Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

// cleanupBatchSize 是分批删除每一批的行数上限，与 sync_repo、device_token_repo
// 既有的分批清理常量保持一致（决策 7）。
//
// 一条不分批的 DELETE 会把 next-key 锁铺满它扫过的整个范围：真库实测 30000 行
// 一次删掉锁了 36404 行、写出 34MB 的 binlog 事务；同样的数据换成 LIMIT 1000
// 一批，一批只经唯一键锁 2005 行。这张表的一条对话可能攒下几万帧，删除一条
// 对话或对端帧编号倒退时的整段清空都会撞上这条路径。
const cleanupBatchSize = 1000

// DeleteFrames 按批删除，WHERE 带齐身份键两列：少了 user_id 是跨账号删。
// 循环直到某一批没删满——没删满就说明够到底了；删满一批说明后面大概率还有，
// 必须继续。某一批中途出错时把已删的部分留在库里、把错误原样传回去：删除与
// 复位都是幂等的，调用方可以整体重试，不需要靠这里悄悄兜底。
func (r *durableFrameRepo) DeleteFrames(
	ctx context.Context, userID int64, conversationID string,
) error {
	for {
		res := db.Ctx(ctx).Where(
			"user_id=? AND conversation_id=?", userID, conversationID,
		).Limit(cleanupBatchSize).Delete(&agent_session_entity.DurableFrame{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected < cleanupBatchSize {
			return nil
		}
	}
}
