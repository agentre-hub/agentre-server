// Package wireview 把一条 typed Protobuf 通知投影成浏览器读得懂的 JSON：方法名 +
// params 正文。它是**跨层的横切件**（internal/pkg 的定位），因为两条互不相干的
// 路径要的是同一份投影，而两份手抄的 27 分支事件表一定会漂开：
//
//   - 账号镜像的详情页（workspace_svc）：库里存的原始 journal 帧解出来发给浏览器；
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

	"google.golang.org/protobuf/reflect/protoreflect"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/eventkind"
)

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
	var value any
	if json.Unmarshal(data, &value) == nil {
		out[key] = value
	}
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
