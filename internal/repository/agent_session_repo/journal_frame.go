package agent_session_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
)

//go:generate mockgen -source journal_frame.go -destination mock_agent_session_repo/mock_journal_frame.go

// JournalFrameRepo is the data access seam for agent_session_notification_journal.
type JournalFrameRepo interface {
	// WriteFrames batch-writes frames replayed off a peer's own notification
	// log, keyed by (user_id, peer_fingerprint, peer_session_id, seq) — this
	// table's one unique key. A frame that was already written lands on that
	// key and is a no-op, not a duplicate row or an error: attach's live
	// notifications and a reconnect's pull-based catch-up both call this, and
	// their windows overlap by construction, so the same frame arriving twice
	// must settle once (写入路径「按序重放补齐缺口」的幂等前提). Writing zero
	// frames never touches the database.
	WriteFrames(ctx context.Context, frames []*agent_session_entity.JournalFrame) error
	// ListFramesBySeq returns one session's frames with seq strictly greater
	// than fromSeq (the caller's own cursor, exclusive — mirrors
	// wire.SessionPullParams.Cursor), ordered seq ascending and capped at
	// limit for paging through a large backlog. Scoped by (user_id,
	// peer_fingerprint, peer_session_id): a read that drops user_id leaks another
	// account's transcript.
	ListFramesBySeq(
		ctx context.Context, userID int64, peerFingerprint, peerSessionID string, fromSeq int64, limit int,
	) ([]*agent_session_entity.JournalFrame, error)
	// ListFramesBefore reads the same session **backwards**: up to limit rows
	// with seq strictly less than beforeSeq, newest first. beforeSeq 0 means
	// "from the newest row". Scoped by the same three identity columns.
	//
	// Descending is not a formatting choice. The detail page wants a
	// conversation's *last* stretch, and the caller accumulates it newest-first
	// against a budget (2026-08-21-transcript-tail-loading 决策 7); ordering
	// ascending and applying limit would return the oldest n rows of the whole
	// conversation instead — the exact opposite of what was asked for.
	ListFramesBefore(
		ctx context.Context, userID int64, peerFingerprint, peerSessionID string, beforeSeq int64, limit int,
	) ([]*agent_session_entity.JournalFrame, error)
	// DeleteFrames 清掉一条对话在这个身份键下的全部帧。两条路都用它：账号里删掉
	// 这条对话时清 server 那一份（决策 6），以及执行端复用了会话标识时把旧对话
	// 的整段先清干净——WriteFrames 的唯一键新旧两条对话一模一样，而它是 DO
	// NOTHING，不清就是旧帧原地胜出，页面显示的会是另一条对话的转录。
	// 一条都没有时是 no-op 而不是错误：删除与复位都要幂等。
	DeleteFrames(ctx context.Context, userID int64, peerFingerprint, peerSessionID string) error
}

var defaultJournalFrame JournalFrameRepo

func JournalFrame() JournalFrameRepo          { return defaultJournalFrame }
func RegisterJournalFrame(i JournalFrameRepo) { defaultJournalFrame = i }
func NewJournalFrame() JournalFrameRepo       { return &journalFrameRepo{} }

type journalFrameRepo struct{}

// WriteFrames 是一条批量 INSERT ... ON DUPLICATE KEY UPDATE `user_id`=`user_id`
// （clause.OnConflict{DoNothing:true}，与 sync_repo.avatarRepo.Save 同一写法）：
// 赋值右边就是被赋的那一列，命中已有行时一个字节都不改，于是重放同一批帧时已经落库
// 的那些行原样保留，不产生第二行也不报错。
// agent_session_notification_journal 上只有主键 (user_id, peer_fingerprint, peer_session_id, seq)
// 这一个键，DoNothing 因此收敛到它。
func (r *journalFrameRepo) WriteFrames(ctx context.Context, frames []*agent_session_entity.JournalFrame) error {
	if len(frames) == 0 {
		return nil
	}
	return db.Ctx(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&frames).Error
}

func (r *journalFrameRepo) ListFramesBySeq(
	ctx context.Context, userID int64, peerFingerprint, peerSessionID string, fromSeq int64, limit int,
) ([]*agent_session_entity.JournalFrame, error) {
	var out []*agent_session_entity.JournalFrame
	if err := db.Ctx(ctx).Where(
		"user_id=? AND peer_fingerprint=? AND peer_session_id=? AND seq>?",
		userID, peerFingerprint, peerSessionID, fromSeq,
	).Order("seq ASC").Limit(limit).Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

// ListFramesBefore 与 ListFramesBySeq 是同一张表的两个方向。上界为 0 时**不发**
// seq<0 那一段条件——发出去会一行都取不到，详情页于是把一条有内容的对话显示成空的。
func (r *journalFrameRepo) ListFramesBefore(
	ctx context.Context, userID int64, peerFingerprint, peerSessionID string, beforeSeq int64, limit int,
) ([]*agent_session_entity.JournalFrame, error) {
	var out []*agent_session_entity.JournalFrame
	// 条件拼成**一条** Where 而不是链式两条：链式会生成 `WHERE (a AND b AND c) AND d`，
	// 与同一张表上 ListFramesBySeq 的形状不一样，两条读语句的 SQL 从此对不上眼。
	cond := "user_id=? AND peer_fingerprint=? AND peer_session_id=?"
	args := []any{userID, peerFingerprint, peerSessionID}
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

// DeleteFrames 是一条 DELETE，WHERE 带齐身份键三列：少了 user_id 是跨账号删，
// 少了 peer_fingerprint 会连累别的发起端那条同号会话（会话标识各端本地自增，
// 跨发起端必然重号）。
func (r *journalFrameRepo) DeleteFrames(
	ctx context.Context, userID int64, peerFingerprint, peerSessionID string,
) error {
	return db.Ctx(ctx).Where(
		"user_id=? AND peer_fingerprint=? AND peer_session_id=?", userID, peerFingerprint, peerSessionID,
	).Delete(&agent_session_entity.JournalFrame{}).Error
}
