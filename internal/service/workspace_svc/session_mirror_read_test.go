package workspace_svc

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/proto"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/agent_session_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo/mock_agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
)

// setupMirrorReadTest 装配 SessionIndex / Transcript 需要的三个仓储 mock，
// 与 setupWorkspaceTest 分开：那批既有测试不关心镜像，混进去徒增无关的 mock 期望。
func setupMirrorReadTest(t *testing.T) (
	context.Context, *mock_agent_session_repo.MockSummaryRepo, *mock_agent_session_repo.MockJournalFrameRepo,
	*mock_sync_repo.MockSyncObjectRepo, *workspaceSvc,
) {
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	mSummary := mock_agent_session_repo.NewMockSummaryRepo(ctrl)
	mFrame := mock_agent_session_repo.NewMockJournalFrameRepo(ctrl)
	mObj := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	agent_session_repo.RegisterSummary(mSummary)
	agent_session_repo.RegisterJournalFrame(mFrame)
	sync_repo.RegisterSyncObject(mObj)
	return context.Background(), mSummary, mFrame, mObj, New()
}

// 一页帧按 seq 升序原样带出，Cursor 推进到这一页最后一条的 seq。
func TestTranscript_GivenFramesAfterCursor_ReturnsInOrderAndAdvancesCursor(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	mFrame.EXPECT().ListFramesBySeq(ctx, int64(7), "conv-9", int64(5), defaultTranscriptLimit+1).
		Return([]*agent_session_entity.JournalFrame{
			frame(6, "text_delta", "hi"),
			frame(7, "text_delta", "there"),
		}, nil)

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", AfterSeq: 5,
	})
	require.NoError(t, err)
	require.Len(t, page.Frames, 2)
	assert.EqualValues(t, 6, page.Frames[0].Seq)
	assert.Equal(t, "runtime.event", page.Frames[0].Method)
	assert.JSONEq(t, `{"conversationId":"conv-9","seq":6,"event":{"kind":"text_delta","text":"hi"}}`, string(page.Frames[0].Params))
	assert.EqualValues(t, 7, page.Frames[1].Seq)
	assert.EqualValues(t, 7, page.Cursor)
	assert.False(t, page.HasMore)
}

// 空页（没有比游标更新的帧）上 Cursor 原样保持在调用方送来的位置，不回退到 0——
// 否则调用方会把整段日志当成需要重放。
func TestTranscript_GivenNoNewFrames_ThenCursorUnchanged(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	mFrame.EXPECT().ListFramesBySeq(ctx, int64(7), "conv-9", int64(9), gomock.Any()).
		Return(nil, nil)

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", AfterSeq: 9,
	})
	require.NoError(t, err)
	assert.Empty(t, page.Frames)
	assert.EqualValues(t, 9, page.Cursor)
	assert.False(t, page.HasMore)
}

// 多请求一条（limit+1）用来判定 HasMore：拿到比 limit 多一条就说明后面还有，裁掉
// 那一条多余的，不能把它算进这一页。
func TestTranscript_GivenMoreRowsThanLimit_ThenHasMoreTrueAndExtraRowTrimmed(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	mFrame.EXPECT().ListFramesBySeq(ctx, int64(7), "conv-9", int64(0), 3).
		Return([]*agent_session_entity.JournalFrame{
			frame(1, "text_delta", "a"), frame(2, "text_delta", "b"), frame(3, "text_delta", "c"),
		}, nil)

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", Limit: 2,
	})
	require.NoError(t, err)
	require.Len(t, page.Frames, 2)
	assert.EqualValues(t, 2, page.Cursor)
	assert.True(t, page.HasMore)
}

// Limit<=0 走服务端默认档。
func TestTranscript_GivenZeroLimit_ThenDefaultApplied(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	mFrame.EXPECT().ListFramesBySeq(ctx, int64(7), "conv-9", int64(0), defaultTranscriptLimit+1).
		Return(nil, nil)

	_, err := svc.Transcript(ctx, TranscriptQuery{UserID: 7, ConversationID: "conv-9"})
	require.NoError(t, err)
}

// 调用方给的 Limit 超过服务端上限时被夹住，不能拿一次请求把整段日志都翻出来。
func TestTranscript_GivenLimitAboveMax_ThenClamped(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	mFrame.EXPECT().ListFramesBySeq(ctx, int64(7), "conv-9", int64(0), maxTranscriptLimit+1).
		Return(nil, nil)

	_, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", Limit: 999999,
	})
	require.NoError(t, err)
}

// ─── 反向读：一页的量按预算定（规格 2026-08-21-transcript-tail-loading 决策 7）──

// frame 造一条镜像行。
func frame(seq int64, kind, text string) *agent_session_entity.JournalFrame {
	event := &agentrewire.RuntimeEventNotification{ConversationId: "conv-9", Seq: seq}
	switch kind {
	case "user_message":
		event.Event = &agentrewire.RuntimeEventNotification_UserMessage{UserMessage: &agentrewire.UserMessage{Text: text}}
	case "text_delta":
		event.Event = &agentrewire.RuntimeEventNotification_TextDelta{TextDelta: &agentrewire.TextDelta{Text: text}}
	case "runtime_status":
		event.Event = &agentrewire.RuntimeEventNotification_RuntimeStatus{RuntimeStatus: &agentrewire.RuntimeStatus{Status: text}}
	case "tool_use_start":
		event.Event = &agentrewire.RuntimeEventNotification_ToolCall{ToolCall: &agentrewire.ToolCall{Name: text}}
	default:
		panic("unknown test event kind: " + kind)
	}
	payload, err := proto.Marshal(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: event}})
	if err != nil {
		panic(err)
	}
	return &agent_session_entity.JournalFrame{Seq: seq, Payload: payload}
}

// turn 造一轮：user_message 起头，后面两条 text_delta。交回的是**升序**。
func turn(start int64) []*agent_session_entity.JournalFrame {
	return []*agent_session_entity.JournalFrame{
		frame(start, "user_message", "问"),
		frame(start+1, "text_delta", "答"),
		frame(start+2, "text_delta", "完"),
	}
}

// newestFirst 把若干轮拍平成仓储那一侧的顺序（seq 降序）。
func newestFirst(turns ...[]*agent_session_entity.JournalFrame) []*agent_session_entity.JournalFrame {
	var asc []*agent_session_entity.JournalFrame
	for _, t := range turns {
		asc = append(asc, t...)
	}
	out := make([]*agent_session_entity.JournalFrame, 0, len(asc))
	for i := len(asc) - 1; i >= 0; i-- {
		out = append(out, asc[i])
	}
	return out
}

func seqsOf(frames []TranscriptFrameView) []int64 {
	out := make([]int64, 0, len(frames))
	for _, f := range frames {
		out = append(out, f.Seq)
	}
	return out
}

// 满 N 轮就停：交回的是最后 3 轮，按 seq 升序，Cursor 是窗口里**最新**那条原始行。
func TestTranscriptTail_StopsAtTurnBudget(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	mFrame.EXPECT().ListFramesBefore(ctx, int64(7), "conv-9", int64(0), tailBatchRows).
		Return(newestFirst(turn(1), turn(4), turn(7), turn(10)), nil)

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", Backward: true,
	})
	require.NoError(t, err)
	// 每轮投影成两条：user_message + 合并后的 text_delta（seq 取该段最后一帧）。
	assert.Equal(t, []int64{4, 6, 7, 9, 10, 12}, seqsOf(page.Frames))
	assert.EqualValues(t, 12, page.Cursor, "Cursor 是窗口里最新那条原始行")
	assert.EqualValues(t, 4, page.OldestSeq)
	assert.True(t, page.HasBefore)
}

// 一轮自己就撑爆字节预算时**整轮给完**，不劈成两半；下一页才回到轮次预算。
func TestTranscriptTail_NeverSplitsATurnAtTheByteBudget(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	huge := frame(11, "text_delta", strings.Repeat("x", tailBytes+1))
	rows := append([]*agent_session_entity.JournalFrame{huge, frame(10, "user_message", "问")},
		newestFirst(turn(1), turn(4), turn(7))...)
	mFrame.EXPECT().ListFramesBefore(ctx, int64(7), "conv-9", int64(0), tailBatchRows).
		Return(rows, nil)

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", Backward: true,
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{10, 11}, seqsOf(page.Frames), "只给这一轮，且这一轮是完整的")
	assert.EqualValues(t, 11, page.Cursor)
	assert.EqualValues(t, 10, page.OldestSeq)
	assert.True(t, page.HasBefore)
}

// 整条对话都在预算之内：一次给完，has_before 为假——短对话因此根本不进分页。
func TestTranscriptTail_WholeConversationFitsInOnePage(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	mFrame.EXPECT().ListFramesBefore(ctx, int64(7), "conv-9", int64(0), tailBatchRows).
		Return(newestFirst(turn(1), turn(4)), nil)

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", Backward: true,
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{1, 3, 4, 6}, seqsOf(page.Frames))
	assert.False(t, page.HasBefore)
	assert.EqualValues(t, 6, page.Cursor)
	assert.EqualValues(t, 1, page.OldestSeq)
}

// **四个数按原始行算，不按投影后剩几条**（规格的 Hard invariant）：窗口最新那条
// 被投影丢掉时，Cursor 仍然是它的 seq。取投影后的最大 seq 会让调用方预置的中继
// 游标停在它前面，此后每条实时帧都被判成跳号丢光。
func TestTranscriptTail_CursorCountsRawRowsNotProjectedOnes(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	rows := append(
		[]*agent_session_entity.JournalFrame{frame(20, "runtime_status", "")},
		newestFirst(turn(1))...,
	)
	mFrame.EXPECT().ListFramesBefore(ctx, int64(7), "conv-9", int64(0), tailBatchRows).
		Return(rows, nil)

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", Backward: true,
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{1, 3}, seqsOf(page.Frames), "被丢掉的那条不下行")
	assert.EqualValues(t, 20, page.Cursor, "但它照样占掉窗口的上界")
	assert.EqualValues(t, 1, page.OldestSeq)
}

// 一条轮次边界都没有时由行硬顶收住，不会一路读到对话开头。
func TestTranscriptTail_RowCapStopsAConversationWithoutTurnBoundaries(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	all := make([]*agent_session_entity.JournalFrame, 0, tailRowCap+tailBatchRows)
	for i := tailRowCap + tailBatchRows; i >= 1; i-- {
		all = append(all, frame(int64(i), "tool_use_start", ""))
	}
	mFrame.EXPECT().ListFramesBefore(ctx, int64(7), "conv-9", gomock.Any(), tailBatchRows).
		DoAndReturn(func(_ context.Context, _ int64, _ string, before int64, limit int,
		) ([]*agent_session_entity.JournalFrame, error) {
			out := make([]*agent_session_entity.JournalFrame, 0, limit)
			for _, r := range all {
				if before > 0 && r.Seq >= before {
					continue
				}
				if len(out) == limit {
					break
				}
				out = append(out, r)
			}
			return out, nil
		}).AnyTimes()

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", Backward: true,
	})
	require.NoError(t, err)
	assert.Len(t, page.Frames, tailRowCap)
	assert.True(t, page.HasBefore)
}

// 一帧都没有：空页，也没有更早的。
func TestTranscriptTail_Empty(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	mFrame.EXPECT().ListFramesBefore(ctx, int64(7), "conv-9", int64(0), tailBatchRows).
		Return(nil, nil)

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", Backward: true,
	})
	require.NoError(t, err)
	assert.Empty(t, page.Frames)
	assert.False(t, page.HasBefore)
	assert.Zero(t, page.Cursor)
}

// 往上翻：上界是调用方手上最老那条的 seq，排他。
func TestTranscriptTail_BeforeSeqIsExclusive(t *testing.T) {
	ctx, _, mFrame, _, svc := setupMirrorReadTest(t)
	mFrame.EXPECT().ListFramesBefore(ctx, int64(7), "conv-9", int64(4), tailBatchRows).
		Return(newestFirst(turn(1)), nil)

	page, err := svc.Transcript(ctx, TranscriptQuery{
		UserID: 7, ConversationID: "conv-9", Backward: true, BeforeSeq: 4,
	})
	require.NoError(t, err)
	assert.Equal(t, []int64{1, 3}, seqsOf(page.Frames))
	assert.False(t, page.HasBefore)
}
