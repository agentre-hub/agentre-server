package workspace_svc

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ev 造一条 runtime.event 帧。
func ev(seq int64, kind, text string) TranscriptFrameView {
	params := `{"sessionId":42,"event":{"kind":"` + kind + `"` +
		map[bool]string{true: `,"text":"` + text + `"`, false: ""}[text != ""] + `}}`
	return TranscriptFrameView{Seq: seq, Method: "runtime.event", Params: json.RawMessage(params)}
}

// kindsOf 把投影结果摊成 (seq, kind) 便于断言。
func kindsOf(t *testing.T, frames []TranscriptFrameView) []string {
	t.Helper()
	out := make([]string, 0, len(frames))
	for _, f := range frames {
		var p struct {
			Event struct {
				Kind string `json:"kind"`
			} `json:"event"`
		}
		if err := json.Unmarshal(f.Params, &p); err != nil || p.Event.Kind == "" {
			out = append(out, f.Method)
			continue
		}
		out = append(out, p.Event.Kind)
	}
	return out
}

func textOf(t *testing.T, f TranscriptFrameView) string {
	t.Helper()
	var p struct {
		SessionID json.Number `json:"sessionId"`
		Event     struct {
			Kind string `json:"kind"`
			Text string `json:"text"`
		} `json:"event"`
	}
	require.NoError(t, json.Unmarshal(f.Params, &p))
	assert.Equal(t, "42", p.SessionID.String(), "sessionId 必须原样留着")
	return p.Event.Text
}

// 归约器明确不消费的那 9 种（frontend/src/lib/transcriptFrames.ts:437-441 与
// :448-451）在传输里就不该出现——它们到了浏览器也只是被 return 掉。
func TestProjectTranscriptFrames_DropsKindsTheReducerNeverConsumes(t *testing.T) {
	in := []TranscriptFrameView{
		ev(1, "user_message", "改一下"),
		ev(2, "runtime_status", ""),
		ev(3, "permission_mode_changed", ""),
		ev(4, "steer_consumed", ""),
		ev(5, "tool_use_end", ""),
		ev(6, "retry", ""),
		ev(7, "subagent_started", ""),
		ev(8, "subagent_progress", ""),
		ev(9, "subagent_done", ""),
		ev(10, "subagent_model", ""),
		ev(11, "done", ""),
	}
	out := projectTranscriptFrames(in)
	assert.Equal(t, []string{"user_message", "done"}, kindsOf(t, out))
}

// context_window_updated 与 usage 也在那段「记而不显」的注释里，但它们**有**显示面：
// transcriptFrames.ts:527 的 reduceSessionState 拿它们喂 Composer 底栏那条用量。
// 跟着一起丢的话，底栏的上下文进度条会凭空消失。
func TestProjectTranscriptFrames_KeepsTheKindsThatFeedTheComposerFooter(t *testing.T) {
	in := []TranscriptFrameView{
		ev(1, "context_window_updated", ""),
		ev(2, "usage", ""),
		ev(3, "runtime_status", ""),
	}
	out := projectTranscriptFrames(in)
	assert.Equal(t, []string{"context_window_updated", "usage"}, kindsOf(t, out))
}

// 连续的 text_delta 合成一条，seq 取**最后**那一帧：调用方拿一页里最大的 seq 预置
// 中继游标，取第一帧的话游标会停在这一段中间，随后每条实时帧都被判成跳号。
func TestProjectTranscriptFrames_MergesConsecutiveTextDeltas(t *testing.T) {
	in := []TranscriptFrameView{
		ev(1, "text_delta", "我把"),
		ev(2, "text_delta", "校验"),
		ev(3, "text_delta", "挪走了"),
	}
	out := projectTranscriptFrames(in)
	require.Len(t, out, 1)
	assert.Equal(t, int64(3), out[0].Seq)
	assert.Equal(t, "我把校验挪走了", textOf(t, out[0]))
}

// thinking 与正文是两个块，合并不能把它们并到一起。
func TestProjectTranscriptFrames_DoesNotMergeAcrossKinds(t *testing.T) {
	in := []TranscriptFrameView{
		ev(1, "thinking_delta", "想想"),
		ev(2, "text_delta", "答"),
		ev(3, "thinking_delta", "再想"),
	}
	out := projectTranscriptFrames(in)
	assert.Equal(t, []string{"thinking_delta", "text_delta", "thinking_delta"}, kindsOf(t, out))
}

// **不跨 tool_use_start 合并**：归约器会为工具卡在同一条消息里另起一个块，跨过去
// 合并就把本该分开的两段正文糊成一段。
func TestProjectTranscriptFrames_DoesNotMergeAcrossABlockBoundary(t *testing.T) {
	in := []TranscriptFrameView{
		ev(1, "text_delta", "先读文件"),
		ev(2, "tool_use_start", ""),
		ev(3, "text_delta", "读完了"),
	}
	out := projectTranscriptFrames(in)
	require.Len(t, out, 3)
	assert.Equal(t, []string{"text_delta", "tool_use_start", "text_delta"}, kindsOf(t, out))
	assert.Equal(t, "先读文件", textOf(t, out[0]))
	assert.Equal(t, "读完了", textOf(t, out[2]))
}

// 但**跨被丢掉的帧**要照样合并：那些帧本来就不下行，隔在中间不该把一段正文劈成两条。
func TestProjectTranscriptFrames_MergesAcrossDroppedFrames(t *testing.T) {
	in := []TranscriptFrameView{
		ev(1, "text_delta", "前"),
		ev(2, "runtime_status", ""),
		ev(3, "subagent_progress", ""),
		ev(4, "text_delta", "后"),
	}
	out := projectTranscriptFrames(in)
	require.Len(t, out, 1)
	assert.Equal(t, int64(4), out[0].Seq)
	assert.Equal(t, "前后", textOf(t, out[0]))
}

// 别的 method（轮次结束等）不是 runtime.event，投影一个字都不动它。
func TestProjectTranscriptFrames_LeavesOtherMethodsVerbatim(t *testing.T) {
	raw := json.RawMessage(`{"sessionId":42,"result":{"ok":true}}`)
	in := []TranscriptFrameView{
		ev(1, "text_delta", "a"),
		{Seq: 2, Method: "runtime.runResultDone", Params: raw},
	}
	out := projectTranscriptFrames(in)
	require.Len(t, out, 2)
	assert.Equal(t, "runtime.runResultDone", out[1].Method)
	assert.JSONEq(t, string(raw), string(out[1].Params))
}

// 载荷解不动时**原样放行**，不丢：投影只认得出它认得的那些，认不出的一律当成
// 「可能有用」——丢掉一条解不动的帧，页面上就是一段无声消失的转录。
func TestProjectTranscriptFrames_PassesThroughUndecodableParams(t *testing.T) {
	broken := json.RawMessage(`{"event":`)
	in := []TranscriptFrameView{{Seq: 1, Method: "runtime.event", Params: broken}}
	out := projectTranscriptFrames(in)
	require.Len(t, out, 1)
	assert.Equal(t, string(broken), string(out[0].Params))
}

// 合并出来的那条必须仍是合法 JSON，且把原帧 event 上的其它字段留着。
func TestProjectTranscriptFrames_MergedFrameKeepsSiblingFields(t *testing.T) {
	in := []TranscriptFrameView{
		{Seq: 1, Method: "runtime.event", Params: json.RawMessage(
			`{"sessionId":42,"event":{"kind":"text_delta","text":"a","messageId":7}}`)},
		{Seq: 2, Method: "runtime.event", Params: json.RawMessage(
			`{"sessionId":42,"event":{"kind":"text_delta","text":"b","messageId":7}}`)},
	}
	out := projectTranscriptFrames(in)
	require.Len(t, out, 1)
	assert.Equal(t, "ab", textOf(t, out[0]))
	assert.Contains(t, string(out[0].Params), `"messageId":7`)
	assert.True(t, json.Valid(out[0].Params))
}

// 空进空出，不返回 nil 之外的意外形状。
func TestProjectTranscriptFrames_EmptyIn(t *testing.T) {
	assert.Empty(t, projectTranscriptFrames(nil))
}

// 长文本合并之后不该出现转义走样（中文、引号、换行都原样回来）。
func TestProjectTranscriptFrames_MergedTextSurvivesEscaping(t *testing.T) {
	in := []TranscriptFrameView{
		{Seq: 1, Method: "runtime.event", Params: json.RawMessage(
			`{"sessionId":42,"event":{"kind":"text_delta","text":"他说\"好\"\n"}}`)},
		{Seq: 2, Method: "runtime.event", Params: json.RawMessage(
			`{"sessionId":42,"event":{"kind":"text_delta","text":"然后走了"}}`)},
	}
	out := projectTranscriptFrames(in)
	require.Len(t, out, 1)
	assert.Equal(t, "他说\"好\"\n然后走了", textOf(t, out[0]))
	assert.False(t, strings.Contains(textOf(t, out[0]), `\n`), "换行不该被二次转义")
}

// 合并出来的那一段正文,时刻取这一段**第一**帧 —— 与 seq 取最后一帧刻意相反。
//
// 两个字段回答的不是同一个问题:seq 是「调用方接着从哪读」(取第一帧会让随后每条实时
// 帧都被判成跳号,见 dropCursorAboveHighWater 那条注释记的事故),时刻是「这条消息什么
// 时候开始的」(取最后一帧会让一段跑了两分钟的回答显示成它结束的那一刻)。
func TestProjectTranscriptFrames_MergedRunTakesTheFirstFramesCreatetime(t *testing.T) {
	first := ev(1, "text_delta", "我把")
	first.Createtime = 1_700_000_000_111
	middle := ev(2, "text_delta", "校验")
	middle.Createtime = 1_700_000_004_222
	last := ev(3, "text_delta", "挪走了")
	last.Createtime = 1_700_000_009_333

	out := projectTranscriptFrames([]TranscriptFrameView{first, middle, last})

	require.Len(t, out, 1)
	assert.Equal(t, int64(3), out[0].Seq, "seq 仍取最后一帧")
	assert.Equal(t, int64(1_700_000_000_111), out[0].Createtime)
}

// 被丢掉的那些 kind 不打断合并,自然也不该把时刻带偏:一段的起点仍是它第一条**留下来**
// 的帧。
func TestProjectTranscriptFrames_DroppedFramesDoNotBecomeTheRunsStart(t *testing.T) {
	dropped := ev(1, "runtime_status", "")
	dropped.Createtime = 1_600_000_000_000
	first := ev(2, "text_delta", "答")
	first.Createtime = 1_700_000_000_111

	out := projectTranscriptFrames([]TranscriptFrameView{dropped, first})

	require.Len(t, out, 1)
	assert.Equal(t, int64(1_700_000_000_111), out[0].Createtime)
}
