// transcript_projection.go 是转录**读侧**的一层投影：把镜像里原样存着的 journal
// 帧削成浏览器真正会用到的那些，再交出去（规格 2026-08-21-transcript-tail-loading
// 决策 4/5/6）。
//
// # 它破了什么，以及为什么只破在这里
//
// 镜像的既定承诺是「存的是原始 journal 帧，不是解析后的转录行——渲染层怎么演进，
// 老数据都解得出来」（决策 4，见 agent_session_entity 与 relaywire.JournaledNotification
// 的注释）。这层投影要求服务端**读得懂载荷**，那条承诺因此有了一个缺口。
//
// 缺口只开在读侧是有意的：`agent_session_notification_journal` 里存的仍是原始帧，投影没了或改了
// 之后，老数据照样解得出来。写入时就削的话，丢掉的就真的没了。
//
// # 谁是真源
//
// 下面那份「丢掉」的清单不是这里定的，它是 `frontend/src/lib/transcriptFrames.ts`
// 里归约器**明确 return 掉**的那些（该文件 :437-441 与 :448-451）。哪天其中某一种
// 有了显示面，那边会先动，这里必须跟着动——否则数据在传输中途就没了，前端改了也
// 看不见。反过来，`context_window_updated` 与 `usage` 虽然也在那段「记而不显」的
// 注释里，却**有**显示面（同文件 :527 的 reduceSessionState 喂 Composer 底栏那条
// 上下文用量），所以它们不在清单里。
package workspace_svc

import (
	"bytes"
	"encoding/json"
)

// methodRuntimeEvent 是带 event.kind 的那个通知方法。别的方法（轮次结束等）投影
// 一个字都不动——它们的载荷这里读不懂，也不需要读懂。
const methodRuntimeEvent = "runtime.event"

// droppedEventKinds 是归约器明确不消费的那些。见包头「谁是真源」。
var droppedEventKinds = map[string]bool{
	"runtime_status":          true,
	"permission_mode_changed": true,
	"steer_consumed":          true,
	"tool_use_end":            true,
	"retry":                   true,
	"subagent_started":        true,
	"subagent_progress":       true,
	"subagent_done":           true,
	"subagent_model":          true,
}

// mergeableEventKinds 是逐块流式、合并起来语义不变的那两种。一条 delta 常常只有
// 几个 token，外面却裹着一整层信封，合并省的就是那些信封。
var mergeableEventKinds = map[string]bool{
	"text_delta":     true,
	"thinking_delta": true,
}

// eventBody 是一帧 runtime.event 的载荷，**整层**都留着：outer 是 params 本身
// （sessionId 等），event 是它里面那个对象。两层都以 RawMessage 存放，合并时除了
// text 之外一个字节都不重写。
type eventBody struct {
	outer map[string]json.RawMessage
	event map[string]json.RawMessage
}

// decodeEventKind 交回这一帧的 event.kind、它的 event 对象，以及「解得动吗」。
// 解不动时交回 ok=false —— 调用方据此**原样放行**，不是丢掉：投影只认得出它认得
// 的那些，丢掉一条解不动的帧，页面上就是一段无声消失的转录。
func decodeEventKind(f TranscriptFrameView) (kind string, body eventBody, ok bool) {
	if f.Method != methodRuntimeEvent || len(f.Params) == 0 {
		return "", eventBody{}, false
	}
	dec := json.NewDecoder(bytes.NewReader(f.Params))
	dec.UseNumber() // 数字原样保留：float64 往返会把大整数写成科学计数法。
	if err := dec.Decode(&body.outer); err != nil {
		return "", eventBody{}, false
	}
	rawEvent, has := body.outer["event"]
	if !has {
		return "", eventBody{}, false
	}
	if err := json.Unmarshal(rawEvent, &body.event); err != nil || body.event == nil {
		return "", eventBody{}, false
	}
	raw, has := body.event["kind"]
	if !has {
		return "", eventBody{}, false
	}
	if err := json.Unmarshal(raw, &kind); err != nil {
		return "", eventBody{}, false
	}
	return kind, body, true
}

// decodeText 取 event.text，没有或解不动时交回空串。
func decodeText(body eventBody) string {
	raw, has := body.event["text"]
	if !has {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

// projectTranscriptFrames 按顺序削一页帧：丢掉 droppedEventKinds，再把**连续**的
// 同 kind delta 合成一条。
//
// 「连续」是在**丢掉之后**判的：被丢的帧本来就不下行，隔在中间不该把一段正文劈成
// 两条。但绝不跨别的 kind 合并——归约器会为工具卡在同一条消息里另起一个块，跨过去
// 就把本该分开的两段正文糊成一段。
//
// 合并出来那条的 seq 取该段**最后**一帧：调用方拿一页里最大的 seq 预置中继游标，
// 取第一帧的话游标会停在这一段中间，随后每条实时帧都被判成跳号（见
// dropCursorAboveHighWater 那条注释记的事故）。
//
// 本函数不改任何计数：这一页的 cursor / oldest_seq / has_before 都是按**原始行**
// 在调用它之前就定好的（规格的 Hard invariant）。
func projectTranscriptFrames(in []TranscriptFrameView) []TranscriptFrameView {
	out := make([]TranscriptFrameView, 0, len(in))
	// 正在攒的那一段 delta：kind、载荷模板（取最后一帧的）、已拼好的文本、最后的 seq。
	var runKind string
	var runBody eventBody
	var runText string
	var runSeq int64
	// 这一段的**发生时刻**取第一帧,与 runSeq 取最后一帧刻意相反:seq 回答「接着从哪
	// 读」,时刻回答「这条消息什么时候开始」。取最后一帧会让一段跑了两分钟的回答显示
	// 成它结束的那一刻。
	var runAt int64

	flush := func() {
		if runKind == "" {
			return
		}
		merged, err := encodeMergedText(runBody, runText)
		if err == nil {
			out = append(out, TranscriptFrameView{
				Seq: runSeq, Method: methodRuntimeEvent, Params: merged, Createtime: runAt,
			})
		}
		runKind, runBody, runText, runSeq, runAt = "", eventBody{}, "", 0, 0
	}

	for _, f := range in {
		kind, body, ok := decodeEventKind(f)
		if !ok {
			// 别的 method、或者载荷解不动：原样放行。它打断合并——认不出的东西
			// 不能假设它不会在渲染上另起一个块。
			flush()
			out = append(out, f)
			continue
		}
		if droppedEventKinds[kind] {
			// 丢掉，且**不**打断正在攒的那一段。
			continue
		}
		if !mergeableEventKinds[kind] {
			flush()
			out = append(out, f)
			continue
		}
		if runKind != "" && runKind != kind {
			flush()
		}
		if runKind == "" {
			runAt = f.Createtime
		}
		runKind = kind
		runBody = body
		runText += decodeText(body)
		runSeq = f.Seq
	}
	flush()
	return out
}

// encodeMergedText 把 body 的 event 原样重编一份，只把 text 换成拼好的那一串。
// event 上的兄弟字段（messageId 等）因此都留着。
func encodeMergedText(body eventBody, text string) (json.RawMessage, error) {
	encoded, err := json.Marshal(text)
	if err != nil {
		return nil, err
	}
	event := make(map[string]json.RawMessage, len(body.event)+1)
	for k, v := range body.event {
		event[k] = v
	}
	event["text"] = encoded
	rawEvent, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	// 外层（sessionId 等）逐字节原样带回：整层都是 RawMessage，只有 event 那一格
	// 换成了重编过的。键序会变成字典序（JSON 的键序不承载语义），值不变。
	outer := make(map[string]json.RawMessage, len(body.outer))
	for k, v := range body.outer {
		outer[k] = v
	}
	outer["event"] = rawEvent
	return json.Marshal(outer)
}
