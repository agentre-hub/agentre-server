// Package saved_session_svc 编排账号里保存的对话：保存把一条对话收进账号、镜像随即对它
// 开始；删除清掉账号里的这一份，并让执行那条对话的机器也删掉它自己那一份
// （规格 2026-08-18-server-session-mirror「保存与删除」，决策 5 / 6）。
//
// 账号归属：userID 一律来自调用方上下文（会话 / 设备 JWT），不由入参提供。
//
// 「账号里保存过的对话」这个集合**就是**镜像的范围，也就是隐私开关（决策 2）：
// 没保存过的对话，一个字都不会落在 server 上。本包因此只表达范围的进出（Save /
// Delete），内容怎么存、存在哪，全在 mirror_svc 那一侧——边界由
// internal/api/savedsession/guard_test.go 机械守住。
package saved_session_svc

import (
	"context"
	"errors"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
)

type SavedSessionSvc interface {
	// Save 把一条对话收进账号并让镜像对它开始（幂等）。账号取自调用方上下文。
	Save(ctx context.Context, ref SessionRef) error
	// Delete 删掉账号里的这条对话，并让执行端也删（决策 6）。server 那一份在返回
	// 时一定已经没了；执行端那一份的去向由 PeerDeleteOutcome 如实交代。幂等：
	// 删一条早已删过的对话不是错误。
	Delete(ctx context.Context, ref SessionRef) (PeerDeleteOutcome, error)
	// List 返回账号里已保存的全部对话（任一端读到同一份），并标明目标已不存在的条目。
	List(ctx context.Context, userID int64) ([]SavedSessionRef, error)
}

// SessionRef 指向一条对话：账号 + 它的 **conversation_id** + 承载它的机器 + 发起它
// 的那一端。UserID 来自调用方上下文，不由调用方填。
//
// **身份只有 ConversationID 一个**
// （2026-08-31-conversation-centric-addressing.md「会话身份」）。另外两个指纹回答
// 的是别的问题：
//
//   - MachineFingerprint 回答「去连哪一台」，对得上 devices.fingerprint。它是这
//     条对话的**属性**，不是身份的一部分。
//   - PeerFingerprint 是**发起**它的那一端，落进 peer_fingerprint 那一列作来源
//     标注与授权。在本机 daemon 上开的对话（桌面端）两者同值，所以保存时它允许
//     留空，Save 会把它落成 MachineFingerprint；取值一律走 Initiator()。
//
// 删除只要身份——机器由服务端自己按 conversation_id 查出来，因为发起端是浏览器时
// 调用方压根不认识那台机器。
type SessionRef struct {
	UserID             int64
	ConversationID     string
	MachineFingerprint string
	PeerFingerprint    string
}

// Initiator 解出这条对话的发起端：留空即「就是承载它的那台机器自己」。
func (r SessionRef) Initiator() string {
	if r.PeerFingerprint == "" {
		return r.MachineFingerprint
	}
	return r.PeerFingerprint
}

// PeerDeleteOutcome 说的是**执行端那一份**的去向；server 那一份在所有分支里都已经
// 删掉了（删除在机器离线时照样生效——界面上不留「已删除但还在」的中间态）。
type PeerDeleteOutcome string

const (
	// PeerDeleted 执行端也已经没有这条会话了。
	PeerDeleted PeerDeleteOutcome = "deleted"
	// PeerDeletePending 那台机器现在联系不上（或这一次没删成）：已经记下待办，
	// 它下次上线时补删。
	PeerDeletePending PeerDeleteOutcome = "pending"
)

var (
	// ErrPeerOffline 执行那条对话的机器现在联系不上：删除留一条待办，机器回来时补删。
	ErrPeerOffline = errors.New("saved_session_svc: peer is offline")
	// ErrPeerProtocolViolation 表示已通过版本握手的执行端缺少当前协议要求的方法。
	// 这不是可通过重试恢复的传输失败，也不是需要兼容的旧版本。
	ErrPeerProtocolViolation = errors.New("saved_session_svc: peer violated the negotiated protocol")
)

// SessionMirror 是保存 / 删除这一侧对「镜像」的全部需要（ISP：只有开始与清除两件
// 事）。实现住在 mirror_svc——它才知道怎么连中继、怎么落帧；本包只表达范围的进出，
// 依赖方向因此是 saved_session_svc → 接口 ← 实现（DIP），两个 service 互不 import。
type SessionMirror interface {
	// Begin 把一条刚保存的对话纳入镜像：从此它的摘要与转录在 server 上有一份。
	// 重复保存同一条会再调一次，实现必须幂等。
	Begin(ctx context.Context, ref SessionRef) error
	// Purge 停掉这条对话的镜像并清掉 server 上它的全部内容（摘要与转录帧）。
	// 已经没有的时候是 no-op 而不是错误——删除要幂等。
	Purge(ctx context.Context, ref SessionRef) error
}

// PeerSessionDeleter 把删除传播到执行那条对话的机器上：中继 wire 的
// runtime.session.delete（params {conversationId, peerFingerprint?}，result 带 deleted）。
// agentred 上删的是会话行与它的整段通知日志，桌面端上删的是那台电脑自己那条对话
// 本体，两种端一视同仁（决策 16）。
//
// 把 Protobuf RPC method-not-found 翻成 ErrPeerProtocolViolation
// 是**实现方**的事：wire 上的
// 错误码只该出现在会说 wire 的那一层（对照桌面端的 wire.SessionDeleteCallError），
// 本层只认下面这两个判据。
type PeerSessionDeleter interface {
	// DeleteOnPeer 回 nil = 那一端已经没有这条会话了。这是**后置条件**而不是
	// 「删了几行」，因此重复删除照样回 nil。联系不上回 ErrPeerOffline；对面太老、
	// 违反已协商协议回 ErrPeerProtocolViolation；其余错误当成「这一次没删成」。
	DeleteOnPeer(ctx context.Context, ref SessionRef) error
}

// sessionMirror / peerDeleter 的默认值都是「什么都还没接上」时的安全占位，与
// device_svc.SetDeviceDataPurger 同一模式：调用方不会在 nil 接口上 panic，行为也
// 不会谎报成功。真实实现由装配处注入。
var (
	sessionMirror SessionMirror      = noopSessionMirror{}
	peerDeleter   PeerSessionDeleter = unreachablePeer{}
)

// SetSessionMirror 注入镜像实现；传 nil 时恢复成空操作。
func SetSessionMirror(m SessionMirror) {
	if m == nil {
		m = noopSessionMirror{}
	}
	sessionMirror = m
}

// SetPeerSessionDeleter 注入执行端删除通道；传 nil 时恢复成「联系不上」。
func SetPeerSessionDeleter(d PeerSessionDeleter) {
	if d == nil {
		d = unreachablePeer{}
	}
	peerDeleter = d
}

// noopSessionMirror 未装配时保存 / 删除照常成立：没有镜像可开，也没有内容要清——
// 那时候库里本来就没有任何会话内容。
type noopSessionMirror struct{}

func (noopSessionMirror) Begin(context.Context, SessionRef) error { return nil }
func (noopSessionMirror) Purge(context.Context, SessionRef) error { return nil }

// unreachablePeer 未装配时一律当成「联系不上那台机器」：删除照常在 server 这边生效
// 并留下一条待办，绝不谎报「执行端也删了」。
type unreachablePeer struct{}

func (unreachablePeer) DeleteOnPeer(context.Context, SessionRef) error { return ErrPeerOffline }

// SavedSessionRef 是账号里已保存的一条。
type SavedSessionRef struct {
	DeviceFingerprint string
	ConversationID    string
	FollowedAt        int64
	// Invalid 目标设备已不在账号活跃设备里（被撤销 / 从未存在）时为 true。
	// 名单内容本身不变——R14 解除某台设备的授权不改变名单——只是这一条已无对可指。
	Invalid bool
}

type savedSessionSvc struct{}

var defaultSvc SavedSessionSvc = newSavedSessionSvc()

func Default() SavedSessionSvc { return defaultSvc }

// SetDefault 换掉默认实现；controller 测试用它注入桩。
func SetDefault(s SavedSessionSvc) { defaultSvc = s }

func New() SavedSessionSvc                 { return newSavedSessionSvc() }
func newSavedSessionSvc() *savedSessionSvc { return &savedSessionSvc{} }

// Save 先把这一条写进账号，再让镜像开始——顺序是有意的：范围就是隐私开关
// （决策 2），内容绝不能先于「用户保存过它」这件事落库。
//
// 镜像开不起来时如实报错：账号里那一条留着（巡检会替它接上），但调用方不能被告知
// 「已经在存了」。
func (s *savedSessionSvc) Save(ctx context.Context, ref SessionRef) error {
	now := time.Now().UnixMilli()
	// 两列各司其职：device_fingerprint 是承载它的机器（镜像据它决定去连谁），
	// peer_fingerprint 是发起端（身份键的另一半）。前者一列担两职的年代，web
	// 控制台派发出去的对话因为两者不同值而永远进不了镜像。
	f := &agent_session_entity.SessionSave{
		UserID:            ref.UserID,
		ConversationID:    ref.ConversationID,
		DeviceFingerprint: ref.MachineFingerprint,
		PeerFingerprint:   ref.Initiator(),
		FollowedAt:        now,
		Createtime:        now,
		Updatetime:        now,
	}
	if err := agent_session_repo.Save().Save(ctx, f); err != nil {
		return err
	}
	return sessionMirror.Begin(ctx, ref)
}

// Delete 的次序：先清 server 上的内容，再把这一条撤出账号，最后才通知执行端。
//
//   - 内容先清、名单后撤：反过来一旦清理失败，库里就会留下一条「没人保存过」的
//     对话的标题与转录——决策 2 的隐私边界正是破在这里。
//   - 执行端最后说，而且它答什么都不改变 server 这边已经删干净的事实：本轮的主
//     场景恰恰是机器离线，要求两边都成功才算删，等于在最常见的情形下删不掉东西
//     （决策 6）。
func (s *savedSessionSvc) Delete(ctx context.Context, ref SessionRef) (PeerDeleteOutcome, error) {
	// 承载它的机器由账号这边查出来，而不是要调用方报：发起端是浏览器时（web 控制台
	// 派发出去的那些），调用方手上只有身份，它压根不认识那台机器。查不到（早已删过）
	// 就沿用调用方给的那一份 —— 幂等删除照常往下走，只是没有机器可通知。
	row, err := agent_session_repo.Save().FindByIdentity(ctx, ref.UserID, ref.ConversationID)
	if err != nil {
		return "", err
	}
	if row != nil {
		ref.MachineFingerprint = row.DeviceFingerprint
	}
	if err := sessionMirror.Purge(ctx, ref); err != nil {
		return "", err
	}
	if err := agent_session_repo.Save().Delete(ctx, ref.UserID, ref.ConversationID); err != nil {
		return "", err
	}
	// 到这里 server 那一份已经没了：它立刻从索引里消失，没有「已删除但还在」的中间态。
	err = peerDeleter.DeleteOnPeer(ctx, ref)
	switch {
	case err == nil:
		logger.Ctx(ctx).Info("saved_session_svc.Delete: both copies deleted",
			zap.Int64("userId", ref.UserID),
			zap.String("machineFingerprint", ref.MachineFingerprint),
			zap.String("peerFingerprint", ref.Initiator()),
			zap.String("conversationId", ref.ConversationID))
		return PeerDeleted, nil
	case errors.Is(err, ErrPeerProtocolViolation):
		logger.Ctx(ctx).Error("saved_session_svc.Delete: peer violated the negotiated protocol",
			zap.Int64("userId", ref.UserID),
			zap.String("machineFingerprint", ref.MachineFingerprint),
			zap.String("peerFingerprint", ref.Initiator()),
			zap.String("conversationId", ref.ConversationID), zap.Error(err))
		return "", err
	default:
		// 离线，或这一次没删成：都是「等它回来再删一遍就成了」，留一条待办。
		now := time.Now().UnixMilli()
		if addErr := agent_session_repo.DeleteTodo().AddDeleteTodo(ctx, &agent_session_entity.DeleteTodo{
			UserID:         ref.UserID,
			ConversationID: ref.ConversationID,
			// 待办表这一列是**机器**（补删时要拨的就是它，见 ReplayPendingDeletes）。
			PeerFingerprint: ref.MachineFingerprint,
			Createtime:      now,
		}); addErr != nil {
			// 待办没记下来，删除就没走完：如实报错，别让执行端那一份被静默地永远
			// 留着。重试是安全的——两边都幂等。
			return "", addErr
		}
		logger.Ctx(ctx).Info("saved_session_svc.Delete: server copy deleted, peer delete pending",
			zap.Int64("userId", ref.UserID),
			zap.String("machineFingerprint", ref.MachineFingerprint),
			zap.String("peerFingerprint", ref.Initiator()),
			zap.String("conversationId", ref.ConversationID),
			zap.Error(err))
		return PeerDeletePending, nil
	}
}

func (s *savedSessionSvc) List(ctx context.Context, userID int64) ([]SavedSessionRef, error) {
	rows, err := agent_session_repo.Save().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	// 目标是否仍存活，按账号当前活跃设备集合判断。失效是读取时由名单（账号级）
	// 与设备（设备级）对齐算出来的，不写名单——解除某台设备的授权因此不改变名单
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

	out := make([]SavedSessionRef, 0, len(rows))
	for _, r := range rows {
		_, ok := active[r.DeviceFingerprint]
		out = append(out, SavedSessionRef{
			DeviceFingerprint: r.DeviceFingerprint,
			ConversationID:    r.ConversationID,
			FollowedAt:        r.FollowedAt,
			Invalid:           !ok,
		})
	}
	return out, nil
}
