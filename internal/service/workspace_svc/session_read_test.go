package workspace_svc

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo/mock_agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

// setupSessionReadTest 只装配「记已读」这条路要用到的那一个仓储与账号通道替身。
func setupSessionReadTest(t *testing.T) (
	context.Context, *mock_agent_session_repo.MockSummaryRepo, *stubAccountChan, *workspaceSvc,
) {
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	mSummary := mock_agent_session_repo.NewMockSummaryRepo(ctrl)
	agent_session_repo.RegisterSummary(mSummary)
	return context.Background(), mSummary, registerAccountChanStub(t), New()
}

// 记下已读之后要向账号广播一条 mirror_changed。
//
// 少了它，「已读」这件事在同一个账号的各处各说各话：索引那一行与「未读」chip 由
// 应答就地改掉、立刻变，而外壳侧栏那颗角标只认这条信号——它会一直停在旧值上，
// 直到别的对话恰好推来一条镜像变更（账号通道通着的时候 30 秒兜底轮询让路，
// 见前端 accountChannel 的 poll）。别的标签页与别的设备同样收不到。
func TestMarkSessionRead_GivenWriteSucceeds_ThenBroadcastsMirrorChanged(t *testing.T) {
	ctx, mSummary, chanStub, svc := setupSessionReadTest(t)
	mSummary.EXPECT().MarkSummaryRead(ctx, int64(7), "conv-9", gomock.Any()).Return(nil)

	at, err := svc.MarkSessionRead(ctx, 7, "conv-9")
	require.NoError(t, err)
	assert.Positive(t, at)
	assert.Equal(t, []accountChanCall{
		{accountID: 7, frameType: accountchan_svc.FrameTypeMirrorChanged},
	}, chanStub.recordedCalls())
}

// 写失败时不发信号：没有变更可广播，发一条只会让在线的各端白拉一遍。
func TestMarkSessionRead_GivenWriteFails_ThenNoBroadcast(t *testing.T) {
	ctx, mSummary, chanStub, svc := setupSessionReadTest(t)
	mSummary.EXPECT().MarkSummaryRead(ctx, int64(7), "conv-9", gomock.Any()).
		Return(errors.New("write failed"))

	_, err := svc.MarkSessionRead(ctx, 7, "conv-9")
	require.Error(t, err)
	assert.Empty(t, chanStub.recordedCalls())
}
