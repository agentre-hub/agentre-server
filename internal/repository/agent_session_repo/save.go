// Package agent_session_repo 是账号级关注名单的数据访问层（R12 后端 / R14）。
package agent_session_repo

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"gorm.io/gorm/clause"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/dbutil"
)

//go:generate mockgen -source save.go -destination mock_agent_session_repo/mock_save.go

type SaveRepo interface {
	// Save 把一条对话收进账号的名单；同 (user_id, peer_fingerprint,
	// peer_session_id) 已存在时是 no-op（R12 幂等），保留首次保存时间。
	Save(ctx context.Context, f *agent_session_entity.SessionSave) error
	// Delete 把一条移出名单；从未保存过时是 no-op（R12 幂等），不触碰别的条目。
	//
	// 按身份删，不按机器：身份是 (账号, 发起端, 会话标识)，承载它的机器是这条
	// 记录的属性而不是它的一半。
	Delete(ctx context.Context, userID int64, peerFingerprint, peerSessionID string) error
	// FindByIdentity 取出一条已保存的对话，没有则交回 nil（不是错误）。
	//
	// 存在的理由只有一个：删除要知道**去哪台机器**补删，而那件事只有账号这边记着
	// ——调用方手上通常只有身份（发起端 + 会话标识），发起端是浏览器时它压根不
	// 认识承载它的机器。
	FindByIdentity(
		ctx context.Context, userID int64, peerFingerprint, peerSessionID string,
	) (*agent_session_entity.SessionSave, error)
	// ListByUser 返回账号里保存的全部对话。只按账号过滤、不按在线态过滤：机器离线时
	// 该条仍在名单里（R13）。
	ListByUser(ctx context.Context, userID int64) ([]*agent_session_entity.SessionSave, error)
	// ListMachines 交出全库范围内「有账号保存过对话」的机器，按
	// (user_id, device_fingerprint) 去重。
	//
	// **只给镜像的周期巡检用，不要从请求路径上调它。** 它按定义没有账号作用域：
	// 巡检问的是「整个部署里哪些机器该被跟上」，而请求路径上的每一次读都必须限定
	// 在调用方自己的账号里（那是 ListByUser 的事）。它也因此是只读的。
	ListMachines(ctx context.Context) ([]Machine, error)
}

// Machine 是一台承载着已保存对话的机器：账号 + 它的设备指纹。同一个指纹值在两个
// 账号下是两台互不相干的机器，所以账号是身份的一半。
type Machine struct {
	UserID      int64  `gorm:"column:user_id"`
	Fingerprint string `gorm:"column:device_fingerprint"`
}

var defaultSave SaveRepo

func Save() SaveRepo          { return defaultSave }
func RegisterSave(i SaveRepo) { defaultSave = i }
func NewSave() SaveRepo       { return &saveRepo{} }

type saveRepo struct{}

// Save 是一条语句的条件插入：命中唯一索引时那条 INSERT 什么都不改，由数据库原子裁决，
// 并发重复保存两边都成功、只落一行。先查再插会在两个副本同时首次保存时双双
// 走到 INSERT，竞败方撞唯一索引拿到一个约束错误。
func (r *saveRepo) Save(ctx context.Context, f *agent_session_entity.SessionSave) error {
	return db.Ctx(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "user_id"}, {Name: "peer_fingerprint"}, {Name: "peer_session_id"},
		},
		DoNothing: true,
	}).Create(f).Error
}

func (r *saveRepo) Delete(
	ctx context.Context, userID int64, peerFingerprint, peerSessionID string,
) error {
	return db.Ctx(ctx).Where(
		"user_id=? AND peer_fingerprint=? AND peer_session_id=?",
		userID, peerFingerprint, peerSessionID,
	).Delete(&agent_session_entity.SessionSave{}).Error
}

func (r *saveRepo) FindByIdentity(
	ctx context.Context, userID int64, peerFingerprint, peerSessionID string,
) (*agent_session_entity.SessionSave, error) {
	// 没保存过不是错误：删一条早已删过的对话照样是成功（R12 幂等）。
	return dbutil.FindOne[agent_session_entity.SessionSave](db.Ctx(ctx).Where(
		"user_id=? AND peer_fingerprint=? AND peer_session_id=?",
		userID, peerFingerprint, peerSessionID,
	))
}

func (r *saveRepo) ListByUser(ctx context.Context, userID int64) ([]*agent_session_entity.SessionSave, error) {
	var out []*agent_session_entity.SessionSave
	if err := db.Ctx(ctx).Where("user_id=?", userID).
		Order("followed_at DESC, id DESC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

// ListMachines 是一条 SELECT DISTINCT：一台机器上保存了多少条对话不影响答案，
// 巡检要的是机器本身。排序只为让每一轮扫描的顺序稳定，便于读日志对照。
func (r *saveRepo) ListMachines(ctx context.Context) ([]Machine, error) {
	var out []Machine
	if err := db.Ctx(ctx).Model(&agent_session_entity.SessionSave{}).
		Distinct("user_id", "device_fingerprint").
		Order("user_id ASC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}
