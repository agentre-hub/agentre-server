package workspace_svc

import (
	"context"
	"time"

	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
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
	return at, nil
}
