// Package follow_svc 编排账号级关注名单（R12 后端 / R14）。
//
// 名单属于账号：userID 一律来自调用方上下文（会话 / 设备 JWT），不由入参提供。
// 它只存「指向」（目标设备指纹 + 会话标识 + 关注时间），不含标题、消息或转录——
// 硬不变量（server 不持有任何会话内容）的唯一例外以「不持有内容」的方式落地。
package follow_svc

import (
	"context"
	"time"

	"agentre-server/internal/model/entity/follow_entity"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/follow_repo"
)

type FollowSvc interface {
	// Follow 关注一条会话（幂等）。账号取自调用方上下文。
	Follow(ctx context.Context, in FollowInput) error
	// Unfollow 取消关注（幂等）：只去掉这一条，不触碰别的关注、更不触碰那条会话。
	Unfollow(ctx context.Context, in FollowInput) error
	// List 返回账号全部关注（任一端读到同一份），并标明目标已不存在的失效条目。
	List(ctx context.Context, userID int64) ([]FollowItem, error)
}

// FollowInput 是关注 / 取消关注的目标。UserID 来自调用方上下文，不由调用方填。
type FollowInput struct {
	UserID            int64
	DeviceFingerprint string
	// SessionID 是发起端本地自增的会话标识。服务端只把它当作不透明指针落库，
	// 不解析、也不知道它指哪条会话。
	SessionID string
}

// FollowItem 是名单里的一条。字段白名单由 internal/api/follow/guard_test.go 锁住：
// 只有指向与时间，没有标题、消息或转录。
type FollowItem struct {
	DeviceFingerprint string
	SessionID         string
	FollowedAt        int64
	// Invalid 目标设备已不在账号活跃设备里（被撤销 / 从未存在）时为 true。
	// 名单内容（指向）本身不变——R14 解除某台设备的授权不改变名单——只是这一条
	// 已无对可指，客户端可据此把失效条目移除。
	Invalid bool
}

type followSvc struct{}

var defaultSvc FollowSvc = newFollowSvc()

func Default() FollowSvc { return defaultSvc }

// SetDefault 换掉默认实现；controller 测试用它注入桩。
func SetDefault(s FollowSvc) { defaultSvc = s }

func New() FollowSvc           { return newFollowSvc() }
func newFollowSvc() *followSvc { return &followSvc{} }

func (s *followSvc) Follow(ctx context.Context, in FollowInput) error {
	now := time.Now().UnixMilli()
	f := &follow_entity.FollowedSession{
		UserID:            in.UserID,
		DeviceFingerprint: in.DeviceFingerprint,
		SessionID:         in.SessionID,
		FollowedAt:        now,
		Createtime:        now,
		Updatetime:        now,
	}
	return follow_repo.Follow().Follow(ctx, f)
}

func (s *followSvc) Unfollow(ctx context.Context, in FollowInput) error {
	return follow_repo.Follow().Unfollow(ctx, in.UserID, in.DeviceFingerprint, in.SessionID)
}

func (s *followSvc) List(ctx context.Context, userID int64) ([]FollowItem, error) {
	rows, err := follow_repo.Follow().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	// 目标是否仍存活，按账号当前活跃设备集合判断。失效是读取时由名单（账号级）
	// 与设备（设备级）对齐算出来的，不写名单——解除某台设备的授权因此不改名单
	// 内容（R14），只是这一条在读取时变得 invalid。离线设备仍在活跃集合里，
	// 机器离线不影响名单（R13）。
	active := make(map[string]struct{}, 8)
	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, d := range devices {
		active[d.Fingerprint] = struct{}{}
	}

	out := make([]FollowItem, 0, len(rows))
	for _, r := range rows {
		_, ok := active[r.DeviceFingerprint]
		out = append(out, FollowItem{
			DeviceFingerprint: r.DeviceFingerprint,
			SessionID:         r.SessionID,
			FollowedAt:        r.FollowedAt,
			Invalid:           !ok,
		})
	}
	return out, nil
}
