package mirror_svc

import (
	"context"
	"errors"
	"fmt"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
)

// Sessions 是账号那一侧对镜像的几个动作：保存时把一条对话纳入镜像、删除时清掉
// server 上它的内容并把删除传到执行端、设备被撤销时清掉挂在那台机器上的待办。
//
// 「怎么跟住一台机器」不在这里（那是 Supervisor），「哪些机器该被跟」也不在这里
// （那是 Reconciler）。本类型只表达**范围的进出**，与 saved_session_svc 的那两个消费侧
// 接口一一对应——装配处把两者接起来，两个 service 互不 import。
type Sessions struct {
	sup *Supervisor
}

// NewSessions 依附在本副本那份常驻镜像上：删除要停掉正在跑的镜像，保存要让它开始，
// 两件事都得对着同一个 Supervisor 说。
func NewSessions(sup *Supervisor) *Sessions { return &Sessions{sup: sup} }

// Begin 把一条刚保存的对话纳入镜像：跟住承载它的那台机器，并按账号此刻的保存名单
// 同步。幂等——已经在跟的机器只是补一次同步，不重连。
//
// 机器联系不上时如实报错：账号里那一条留着，巡检会替它接上，但调用方不能被告知
// 「已经在存了」。
func (s *Sessions) Begin(ctx context.Context, userID int64, machineFingerprint, conversationID string) error {
	saved, err := savedOnMachine(ctx, userID, machineFingerprint)
	if err != nil {
		return err
	}
	claimed, err := s.sup.Follow(ctx, userID, machineFingerprint, saved)
	if err != nil {
		return fmt.Errorf("start mirroring %s on %s: %w", conversationID, machineFingerprint, err)
	}
	if !claimed {
		// 别的副本正跟着这台机器：它下一轮巡检会把这条新保存的对话一起同步。
		// 正常路径，不是错误——同一台机器只该被一个副本跟着。
		logger.Ctx(ctx).Info("mirror_svc.Begin: machine is followed by another replica",
			zap.Int64("userId", userID), zap.String("machineFingerprint", machineFingerprint),
			zap.String("conversationId", conversationID))
	}
	return nil
}

// Purge 停掉一条对话的镜像并清掉 server 上它的全部内容（摘要与转录帧）。
// 已经没有的时候是 no-op 而不是错误——删除要幂等。
//
// 三步的次序是有意的：先摘、再清帧、最后清摘要。
//   - 先摘再清：反过来的话，正跟着这台机器的那条连接会在两步之间把刚清掉的帧写回来。
//   - 帧在摘要之前：清帧失败时摘要还在，这条对话仍列在索引里、调用方收到错误可以
//     重试；反过来清则会留下一段读不到、也没人知道还在的转录——决策 2 的隐私边界
//     正是破在这里。
func (s *Sessions) Purge(ctx context.Context, userID int64, machineFingerprint, conversationID string) error {
	s.sup.forgetSession(userID, machineFingerprint, conversationID)
	if err := agent_session_repo.JournalFrame().DeleteFrames(ctx, userID, conversationID); err != nil {
		return fmt.Errorf("purge mirrored frames: %w", err)
	}
	if err := agent_session_repo.Summary().DeleteSummary(ctx, userID, conversationID); err != nil {
		return fmt.Errorf("purge mirrored summary: %w", err)
	}
	logger.Ctx(ctx).Info("mirror_svc.Purge: server copy removed",
		zap.Int64("userId", userID), zap.String("machineFingerprint", machineFingerprint),
		zap.String("conversationId", conversationID))
	return nil
}

// DeleteOnMachine 把删除传到执行那条对话的机器上。返回 nil 表示那一端已经没有这条
// 会话了——这是**后置条件**而不是「删了几行」，因此重复删除照样回 nil。
//
// 它每次自己拨一条短连接，用完就收，即使本副本正跟着这台机器也一样：删除是用户
// 手点出来的、极少发生，而复用常驻连接要把那条连接的生命周期暴露给请求路径，换来
// 的只是省下一次握手。
func (s *Sessions) DeleteOnMachine(ctx context.Context, userID int64, machineFingerprint, conversationID string) error {
	conn, err := s.sup.dial(ctx, machineKey{userID: userID, fingerprint: machineFingerprint}, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	// peerFingerprint 有意不填：这条连接通到的就是那台机器，而在账号鉴权的连接上
	// 点名一个本可以省略的对端会被拒（省略即「调用方自己那一端」）。
	// 应答里的 deleted 有意不看：契约是**后置条件**——「那一端已经没有这条会话了」，
	// 而不是「这一次删掉了几行」。对面回 deleted:false（它那儿早就没有了）与
	// deleted:true 对调用方是同一件事，重复删除因此照样成功。
	if _, err := conn.SessionDelete(ctx, &agentrewire.SessionDeleteRequest{
		ConversationId: conversationID,
	}); err != nil {
		return fmt.Errorf("delete session on peer: %w", err)
	}
	logger.Ctx(ctx).Info("mirror_svc.DeleteOnMachine: machine deleted its own copy",
		zap.Int64("userId", userID), zap.String("machineFingerprint", machineFingerprint),
		zap.String("conversationId", conversationID))
	return nil
}

// ReplayPendingDeletes 把攒下的删除待办补做掉：删除在机器离线时照样生效，server
// 那一份当场就没了，而执行端那一份欠在待办里等它回来（决策 6）。这一步就是「回来」
// 那一刻——没有它，本轮删除最常见的那个情形（机器离线）只兑现一半。
//
// 它由周期巡检触发，取材是**待办表本身**而不是保存名单：删掉一台离线机器上最后一
// 条对话之后，那台机器再也不出现在保存名单里，而它恰恰还欠着一条删除。
//
// 每条待办的去向与 saved_session_svc.Delete 当场那一次同构，多一条「意图已被收回」：
//   - 删成了 → 勾掉；
//   - 对面不认识这个方法 → 协议违约：记一条 Error、把错误上交，待办也勾掉——
//     重试多少次都是同一个结果，留着只会对着一台永远答不了的机器重放到天荒地老；
//   - 那条对话已经被重新保存 → 不发出去，勾掉（见 replayMachineDeletes）；
//   - 机器又走了 / 这一次没删成 → 留着，下一轮再来。
//
// 一台机器出问题不打断整轮：错误逐条收集、一并上交，由调用方记一条日志。
func (s *Sessions) ReplayPendingDeletes(ctx context.Context) error {
	machines, err := agent_session_repo.DeleteTodo().ListPendingMachines(ctx)
	if err != nil {
		return fmt.Errorf("list machines owing a session delete: %w", err)
	}
	var (
		errs    []error
		done    int
		waiting int
	)
	for _, m := range machines {
		online, err := s.sup.relay.IsDaemonOnline(ctx, m.UserID, m.DeviceFingerprint)
		if err != nil {
			errs = append(errs, fmt.Errorf("machine %s: check presence: %w", m.DeviceFingerprint, err))
			continue
		}
		if !online {
			// 它还没回来。待办原样留着——这正是它存在的理由。
			waiting++
			continue
		}
		cleared, err := s.replayMachineDeletes(ctx, m)
		done += cleared
		if err != nil {
			errs = append(errs, fmt.Errorf("machine %s: %w", m.DeviceFingerprint, err))
		}
	}
	logger.Ctx(ctx).Info("mirror_svc.ReplayPendingDeletes: pass finished",
		zap.Int("machines", len(machines)), zap.Int("cleared", done),
		zap.Int("stillOffline", waiting), zap.Int("failed", len(errs)))
	return errors.Join(errs...)
}

// replayMachineDeletes 补做一台机器欠下的每一条删除，交回真正勾掉的条数。
//
// 一条失败不跳过后面几条：它们各是一条对话，彼此不相干。
func (s *Sessions) replayMachineDeletes(ctx context.Context, m agent_session_repo.PendingMachine) (int, error) {
	todos, err := agent_session_repo.DeleteTodo().ListDeleteTodosByDevice(ctx, m.UserID, m.DeviceFingerprint)
	if err != nil {
		return 0, fmt.Errorf("list pending deletes: %w", err)
	}
	// 账号此刻的保存名单是权威（与 Mirror.pruneUnwanted 同一条原则）：机器回来之后
	// 用户可能把同一条**重新保存**了，那条删除的意图已经被他自己收回。照着待办打
	// 过去，毁掉的是他刚刚保存的那条对话——而两次动作之间只隔着一轮巡检。
	saved, err := savedOnMachine(ctx, m.UserID, m.DeviceFingerprint)
	if err != nil {
		return 0, err
	}
	savedAgain := make(map[string]bool, len(saved))
	for _, one := range saved {
		savedAgain[one.ConversationID] = true
	}
	var (
		errs    []error
		cleared int
	)
	for _, todo := range todos {
		if savedAgain[todo.ConversationID] {
			// 收回的删除意图也不该一直排在那儿。
			logger.Ctx(ctx).Info("mirror_svc.ReplayPendingDeletes: conversation was saved again, dropping the delete",
				zap.Int64("userId", todo.UserID), zap.String("machineFingerprint", todo.DeviceFingerprint),
				zap.String("conversationId", todo.ConversationID))
			if err := agent_session_repo.DeleteTodo().RemoveDeleteTodo(
				ctx, todo.UserID, todo.ConversationID); err != nil {
				errs = append(errs, fmt.Errorf("conversation %s: clear todo: %w", todo.ConversationID, err))
				continue
			}
			cleared++
			continue
		}
		err := s.DeleteOnMachine(ctx, todo.UserID, todo.DeviceFingerprint, todo.ConversationID)
		switch {
		case err == nil:
		case isMethodNotFound(err):
			logger.Ctx(ctx).Error("mirror_svc.ReplayPendingDeletes: machine violated the negotiated protocol",
				zap.Int64("userId", todo.UserID), zap.String("machineFingerprint", todo.DeviceFingerprint),
				zap.String("conversationId", todo.ConversationID), zap.Error(err))
			errs = append(errs, fmt.Errorf("conversation %s: protocol method missing: %w", todo.ConversationID, err))
		default:
			// 机器又走了，或这一次没删成：待办留着，下一轮再来。
			errs = append(errs, fmt.Errorf("conversation %s: %w", todo.ConversationID, err))
			continue
		}
		if err := agent_session_repo.DeleteTodo().RemoveDeleteTodo(
			ctx, todo.UserID, todo.ConversationID); err != nil {
			// 删是删掉了，待办没勾掉：下一轮会再删一遍，而两端都幂等。
			errs = append(errs, fmt.Errorf("conversation %s: clear todo: %w", todo.ConversationID, err))
			continue
		}
		cleared++
	}
	return cleared, errors.Join(errs...)
}

func isMethodNotFound(err error) bool {
	var wireErr *relaywire.Error
	return errors.As(err, &wireErr) && wireErr.Code == relaywire.CodeMethodNotFound
}

// PurgeMachineDeleteTodos 清掉挂在一台机器上的全部删除待办。设备被撤销之后那些
// 指令永远执行不了——那台机器已经不归这个账号管（决策 7）。账号里那些对话本身不动：
// 它们留着、读得到，只是此后只读。
func (s *Sessions) PurgeMachineDeleteTodos(ctx context.Context, userID int64, peerFingerprint string) error {
	if err := agent_session_repo.DeleteTodo().RemoveDeleteTodosByDevice(ctx, userID, peerFingerprint); err != nil {
		return fmt.Errorf("purge delete todos of the revoked machine: %w", err)
	}
	return nil
}

// savedOnMachine 读出账号在这台机器上保存的全部对话。
//
// 名单（agent_session_saves）是镜像范围的唯一来源，也就是隐私开关本身：没保存过的
// 对话一个字都不会落在 server 上（决策 2）。
//
// fingerprint 是**承载**这条对话的那台机器（要连的就是它）；交回去的是每条对话的
// conversation_id，Mirror.Sync 拿它跟执行端报的清单逐条比对。
func savedOnMachine(ctx context.Context, userID int64, fingerprint string) ([]SavedSession, error) {
	byMachine, err := savedByMachine(ctx, userID)
	if err != nil {
		return nil, err
	}
	return byMachine[fingerprint], nil
}

// savedByMachine 把账号的保存名单按机器分好组：巡检一个账号只读一次名单，而不是
// 每台机器读一次。
//
// **分组键与身份是两回事**，这是本函数唯一要讲清楚的事：
//
//   - 分组键 device_fingerprint = 承载这条对话的那台机器。巡检据它决定去连谁
//     （ListMachines / IsDaemonOnline / dial 用的都是它）。
//   - SavedSession.ConversationID = 这条对话本身。Mirror.Sync 拿它跟执行端报回来
//     的清单比对，决定这条对话在不在镜像范围里。
//
// 发起端指纹此前兼任身份的一半，那一段（以及它在 web 派发场景下的失配）随
// conversation_id 落地一并消失：两条不同的对话由构造不可能同号，比对因此只有一个键。
func savedByMachine(ctx context.Context, userID int64) (map[string][]SavedSession, error) {
	rows, err := agent_session_repo.Save().ListByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list saved conversations: %w", err)
	}
	out := make(map[string][]SavedSession, len(rows))
	for _, row := range rows {
		out[row.DeviceFingerprint] = append(out[row.DeviceFingerprint],
			SavedSession{ConversationID: row.ConversationID})
	}
	return out, nil
}
