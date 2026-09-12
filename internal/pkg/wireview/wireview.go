// Package wireview 把一条 typed Protobuf 通知投影成浏览器读得懂的 JSON：方法名 +
// params 正文。它是**跨层的横切件**（internal/pkg 的定位），因为两条互不相干的
// 路径要的是同一份投影，而两份手抄的 27 分支事件表一定会漂开：
//
//   - 账号镜像（mirror_svc 写、workspace_svc 读）：对端发来的帧按这份形状落库，
//     详情页读出来直接透传给浏览器（2026-09-07-journal-payload-json.md）；
//   - 导入本地会话的预览（sessionimport_svc）：从那台机器上取回的转录轮次里的
//     事件，按同一条形状投影，于是预览与真实转录走的是同一个渲染链。
//
// 投影的判据不在这里定：它是 frontend/src/lib/transcriptFrames.ts 那个归约器认得的
// 事件词表，本包只负责把 typed 事件如实摊成那份词表里的 {kind, ...}。
//
// 判别值本身也不在这里定了：它写在 .proto 的 (agentre.wire.event_kind) 字段选项上，
// 由 pkg/wire/eventkind 从 descriptor 读出来。本包从前有一份 27 分支的手抄 switch
// —— 分支名与判别值没有可推导的规则（tool_call → tool_use_start），抄错编译器发现
// 不了，页面上表现为那一类卡片整块不渲染。
package wireview

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/eventkind"
)

// rawBytesEscapeKey 是「这一格是编码过的原始字节，不是它看起来的那个字符串」的标记。
//
// 取 `$` 前缀是因为它不会与 wire 的任何字段名相撞：那些名字由 protoreflect 的
// JSONName() 产出，一律是 lowerCamelCase。
const rawBytesEscapeKey = "$b64"

// Notification 把一条 typed 通知投影成 (方法名, params)。认不出的通知报错而不是
// 静默丢弃——丢掉一帧，页面上就是一段无声消失的转录。
func Notification(notification *agentrewire.RpcNotification) (string, json.RawMessage, error) {
	if notification == nil {
		return "", nil, errors.New("wireview: nil typed notification")
	}
	var (
		method string
		view   any
	)
	switch payload := notification.GetPayload().(type) {
	case *agentrewire.RpcNotification_RuntimeEvent:
		method = "runtime.event"
		value, err := RuntimeEvent(payload.RuntimeEvent)
		if err != nil {
			return "", nil, err
		}
		view = value
	case *agentrewire.RpcNotification_AutonomousTurnEvent:
		method = "runtime.autonomousTurn.event"
		value, err := RuntimeEvent(payload.AutonomousTurnEvent)
		if err != nil {
			return "", nil, err
		}
		view = value
	case *agentrewire.RpcNotification_RunResultDone:
		method = "runtime.runResultDone"
		view = doneView(payload.RunResultDone)
	case *agentrewire.RpcNotification_AutonomousTurnDone:
		method = "runtime.autonomousTurn.done"
		view = doneView(payload.AutonomousTurnDone)
	case *agentrewire.RpcNotification_AutonomousTurnStarted:
		method = "runtime.autonomousTurn.started"
		value := payload.AutonomousTurnStarted
		out := map[string]any{"conversationId": value.GetConversationId()}
		putNonzero(out, "seq", value.GetSeq())
		putNonempty(out, "trigger", value.GetTrigger())
		putNonzero(out, "turnToken", value.GetTurnToken())
		view = out
	case *agentrewire.RpcNotification_TurnStarted:
		// 客户端要的那一轮开始了。它只带会话身份与 seq ——「开始了」本身就是全部
		// 内容，用户那句话紧接着作为本轮第一条事件到达。
		method = "runtime.turnStarted"
		value := payload.TurnStarted
		out := map[string]any{"conversationId": value.GetConversationId()}
		putNonzero(out, "seq", value.GetSeq())
		view = out
	default:
		return "", nil, fmt.Errorf("wireview: unsupported typed notification %T", payload)
	}
	encoded, err := json.Marshal(view)
	if err != nil {
		return "", nil, fmt.Errorf("wireview: encode notification view: %w", err)
	}
	return method, encoded, nil
}

// RuntimeEvent 把一条 typed runtime 事件摊成 params 正文（{conversationId, seq?, event}）。
func RuntimeEvent(frame *agentrewire.RuntimeEventNotification) (map[string]any, error) {
	if frame == nil || frame.GetEvent() == nil {
		return nil, errors.New("wireview: runtime event has no typed event")
	}
	kind, message, ok := eventkind.Of(frame)
	if !ok {
		return nil, fmt.Errorf("wireview: unsupported runtime event %T", frame.GetEvent())
	}
	event := messageMap(message.ProtoReflect())
	event["kind"] = kind
	switch value := frame.GetEvent().(type) {
	case *agentrewire.RuntimeEventNotification_TextDelta:
		event["text"] = value.TextDelta.GetText()
	case *agentrewire.RuntimeEventNotification_ThinkingDelta:
		event["text"] = value.ThinkingDelta.GetText()
	case *agentrewire.RuntimeEventNotification_ContextWindowUpdated:
		event["tokens"] = value.ContextWindowUpdated.GetTokens()
	case *agentrewire.RuntimeEventNotification_ToolCall:
		putRawJSON(event, "input", value.ToolCall.GetInput())
		putRawJSON(event, "canonical", value.ToolCall.GetCanonical())
	case *agentrewire.RuntimeEventNotification_ToolResult:
		putRawJSON(event, "meta", value.ToolResult.GetMeta())
	case *agentrewire.RuntimeEventNotification_ToolPermissionRequest:
		putRawJSON(event, "input", value.ToolPermissionRequest.GetInput())
	case *agentrewire.RuntimeEventNotification_UnrecognizedBlock:
		// data 是块的原始 JSON 字节:不还原的话它会走 bytes 的默认投射变成
		// base64,而这条事件存在的全部意义就是把原件原样交出去。
		putRawJSON(event, "data", value.UnrecognizedBlock.GetData())
	case *agentrewire.RuntimeEventNotification_PlanUpdated:
		event = map[string]any{"kind": kind, "plan": messageMap(value.PlanUpdated.ProtoReflect())}
	case *agentrewire.RuntimeEventNotification_UsageUpdate:
		if value.UsageUpdate.GetUsage() != nil {
			event["usage"] = usageView(value.UsageUpdate.GetUsage())
		}
	}
	out := map[string]any{"conversationId": frame.GetConversationId(), "event": event}
	putNonzero(out, "seq", frame.GetSeq())
	return out, nil
}

func doneView(value *agentrewire.RunResultDoneNotification) map[string]any {
	out := map[string]any{"conversationId": value.GetConversationId()}
	putNonzero(out, "seq", value.GetSeq())
	putNonempty(out, "providerSessionId", value.GetProviderSessionId())
	putNonempty(out, "userAnchor", value.GetUserAnchor())
	putNonempty(out, "model", value.GetModel())
	putNonzero(out, "contextWindow", value.GetContextWindow())
	putNonzero(out, "turnToken", value.GetTurnToken())
	putNonempty(out, "stopErrMsg", value.GetStopErrorMessage())
	putNonzero(out, "stopErrCode", value.GetStopErrorCode())
	// 本轮计时。转录里那一行 meta（模型 · 耗时 · 首字 · 速率）在镜像这条路径上
	// 只靠这一帧 —— usage 帧上没有模型，计时更是只有 agentred 量得出来。
	putNonzero(out, "durationMs", value.GetDurationMs())
	putNonzero(out, "firstTokenMs", value.GetFirstTokenMs())
	putNonzero(out, "tokensPerSec", value.GetTokensPerSec())
	if value.GetUsage() != nil {
		out["usage"] = usageView(value.GetUsage())
	}
	return out
}

func usageView(usage *agentrewire.Usage) map[string]any {
	return map[string]any{
		"promptTokens": usage.GetPromptTokens(), "completionTokens": usage.GetCompletionTokens(),
		"reasoningTokens": usage.GetReasoningTokens(), "cachedTokens": usage.GetCachedTokens(),
		"cacheCreationTokens": usage.GetCacheCreationTokens(), "totalTokens": usage.GetTotalTokens(),
	}
}

func putNonempty(out map[string]any, key, value string) {
	if value != "" {
		out[key] = value
	}
}

func putNonzero[T comparable](out map[string]any, key string, value T) {
	var zero T
	if value != zero {
		out[key] = value
	}
}

func putRawJSON(out map[string]any, key string, data []byte) {
	if len(data) == 0 {
		delete(out, key)
		return
	}
	// 合法 JSON 且是合法 UTF-8:**逐字节**原样嵌进视图,不解成 any 再重编。
	//
	// 重编那条路经 float64 中转:19 位的整数(纳秒时刻、雪花 ID、大文件偏移)会被改成
	// 另一个值并写成科学计数法,`1.0` 会变成 `1`。这份视图就是镜像日志库里的那一行
	// (2026-09-07-journal-payload-json.md),原件不再另存一份 —— 改掉的位再也找不
	// 回来。transcript_projection.go 的 decodeEventKind 早就为同一件事开了 UseNumber。
	//
	// utf8.Valid 这一半守的是落库那一列:json 列只收 utf8mb4。encoding/json 的扫描器
	// 不校验 UTF-8,合法 JSON 里照样能夹着非法字节;放行会让整批写入失败、这条对话的
	// 镜像卡在原地重试,而解成 any 再重编则会把它静默改写成 U+FFFD。两条都不走,
	// 交给下面的 $b64 —— 字节原样留着,列拿到的仍是合法 utf8mb4。
	if utf8.Valid(data) && json.Unmarshal(data, new(any)) == nil {
		out[key] = json.RawMessage(data)
		return
	}
	// 解不动:装进 {"$b64": ...}。不这么做的话这一格保留的是 messageMap 按
	// BytesKind 投射出的**裸 base64 字符串**,而载荷本来就是 JSON 字符串时投影出的
	// 也是一个字符串 —— 两者在视图里一模一样,消费方分不出手里这串是原文还是编码。
	// 包装消除的是这个歧义;字节两种走法都不丢。
	out[key] = map[string]string{rawBytesEscapeKey: base64.StdEncoding.EncodeToString(data)}
}

func messageMap(message protoreflect.Message) map[string]any {
	out := make(map[string]any)
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		out[field.JSONName()] = reflectValue(field, value)
		return true
	})
	return out
}

func reflectValue(field protoreflect.FieldDescriptor, value protoreflect.Value) any {
	if field.IsList() {
		list := value.List()
		out := make([]any, 0, list.Len())
		for i := 0; i < list.Len(); i++ {
			out = append(out, singularValue(field, list.Get(i)))
		}
		return out
	}
	if field.IsMap() {
		out := make(map[string]any)
		value.Map().Range(func(key protoreflect.MapKey, item protoreflect.Value) bool {
			out[key.String()] = singularValue(field.MapValue(), item)
			return true
		})
		return out
	}
	return singularValue(field, value)
}

func singularValue(field protoreflect.FieldDescriptor, value protoreflect.Value) any {
	switch field.Kind() {
	case protoreflect.MessageKind, protoreflect.GroupKind:
		return messageMap(value.Message())
	case protoreflect.BytesKind:
		return base64.StdEncoding.EncodeToString(value.Bytes())
	case protoreflect.EnumKind:
		return string(field.Enum().Values().ByNumber(value.Enum()).Name())
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		return int32(value.Int())
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		return value.Int()
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		return uint32(value.Uint())
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		return value.Uint()
	case protoreflect.FloatKind:
		return float32(value.Float())
	case protoreflect.DoubleKind:
		return value.Float()
	case protoreflect.BoolKind:
		return value.Bool()
	case protoreflect.StringKind:
		return value.String()
	default:
		return value.Interface()
	}
}

// ── 镜像日志的落库形态 ────────────────────────────────────────────────────
//
// 一行存一个 JSON 对象，形如 {"method": ..., "params": {...}}：库里那一行因此能被
// 一条 SQL 直接读懂，检索走 JSON_EXTRACT 定位到具体路径
// （规格 docs/specs/2026-09-07-journal-payload-json.md）。

// storedFrameProtoKey 是整帧逃生路的键：这一侧投影不出来的帧，把原始 protobuf 字节
// 原样存在这里。
//
// 它存在是因为「存的是原始帧」那条承诺（transcript_projection.go 包头记的决策 4）：
// 缺口只许开在读侧，写入时削掉的就真的没了。投影不出来时拒绝这一帧会让该对话的镜像
// 卡在原地反复重试，丢弃它则直接违反那条承诺 —— 逃生路两头都不占。
const storedFrameProtoKey = "$proto"

// storedFrame 是落库那一行的形状。两个键互斥：正常帧有 method/params，逃生路只有
// $proto。
type storedFrame struct {
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Proto  string          `json:"$proto,omitempty"`
}

// EncodeStoredFrame 把一条 typed 通知编成落库的那一行。
//
// 调用方**先把 seq 盖进通知**再调用它：seq 随视图一起进 params，读侧因此不必再盖
// 一次；逃生路存的也是盖过 seq 的原件。
// 交回的是 string 而不是 []byte：落库那一列是 json，而驱动开了 interpolateParams
// 时会把 []byte 插值成 `_binary'…'`，MySQL 对 json 列拒收二进制字符集。类型在这里
// 就定成文本，调用方便无从传错（见 agent_session_entity.JournalFrame.Payload）。
func EncodeStoredFrame(notification *agentrewire.RpcNotification) (string, error) {
	method, params, err := Notification(notification)
	if err != nil {
		raw, marshalErr := proto.Marshal(notification)
		if marshalErr != nil {
			return "", fmt.Errorf("wireview: escape unprojectable frame: %w", marshalErr)
		}
		encoded, encodeErr := json.Marshal(storedFrame{Proto: base64.StdEncoding.EncodeToString(raw)})
		return string(encoded), encodeErr
	}
	encoded, encodeErr := json.Marshal(storedFrame{Method: method, Params: params})
	return string(encoded), encodeErr
}

// DecodeStoredFrame 是 EncodeStoredFrame 的逆运算：交回这一行的方法名与 params。
//
// 逃生路那一行在**读的时候**再投影一次：写入时投不出来的帧，换一个认得它的服务端
// 版本读同一行仍然投得出来。
func DecodeStoredFrame(data string) (string, json.RawMessage, error) {
	var stored storedFrame
	if err := json.Unmarshal([]byte(data), &stored); err != nil {
		return "", nil, fmt.Errorf("wireview: decode stored frame: %w", err)
	}
	if stored.Proto != "" {
		raw, err := base64.StdEncoding.DecodeString(stored.Proto)
		if err != nil {
			return "", nil, fmt.Errorf("wireview: decode escaped frame: %w", err)
		}
		notification := &agentrewire.RpcNotification{}
		if err := proto.Unmarshal(raw, notification); err != nil {
			return "", nil, fmt.Errorf("wireview: decode escaped frame: %w", err)
		}
		return Notification(notification)
	}
	if stored.Method == "" {
		return "", nil, errors.New("wireview: stored frame carries neither method nor " + storedFrameProtoKey)
	}
	return stored.Method, stored.Params, nil
}
