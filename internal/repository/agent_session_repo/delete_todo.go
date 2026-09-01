package agent_session_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
)

//go:generate mockgen -source delete_todo.go -destination mock_agent_session_repo/mock_delete_todo.go

// DeleteTodoRepo is the data access seam for agent_session_delete_todos.
type DeleteTodoRepo interface {
	// AddDeleteTodo records a pending delete: the server's own copy is
	// already gone, but the peer that must also delete its local copy was
	// offline at delete time (决策 6). Hitting the existing
	// (user_id, conversation_id) row is a no-op — the same todo is never
	// recorded twice.
	AddDeleteTodo(ctx context.Context, t *agent_session_entity.DeleteTodo) error
	// ListDeleteTodosByPeer returns every pending delete owed by one peer on
	// one account, for that peer's mirror client to execute when it comes
	// back online. Scoped by user_id as well as peer_fingerprint: a read that
	// drops user_id could surface another account's todos for a fingerprint
	// value that collides across accounts.
	ListDeleteTodosByPeer(ctx context.Context, userID int64, peerFingerprint string) ([]*agent_session_entity.DeleteTodo, error)
	// RemoveDeleteTodo clears one todo — the peer executed it, or a device
	// revocation purged it outright (决策 7, device_svc.DeviceDataPurger).
	// Removing an unrecorded todo is a no-op.
	RemoveDeleteTodo(ctx context.Context, userID int64, conversationID string) error
	// RemoveDeleteTodosByPeer 清掉挂在一台机器上的全部待办。设备被撤销之后这些
	// 删除指令永远执行不了——那台机器已经不归这个账号管（决策 7），留着只是一堆
	// 对着谁都发不出去的指令。一条都没有时是 no-op。
	RemoveDeleteTodosByPeer(ctx context.Context, userID int64, peerFingerprint string) error
	// ListPendingMachines 交出全库范围内还欠着删除的机器，按
	// (user_id, peer_fingerprint) 去重——巡检据此知道该找谁补做。
	//
	// **只给镜像的周期巡检用，不要从请求路径上调它**（同 agent_session_repo.ListMachines）：
	// 它按定义没有账号作用域，而请求路径上的每一次读都必须限定在调用方自己的账号里
	// （那是 ListDeleteTodosByPeer 的事）。
	//
	// 取材必须来自待办表本身，不能借用保存名单：删掉一台离线机器上**最后**一条
	// 对话之后，那台机器就再也不出现在保存名单里，而它恰恰还欠着一条删除。
	ListPendingMachines(ctx context.Context) ([]PendingMachine, error)
}

// PendingMachine 是一台还欠着删除的机器：账号 + 它的设备指纹。同一个指纹值在两个
// 账号下是两台互不相干的机器，所以账号是身份的一半（同 agent_session_repo.Machine）。
type PendingMachine struct {
	UserID          int64  `gorm:"column:user_id"`
	PeerFingerprint string `gorm:"column:peer_fingerprint"`
}

var defaultDeleteTodo DeleteTodoRepo

func DeleteTodo() DeleteTodoRepo          { return defaultDeleteTodo }
func RegisterDeleteTodo(i DeleteTodoRepo) { defaultDeleteTodo = i }
func NewDeleteTodo() DeleteTodoRepo       { return &deleteTodoRepo{} }

type deleteTodoRepo struct{}

// AddDeleteTodo 是一条条件插入：命中 uk_agent_session_delete_todos_identity 时什么都不改，
// 与 agent_session_repo.Save 同一模式——先查再插在两个副本同时首次记录时会双双走到
// INSERT，竞败方撞唯一索引拿到一个约束错误。
func (r *deleteTodoRepo) AddDeleteTodo(ctx context.Context, t *agent_session_entity.DeleteTodo) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(t).Error
}

func (r *deleteTodoRepo) ListDeleteTodosByPeer(
	ctx context.Context, userID int64, peerFingerprint string,
) ([]*agent_session_entity.DeleteTodo, error) {
	var out []*agent_session_entity.DeleteTodo
	if err := db.Ctx(ctx).Where("user_id=? AND peer_fingerprint=?", userID, peerFingerprint).
		Order("id ASC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

func (r *deleteTodoRepo) RemoveDeleteTodo(ctx context.Context, userID int64, conversationID string) error {
	return db.Ctx(ctx).Where(
		"user_id=? AND conversation_id=?", userID, conversationID,
	).Delete(&agent_session_entity.DeleteTodo{}).Error
}

// RemoveDeleteTodosByPeer 按账号 + 这台机器圈定：别的机器上的待办一条都不能碰，
// 而少了 user_id 会清掉别的账号压在同一个指纹值上的待办（指纹跨账号可以重复）。
func (r *deleteTodoRepo) RemoveDeleteTodosByPeer(
	ctx context.Context, userID int64, peerFingerprint string,
) error {
	return db.Ctx(ctx).Where(
		"user_id=? AND peer_fingerprint=?", userID, peerFingerprint,
	).Delete(&agent_session_entity.DeleteTodo{}).Error
}

// ListPendingMachines 是一条 SELECT DISTINCT：一台机器上欠着多少条删除不影响答案，
// 巡检要的是机器本身。排序只为让每一轮扫描的顺序稳定，便于读日志对照。
func (r *deleteTodoRepo) ListPendingMachines(ctx context.Context) ([]PendingMachine, error) {
	var out []PendingMachine
	if err := db.Ctx(ctx).Model(&agent_session_entity.DeleteTodo{}).
		Distinct("user_id", "peer_fingerprint").
		Order("user_id ASC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
