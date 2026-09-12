package sessionimport_svc

import (
	"context"
	"errors"
	"fmt"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
)

// maxScanLimit 是一次发现最多列多少条候选。一台跑了半年的机器上有上千份转录，
// 整份塞进一帧会撞上帧上限，而对话框一屏也放不下。
const maxScanLimit = 200

// scanStatusOK 是那台机器说「这一档是问出来的」的判别值（wire.StatusOK）。
const scanStatusOK = "ok"

// ListCandidates 问一台机器它磁盘上有哪些能导的会话。
func (s *sessionImportSvc) ListCandidates(ctx context.Context, in ListCandidatesInput) (*CandidatesView, error) {
	device, err := s.machine(ctx, in.UserID, in.DeviceID)
	if err != nil {
		return nil, err
	}
	limit := in.Limit
	if limit <= 0 || limit > maxScanLimit {
		limit = maxScanLimit
	}

	var scanned *agentrewire.TranscriptImportScanResponse
	callErr := s.machines.WithPeer(ctx, in.UserID, device.Fingerprint,
		func(ctx context.Context, peer TranscriptImportPeer) error {
			response, err := peer.TranscriptImportScan(ctx, &agentrewire.TranscriptImportScanRequest{
				Backends: in.Backends,
				Filter: &agentrewire.TranscriptImportFilter{
					CwdPrefix: in.CwdPrefix, TitleQuery: in.TitleQuery, Limit: int32(limit),
				},
			})
			scanned = response
			return err
		})
	if callErr != nil {
		// 发现这一步**不抛**设备级失败：它是清单上的一档理由，与「某个后端没装」
		// 同一种东西。抛错的话浏览器只剩一句通用报错，而「这台机器不在线」与
		// 「这台机器上没有会话」的去处完全不同。
		issue, known := deviceIssue(ctx, callErr)
		if !known {
			return nil, failed(ctx, callErr, in.DeviceID)
		}
		logger.Ctx(ctx).Info("sessionimport_svc.ListCandidates: machine could not answer",
			zap.Int64("userId", in.UserID), zap.Int64("deviceId", in.DeviceID),
			zap.String("status", issue.Status))
		return &CandidatesView{Candidates: []CandidateView{}, Issues: []ScanIssueView{issue}}, nil
	}

	imported, err := s.importedByProviderSession(ctx, in.UserID, device.Fingerprint)
	if err != nil {
		return nil, err
	}
	view := &CandidatesView{Candidates: []CandidateView{}, Issues: []ScanIssueView{}}
	for _, backend := range scanned.GetBackends() {
		// 按后端的一档：**只有 ok 才算问出来了**，其余（含空串）一律是一档答不出。
		// 判据与执行侧那一份同源（agentre 的 remoteSource.Scan：`Status != StatusOK`
		// 即 unavailable）——空串在这里读成 ok 的话，一台答不出的机器就会在界面上
		// 长成「这个后端没有会话」。
		if backend.GetStatus() != scanStatusOK {
			view.Issues = append(view.Issues, ScanIssueView{
				Backend: backend.GetBackend(), Status: StatusUnavailable, Reason: backend.GetReason(),
			})
		}
		for _, c := range backend.GetCandidates() {
			row := CandidateView{
				Backend: c.GetBackend(), ProviderSessionID: c.GetProviderSessionId(),
				Title: c.GetTitle(), Cwd: c.GetCwd(), StartedAt: c.GetStartedAt(),
				EndedAt: c.GetEndedAt(), Turns: int(c.GetTurns()), Origin: c.GetOrigin(),
				Locator: c.GetLocator(),
			}
			if sessionID, ok := imported[c.GetProviderSessionId()]; ok && c.GetProviderSessionId() != "" {
				row.Imported, row.ImportedSessionID = true, sessionID
			}
			view.Candidates = append(view.Candidates, row)
		}
	}
	return view, nil
}

// machine 解出这次要问的那台机器，并且判定它归不归这个账号。
//
// 不区分「不存在」与「不属于你」：区分开就等于给出一个跨账号的设备存在性探测器
// （与 workspace_svc.DeviceDetail 同一条判据）。
func (s *sessionImportSvc) machine(ctx context.Context, userID, deviceID int64) (*device_entity.Device, error) {
	device, err := device_repo.Device().Find(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	if !device.UsableBy(userID) {
		return nil, i18n.NewNotFoundError(ctx, code.DeviceNotFound)
	}
	return device, nil
}

// importedByProviderSession 交回「这台机器名下、账号已经镜像着的那些 provider 会话」
// → 它们的 conversation_id。
//
// 判重锚点是 **provider 会话身份**而不是定位符：同一条磁盘会话导第二次时定位符可能
// 变（文件被移动、重命名），而 provider 会话身份是那条会话自己的名字。
// 只认这台机器名下那些：同一份转录可能在两台机器上各导过一次，而候选清单问的是
// 「**这台**机器上这条导过没有」——指向另一台机器那条的话，点「打开」会跳到一条
// 别处的会话。这两个条件都在查询里，不再把账号的全部摘要读回来自己筛。
func (s *sessionImportSvc) importedByProviderSession(
	ctx context.Context, userID int64, fingerprint string,
) (map[string]string, error) {
	out, err := agent_session_repo.Summary().ListImportedProviderSessions(ctx, userID, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("list mirrored sessions: %w", err)
	}
	return out, nil
}

// deviceIssue 把设备级的两种失败翻成清单上的一档。第二个返回值为假表示这不是
// 设备级失败 —— 那种要如实抛出去，不能装成「这台机器答不出」。
//
// Reason 走 i18n 而不是哨兵的 Error()：unavailable 那一档的正文由界面**原样**显示，
// 把一句英文的内部哨兵文本摆到用户面前是这条路上最容易犯的错。
func deviceIssue(ctx context.Context, err error) (ScanIssueView, bool) {
	switch {
	case errors.Is(err, ErrMachineOffline):
		return ScanIssueView{
			Status: StatusUnavailable,
			Reason: i18n.T(ctx, code.SessionImportMachineOffline),
		}, true
	default:
		return ScanIssueView{}, false
	}
}

// failed 记一条日志并给出带业务码的错误。原因只进日志：那台机器给的原文可能带
// 路径，而它没有理由出现在浏览器上。
func failed(ctx context.Context, cause error, deviceID int64) error {
	logger.Ctx(ctx).Error("sessionimport_svc: talking to the machine failed",
		zap.Int64("deviceId", deviceID), zap.Error(cause))
	switch {
	case errors.Is(cause, ErrMachineOffline):
		return i18n.NewError(ctx, code.SessionImportMachineOffline)
	default:
		return i18n.NewError(ctx, code.SessionImportFailed)
	}
}
