package workspace_svc

import (
	"context"
	"time"

	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// MarkSessionRead 见 WorkspaceSvc 接口上的说明。
//
// 时刻取服务端的当下（毫秒），与镜像摘要的 updated_at 同一把尺 —— 那一列是发起端
// 上报的活动时刻，也是毫秒。收客户端传来的时刻会让「未读」的判定跟着一台不可信的
// 钟走：钟快的浏览器一打开就把之后几分钟里的新活动一并标成已读。
func (s *workspaceSvc) MarkSessionRead(
	ctx context.Context, userID int64, conversationID string,
) (int64, error) {
	at := time.Now().UnixMilli()
	if err := agent_session_repo.Summary().MarkSummaryRead(
		ctx, userID, conversationID, at,
	); err != nil {
		return 0, err
	}
	// 「读过了」也是一次镜像变更，因此走与镜像收帧同一条信号（mirror_svc.notify 那
	// 一处）。少了它，这件事在同一个账号的各处各说各话：发起的那一屏由应答就地改掉
	// ——索引那一行不再算未读、「未读」chip 上的数当场减一——而外壳侧栏那颗角标只认
	// 这条信号，会一直停在旧值上。账号通道通着的时候前端的 30 秒兜底轮询会让路
	// （accountChannel 的 poll），所以那不是「晚 30 秒」，是**一直不变**，直到别的
	// 对话恰好推来一条镜像变更。别的标签页与别的设备同样如此。
	//
	// 不攒批：这是用户手点出来的低频动作，而镜像那一侧的攒批挡的是一轮对话里逐帧
	// 的成百上千次广播。
	accountchan_svc.BroadcastSignalBestEffort(ctx, userID, accountchan_svc.FrameTypeMirrorChanged)
	return at, nil
}
