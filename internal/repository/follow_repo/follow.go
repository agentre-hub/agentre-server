// Package follow_repo 是账号级关注名单的数据访问层（R12 后端 / R14）。
package follow_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"agentre-server/internal/model/entity/follow_entity"
)

//go:generate mockgen -source follow.go -destination mock_follow_repo/mock_follow.go

type FollowRepo interface {
	// Follow 落一条关注；同 (user_id, device_fingerprint, session_id) 已存在时是
	// no-op（R12 幂等），保留首次关注时间。
	Follow(ctx context.Context, f *follow_entity.FollowedSession) error
	// Unfollow 删掉一条关注；从未关注时是 no-op（R12 幂等），不触碰别的关注。
	Unfollow(ctx context.Context, userID int64, deviceFingerprint, sessionID string) error
	// ListByUser 返回账号全部关注。只按账号过滤、不按在线态过滤：机器离线时
	// 该条仍在名单里（R13）。
	ListByUser(ctx context.Context, userID int64) ([]*follow_entity.FollowedSession, error)
}

var defaultRepo FollowRepo

func Follow() FollowRepo          { return defaultRepo }
func RegisterFollow(i FollowRepo) { defaultRepo = i }
func NewFollow() FollowRepo       { return &repo{} }

type repo struct{}

// Follow 是一条语句的条件插入：ON DUPLICATE KEY ... DO NOTHING 由数据库原子裁决，
// 并发重复关注两边都成功、只落一行。先查再插会在两个副本同时首次关注时双双
// 走到 INSERT，竞败方撞唯一索引拿到一个约束错误。
func (r *repo) Follow(ctx context.Context, f *follow_entity.FollowedSession) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "user_id"}, {Name: "device_fingerprint"}, {Name: "session_id"},
		},
		DoNothing: true,
	}).Create(f).Error
}

func (r *repo) Unfollow(ctx context.Context, userID int64, deviceFingerprint, sessionID string) error {
	return db.Ctx(ctx).Where(
		"user_id=? AND device_fingerprint=? AND session_id=?",
		userID, deviceFingerprint, sessionID,
	).Delete(&follow_entity.FollowedSession{}).Error
}

func (r *repo) ListByUser(ctx context.Context, userID int64) ([]*follow_entity.FollowedSession, error) {
	var out []*follow_entity.FollowedSession
	if err := db.Ctx(ctx).Where("user_id=?", userID).
		Order("followed_at DESC, id DESC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
