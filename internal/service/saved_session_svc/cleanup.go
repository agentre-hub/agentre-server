package saved_session_svc

import (
	"context"
	"errors"
	"sort"

	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/service/agent_session_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// 控制台批量清理（规格 2026-11-12-session-history-cleanup「批量清理」）：在账号**已保存**
// 的对话里按条件筛出一批，预览数量与逐机器的分布，确认后逐条走 Delete——语义与控制台
// 单条删除一致（server 副本、执行端、发起端桌面一并处理，决策 4）。

// 失败原因码：给前端据此用中文重说，不含任何机器原话（日志里才有错误细节）。
const (
	// CleanupReasonMachineProtocol 执行端违反已协商的协议（缺删除方法）；server 那份已删。
	CleanupReasonMachineProtocol = "machine_protocol_violation"
	// CleanupReasonInternal 这一条没删成（库或通道出错），重试是安全的。
	CleanupReasonInternal = "delete_failed"
)

// CleanupFilter 是清理的条件。零值 = 不按那一项过滤。
type CleanupFilter struct {
	// BeforeMs：最后活动早于它（Unix 毫秒）；0 = 全部。
	BeforeMs int64
	// AgentSyncID 空 = 全部 Agent。
	AgentSyncID string
	// ProjectSyncID 空 = 全部项目。
	ProjectSyncID string
}

// CleanupMachine 是预览里一台涉及的机器（执行端，或发起端桌面）名下将被清理的对话数。
type CleanupMachine struct {
	Fingerprint string
	Name        string
	Online      bool
	Count       int
}

// CleanupPreview 是一次预览：Count 不含保留的；ConversationIDs 就是确认后要执行的那一批。
type CleanupPreview struct {
	Count           int
	Retained        int
	ConversationIDs []string
	Machines        []CleanupMachine
}

// CleanupFailure 是执行时没删掉的一条，Reason 是上面的原因码。
type CleanupFailure struct {
	ConversationID string
	Reason         string
}

// CleanupPendingMachine 是暂时联系不上、已记待办的机器（执行端或发起端桌面）：它下次上线时补删 Count 条。
type CleanupPendingMachine struct {
	Fingerprint string
	Name        string
	Count       int
}

// CleanupResult 是一次执行的结果。Retained 是确认之后才变成进行中 / 等待中、因而保留的。
type CleanupResult struct {
	Deleted  int
	Retained int
	Failed   []CleanupFailure
	Pending  []CleanupPendingMachine
}

// presenceProbe 读一批机器的在线态（relay_svc 的批量 DaemonsOnline）；读不出来的格答离线。
// 做成变量只为测试可换；默认实现见 relayPresence。
var presenceProbe = relayPresence

// projectMembers 解出某个项目名下的对话标识集合。项目归属的判法只有索引读侧那一份
// （agentred 按位置、桌面按自报标识，已删项目落回未归，决策 12 / 13），这里原样复用它
// 的项目分组读取，不另写一套。
var projectMembers = indexProjectMembers

func relayPresence(ctx context.Context, userID int64, fps []string) ([]bool, error) {
	svc := relay_svc.Default()
	if batch, ok := svc.(interface {
		DaemonsOnline(ctx context.Context, accountID int64, fingerprints []string) ([]bool, error)
	}); ok {
		return batch.DaemonsOnline(ctx, userID, fps)
	}
	out := make([]bool, len(fps))
	var firstErr error
	for i, fp := range fps {
		on, err := svc.IsDaemonOnline(ctx, userID, fp)
		if err != nil && firstErr == nil {
			firstErr = err
		}
		out[i] = err == nil && on
	}
	return out, firstErr
}

func indexProjectMembers(ctx context.Context, userID int64, projectSyncID string) (map[string]bool, error) {
	members := map[string]bool{}
	cursor := ""
	for {
		page, err := agent_session_svc.SessionRead().SessionIndex(ctx, agent_session_svc.SessionIndexQuery{
			UserID: userID,
			Axis:   agent_session_svc.AxisProject,
			Scope:  "project:" + projectSyncID,
			Cursor: cursor,
			Limit:  200,
		})
		if err != nil {
			return nil, err
		}
		for _, it := range page.Items {
			members[it.ConversationID] = true
		}
		if !page.HasMore || page.Cursor == "" {
			return members, nil
		}
		cursor = page.Cursor
	}
}

// retained 说这条对话现在不该碰：进行中（生命周期 running）或在等用户操作。
// 预览与执行共用这一处判据。
func retained(s *agent_session_entity.SessionSummary) bool {
	return s.WaitingForInput || s.LifecycleState == relaywire.SessionLifecycleRunning
}

// PreviewCleanup 见 SavedSessionSvc。
func (s *savedSessionSvc) PreviewCleanup(
	ctx context.Context, userID int64, filter CleanupFilter,
) (CleanupPreview, error) {
	rows, err := agent_session_repo.Cleanup().ListCleanupCandidates(ctx, agent_session_repo.CleanupCandidateQuery{
		UserID: userID, BeforeMs: filter.BeforeMs, AgentSyncID: filter.AgentSyncID,
	})
	if err != nil {
		return CleanupPreview{}, err
	}
	var members map[string]bool
	if filter.ProjectSyncID != "" {
		if members, err = projectMembers(ctx, userID, filter.ProjectSyncID); err != nil {
			return CleanupPreview{}, err
		}
	}

	devices, err := s.accountDevices(ctx, userID)
	if err != nil {
		return CleanupPreview{}, err
	}

	out := CleanupPreview{ConversationIDs: []string{}, Machines: []CleanupMachine{}}
	perMachine := map[string]int{}
	for _, row := range rows {
		if filter.ProjectSyncID != "" && !members[row.ConversationID] {
			continue
		}
		if retained(row) {
			out.Retained++
			continue
		}
		out.Count++
		out.ConversationIDs = append(out.ConversationIDs, row.ConversationID)
		perMachine[row.MachineFingerprint]++
		// 发起端是账号里另一台桌面：Delete 也会让它删本机那份，它同样是涉及的机器。
		if fp := row.PeerFingerprint; fp != "" && fp != row.MachineFingerprint {
			if d := devices[fp]; d != nil && d.Kind == device_entity.KindDesktop {
				perMachine[fp]++
			}
		}
	}

	// 已不在账号里的机器不单列（决策 13），它名下的对话仍计在 Count 里。
	var fps []string
	for fp := range perMachine {
		if _, ok := devices[fp]; ok {
			fps = append(fps, fp)
		}
	}
	sort.Strings(fps)
	online, perr := presenceProbe(ctx, userID, fps)
	if perr != nil {
		// 在线态只是说明性的：读不出来就如实答离线，不挡预览。
		logger.Ctx(ctx).Warn("saved_session_svc.PreviewCleanup: presence unavailable",
			zap.Int64("userId", userID), zap.Int("machines", len(fps)), zap.Error(perr))
	}
	for i, fp := range fps {
		out.Machines = append(out.Machines, CleanupMachine{
			Fingerprint: fp, Name: devices[fp].EffectiveName(),
			Online: perr == nil && i < len(online) && online[i],
			Count:  perMachine[fp],
		})
	}
	sort.SliceStable(out.Machines, func(i, j int) bool {
		if out.Machines[i].Count != out.Machines[j].Count {
			return out.Machines[i].Count > out.Machines[j].Count
		}
		return out.Machines[i].Fingerprint < out.Machines[j].Fingerprint
	})
	logger.Ctx(ctx).Info("saved_session_svc.PreviewCleanup",
		zap.Int64("userId", userID), zap.Int("count", out.Count),
		zap.Int("retained", out.Retained), zap.Int("machines", len(out.Machines)))
	return out, nil
}

// Cleanup 见 SavedSessionSvc。逐条重新判断后再删：确认之后才变成进行中 / 等待中的
// 保留，已不在名单里的（别处先删了，或根本不是本账号的）跳过，其余走 Delete。
func (s *savedSessionSvc) Cleanup(
	ctx context.Context, userID, callerDeviceID int64, ids []string,
) (CleanupResult, error) {
	uniq := make([]string, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			uniq = append(uniq, id)
		}
	}
	rows, err := agent_session_repo.Cleanup().ListSavedByConversationIDs(ctx, userID, uniq)
	if err != nil {
		return CleanupResult{}, err
	}
	byID := make(map[string]*agent_session_entity.SessionSummary, len(rows))
	for _, row := range rows {
		byID[row.ConversationID] = row
	}

	out := CleanupResult{Failed: []CleanupFailure{}, Pending: []CleanupPendingMachine{}}
	pending := map[string]int{}
	for _, id := range uniq {
		row, ok := byID[id]
		if !ok {
			continue
		}
		if retained(row) {
			out.Retained++
			continue
		}
		res, err := s.deleteCopies(ctx, SessionRef{UserID: userID, ConversationID: id, CallerDeviceID: callerDeviceID})
		if err != nil {
			reason := CleanupReasonInternal
			if errors.Is(err, ErrMachineProtocolViolation) {
				reason = CleanupReasonMachineProtocol
			}
			logger.Ctx(ctx).Warn("saved_session_svc.Cleanup: delete failed",
				zap.Int64("userId", userID), zap.String("conversationId", id),
				zap.String("reason", reason), zap.Error(err))
			out.Failed = append(out.Failed, CleanupFailure{ConversationID: id, Reason: reason})
			continue
		}
		out.Deleted++
		if res.carrier == MachineDeletePending {
			pending[row.MachineFingerprint]++
		}
		if res.initiatorFP != "" && res.initiator == MachineDeletePending {
			pending[res.initiatorFP]++
		}
	}

	if len(pending) > 0 {
		devices, err := s.accountDevices(ctx, userID)
		if err != nil {
			// 删除已经完成；名字取不到不该让这次执行报错，名字留空。
			logger.Ctx(ctx).Warn("saved_session_svc.Cleanup: device names unavailable",
				zap.Int64("userId", userID), zap.Error(err))
			devices = map[string]*device_entity.Device{}
		}
		for fp, n := range pending {
			d, inAccount := devices[fp]
			if !inAccount && len(devices) > 0 {
				continue // 已不在账号里的机器不单列（决策 13）
			}
			name := ""
			if d != nil {
				name = d.EffectiveName()
			}
			out.Pending = append(out.Pending, CleanupPendingMachine{Fingerprint: fp, Name: name, Count: n})
		}
		sort.Slice(out.Pending, func(i, j int) bool { return out.Pending[i].Fingerprint < out.Pending[j].Fingerprint })
	}
	logger.Ctx(ctx).Info("saved_session_svc.Cleanup",
		zap.Int64("userId", userID), zap.Int("requested", len(uniq)), zap.Int("deleted", out.Deleted),
		zap.Int("retained", out.Retained), zap.Int("failed", len(out.Failed)), zap.Int("pendingMachines", len(out.Pending)))
	return out, nil
}

// accountDevices 是账号在用设备的 指纹 → 设备（显示名取 Device.EffectiveName，备注名
// 优先；种类用来认出发起端桌面）。
func (s *savedSessionSvc) accountDevices(ctx context.Context, userID int64) (map[string]*device_entity.Device, error) {
	devices, err := device_repo.Device().ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]*device_entity.Device, len(devices))
	for _, d := range devices {
		if d.IsActive() {
			out[d.Fingerprint] = d
		}
	}
	return out, nil
}
