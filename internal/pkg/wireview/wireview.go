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
package wireview

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
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
	kind, message := eventMessage(frame.GetEvent())
	if message == nil {
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

func eventMessage(event any) (string, proto.Message) {
	switch value := event.(type) {
	case *agentrewire.RuntimeEventNotification_TextDelta:
		return "text_delta", value.TextDelta
	case *agentrewire.RuntimeEventNotification_ThinkingDelta:
		return "thinking_delta", value.ThinkingDelta
	case *agentrewire.RuntimeEventNotification_OutputActivity:
		return "output_activity", value.OutputActivity
	case *agentrewire.RuntimeEventNotification_PermissionModeChanged:
		return "permission_mode_changed", value.PermissionModeChanged
	case *agentrewire.RuntimeEventNotification_Retry:
		return "retry", value.Retry
	case *agentrewire.RuntimeEventNotification_ContextWindowUpdated:
		return "context_window_updated", value.ContextWindowUpdated
	case *agentrewire.RuntimeEventNotification_CompactBoundary:
		return "compact_boundary", value.CompactBoundary
	case *agentrewire.RuntimeEventNotification_RuntimeStatus:
		return "runtime_status", value.RuntimeStatus
	case *agentrewire.RuntimeEventNotification_Done:
		return "done", value.Done
	case *agentrewire.RuntimeEventNotification_Error:
		return "error", value.Error
	case *agentrewire.RuntimeEventNotification_UserMessage:
		return "user_message", value.UserMessage
	case *agentrewire.RuntimeEventNotification_ToolCall:
		return "tool_use_start", value.ToolCall
	case *agentrewire.RuntimeEventNotification_ToolResult:
		return "tool_result", value.ToolResult
	case *agentrewire.RuntimeEventNotification_SteerConsumed:
		return "steer_consumed", value.SteerConsumed
	case *agentrewire.RuntimeEventNotification_UserAskRequest:
		return "ask_user_question", value.UserAskRequest
	case *agentrewire.RuntimeEventNotification_UserAskResolved:
		return "ask_user_question_answered", value.UserAskResolved
	case *agentrewire.RuntimeEventNotification_ToolPermissionRequest:
		return "tool_permission_request", value.ToolPermissionRequest
	case *agentrewire.RuntimeEventNotification_ToolPermissionResolved:
		return "tool_permission_resolved", value.ToolPermissionResolved
	case *agentrewire.RuntimeEventNotification_ExecApprovalRequested:
		return "exec_approval_requested", value.ExecApprovalRequested
	case *agentrewire.RuntimeEventNotification_ExecApprovalResolved:
		return "exec_approval_resolved", value.ExecApprovalResolved
	case *agentrewire.RuntimeEventNotification_SubagentStarted:
		return "subagent_started", value.SubagentStarted
	case *agentrewire.RuntimeEventNotification_SubagentProgress:
		return "subagent_progress", value.SubagentProgress
	case *agentrewire.RuntimeEventNotification_SubagentDone:
		return "subagent_done", value.SubagentDone
	case *agentrewire.RuntimeEventNotification_SubagentModel:
		return "subagent_model", value.SubagentModel
	case *agentrewire.RuntimeEventNotification_UsageUpdate:
		return "usage", value.UsageUpdate
	case *agentrewire.RuntimeEventNotification_PlanUpdated:
		return "plan_updated", value.PlanUpdated
	case *agentrewire.RuntimeEventNotification_UnrecognizedBlock:
		return "unrecognized_block", value.UnrecognizedBlock
	default:
		return "", nil
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
