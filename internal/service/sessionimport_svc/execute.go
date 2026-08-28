package sessionimport_svc

import (
	"context"
	"strconv"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

// Import 让握着那份转录的机器执行一次导入，然后把导出来的会话收进账号。
//
// # 会话归那台机器
//
// 请求里**点名发起端**（PeerFingerprint = 那台机器自己的指纹）。省略的话，执行端
// 会把这条会话记在**调用方**那一端名下，而这条连接的调用方是 server 镜像的合成
// 指纹——一个每个 server 进程都不同的随机值。那样导出来的会话此后没有任何一台机器
// 认领得了它。点名 origin 是账号级能力，这条连接正是账号鉴权的。
//
// # 收进账号是第二步，不是可选项
//
// 镜像的范围**就是**账号保存过的那些对话（隐私边界）。不保存的话，会话在机器上真的
// 建起来了、轮次也真的落进了它的通知日志，而账号这一侧一行都没有——用户点完「导入」
// 之后什么也不会出现。
func (s *sessionImportSvc) Import(ctx context.Context, in ImportInput) (*ImportResultView, error) {
	if in.Backend == "" || in.Locator == "" || in.SessionID <= 0 {
		// 会话号由浏览器铸（与 runtime.run 同一条规矩）。0 号在那台机器上建不出来，
		// 拨过去只会被拒——就地拒掉，不浪费一次握手。
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	device, err := s.machine(ctx, in.UserID, in.DeviceID)
	if err != nil {
		return nil, err
	}

	var executed *agentrewire.TranscriptImportExecuteResponse
	if callErr := s.machines.WithPeer(ctx, in.UserID, device.Fingerprint,
		func(ctx context.Context, peer TranscriptImportPeer) error {
			response, err := peer.TranscriptImportExecute(ctx, &agentrewire.TranscriptImportExecuteRequest{
				Backend: in.Backend, Locator: in.Locator, SessionId: in.SessionID,
				AgentSyncId: in.AgentSyncID, PeerFingerprint: device.Fingerprint,
			})
			executed = response
			return err
		}); callErr != nil {
		return nil, failed(ctx, callErr, in.DeviceID)
	}

	// 会话号取应答里那个：已经导过时它是**库里那条**，未必等于这次铸的号。
	sessionID := strconv.FormatInt(executed.GetSessionId(), 10)
	if err := s.saved.Save(ctx, SessionRef{
		UserID: in.UserID, MachineFingerprint: device.Fingerprint,
		PeerFingerprint: device.Fingerprint, SessionID: sessionID,
	}); err != nil {
		// 不吞：报成功会让用户对着一条永远不出现在列表里的会话等下去。重试是安全的
		// ——那台机器按 provider 会话身份判重，第二次只会指回同一条。
		logger.Ctx(ctx).Error("sessionimport_svc.Import: imported but not saved into the account",
			zap.Int64("userId", in.UserID), zap.Int64("deviceId", in.DeviceID),
			zap.String("sessionId", sessionID), zap.Error(err))
		return nil, i18n.NewError(ctx, code.SessionImportFailed)
	}

	logger.Ctx(ctx).Info("sessionimport_svc.Import: transcript imported on its machine",
		zap.Int64("userId", in.UserID), zap.Int64("deviceId", in.DeviceID),
		zap.String("backendType", in.Backend), zap.String("sessionId", sessionID),
		zap.Int("turns", int(executed.GetTurns())),
		zap.Bool("alreadyImported", executed.GetAlreadyImported()))
	return &ImportResultView{
		SessionID: sessionID, PeerFingerprint: device.Fingerprint,
		ProviderSessionID: executed.GetProviderSessionId(), Title: executed.GetTitle(),
		Cwd: executed.GetCwd(), ImportedTurns: int(executed.GetTurns()),
		AlreadyImported: executed.GetAlreadyImported(),
	}, nil
}
