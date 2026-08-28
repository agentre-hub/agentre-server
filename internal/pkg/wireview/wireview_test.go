package wireview

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

func TestNotificationViewProjectsTypedRuntimeEvent(t *testing.T) {
	method, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: &agentrewire.RuntimeEventNotification{
		SessionId: 42, Seq: 7, Event: &agentrewire.RuntimeEventNotification_TextDelta{
			TextDelta: &agentrewire.TextDelta{Text: "你好"},
		},
	}},
	})
	require.NoError(t, err)
	require.Equal(t, "runtime.event", method)
	require.JSONEq(t, `{"sessionId":42,"seq":7,"event":{"kind":"text_delta","text":"你好"}}`, string(params))
}

func TestNotificationViewKeepsToolInputAsJSONObject(t *testing.T) {
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: &agentrewire.RuntimeEventNotification{
		SessionId: 42, Seq: 8, Event: &agentrewire.RuntimeEventNotification_ToolCall{
			ToolCall: &agentrewire.ToolCall{Id: "tool-1", Name: "Read", Input: []byte(`{"path":"README.md"}`)},
		},
	}},
	})
	require.NoError(t, err)
	require.JSONEq(t, `{"sessionId":42,"seq":8,"event":{"kind":"tool_use_start","id":"tool-1","name":"Read","input":{"path":"README.md"}}}`, string(params))
}

func TestNotificationViewOmitsOptionalZeroValuesFromTerminalFrames(t *testing.T) {
	tests := []struct {
		name         string
		notification *agentrewire.RpcNotification
		want         string
	}{
		{
			name: "run result done",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RunResultDone{
				RunResultDone: &agentrewire.RunResultDoneNotification{SessionId: 42},
			}},
			want: `{"sessionId":42}`,
		},
		{
			name: "autonomous turn started",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_AutonomousTurnStarted{
				AutonomousTurnStarted: &agentrewire.AutonomousTurnStartedNotification{SessionId: 42},
			}},
			want: `{"sessionId":42}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, params, err := Notification(test.notification)
			require.NoError(t, err)
			require.JSONEq(t, test.want, string(params))
			var got map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(params, &got))
			require.Len(t, got, 1, "optional zero values must retain the old HTTP view's omitempty semantics")
		})
	}
}

func TestNotificationViewProjectsPlanAsCanonicalPlanObject(t *testing.T) {
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
		RuntimeEvent: &agentrewire.RuntimeEventNotification{SessionId: 42, Seq: 9,
			Event: &agentrewire.RuntimeEventNotification_PlanUpdated{PlanUpdated: &agentrewire.PlanUpdated{
				Steps: []*agentrewire.PlanStep{{Id: "one", Step: "检查", Status: "inProgress"}},
				Text:  "# 计划",
				Actions: []*agentrewire.PlanAction{{
					Id: "plan.execute", Kind: "approve", RequiresFeedback: true,
				}},
			}},
		},
	}})
	require.NoError(t, err)
	require.JSONEq(t, `{
		"sessionId":42,"seq":9,"event":{"kind":"plan_updated","plan":{
			"steps":[{"id":"one","step":"检查","status":"inProgress"}],
			"text":"# 计划",
			"actions":[{"id":"plan.execute","kind":"approve","requiresFeedback":true}]
		}}
	}`, string(params))
}

func TestNotificationViewPreservesRequiredRuntimeEventFields(t *testing.T) {
	tests := []struct {
		name         string
		notification *agentrewire.RpcNotification
		want         string
	}{
		{
			name: "empty text delta still has text",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
				RuntimeEvent: &agentrewire.RuntimeEventNotification{SessionId: 42,
					Event: &agentrewire.RuntimeEventNotification_TextDelta{TextDelta: &agentrewire.TextDelta{}},
				},
			}},
			want: `{"sessionId":42,"event":{"kind":"text_delta","text":""}}`,
		},
		{
			name: "zero context window still has tokens",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
				RuntimeEvent: &agentrewire.RuntimeEventNotification{SessionId: 42,
					Event: &agentrewire.RuntimeEventNotification_ContextWindowUpdated{
						ContextWindowUpdated: &agentrewire.ContextWindowUpdated{},
					},
				},
			}},
			want: `{"sessionId":42,"event":{"kind":"context_window_updated","tokens":0}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, params, err := Notification(test.notification)
			require.NoError(t, err)
			require.JSONEq(t, test.want, string(params))
		})
	}
}

func TestNotificationViewUsageObjectRetainsItsStableFields(t *testing.T) {
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RunResultDone{
		RunResultDone: &agentrewire.RunResultDoneNotification{SessionId: 42, Usage: &agentrewire.Usage{}},
	}})
	require.NoError(t, err)
	require.JSONEq(t, `{"sessionId":42,"usage":{
		"promptTokens":0,"completionTokens":0,"reasoningTokens":0,
		"cachedTokens":0,"cacheCreationTokens":0,"totalTokens":0
	}}`, string(params))
}

// TestNotificationViewCoversEveryRuntimeEventCase 是这份手抄词表与 proto 之间的
// 漂移守卫。
//
// eventMessage 把 oneof 分支翻成 kind 判别值,是照着 .proto 手抄的第 N 份 —— 本仓
// 不拥有 proto(只机械同步生成的 Go),所以这份副本删不掉,能做的是让它漂不了。
//
// 漏一个分支不是小事:eventMessage 返回 nil → runtimeEventView 报错 →
// journalFrameView 报错 → **整页转录取不出来**。一条本仓没跟上的新事件,足以让
// 那条会话的转录整个读不出来,而不是少一行。
//
// 所以这里不比对字符串清单(那只是把手抄再抄一遍),而是从生成的 descriptor 枚举
// oneof,逐个真的走一遍投射。
func TestNotificationViewCoversEveryRuntimeEventCase(t *testing.T) {
	fields := (&agentrewire.RuntimeEventNotification{}).ProtoReflect().Descriptor().Oneofs().ByName("event").Fields()
	require.Positive(t, fields.Len())

	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		t.Run(string(field.Name()), func(t *testing.T) {
			frame := &agentrewire.RuntimeEventNotification{SessionId: 42, Seq: 1}
			message := frame.ProtoReflect()
			// 按 descriptor 直接置上这一路 oneof,不必手写 26 个 Go 类型。
			message.Set(field, message.NewField(field))

			method, params, err := Notification(&agentrewire.RpcNotification{
				Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: frame},
			})
			require.NoError(t, err, "%s 投射不出来 —— 整页转录会跟着取不出来", field.Name())
			require.Equal(t, "runtime.event", method)

			var view struct {
				Event struct {
					Kind string `json:"kind"`
				} `json:"event"`
			}
			require.NoError(t, json.Unmarshal(params, &view))
			require.NotEmpty(t, view.Event.Kind, "%s 没有判别值", field.Name())
		})
	}
}

// Given 对端转发来一条它自己也读不懂的转录块;When 投射成视图;Then 块类型与
// **原始 JSON 载荷**都原样出现,而不是一段 base64。
//
// data 在 proto 上是 bytes,走默认投射会变成 base64 字符串 —— 而这条事件存在的
// 全部意义就是把原件原样交出去,编成 base64 等于把它藏了。
func TestNotificationViewKeepsUnrecognizedBlockPayloadAsJSON(t *testing.T) {
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: &agentrewire.RuntimeEventNotification{
		SessionId: 42, Seq: 9, Event: &agentrewire.RuntimeEventNotification_UnrecognizedBlock{
			UnrecognizedBlock: &agentrewire.UnrecognizedBlock{
				BlockType: "future_block",
				Data:      []byte(`{"nested":{"keep":true}}`),
			},
		},
	}}})
	require.NoError(t, err)
	require.JSONEq(t,
		`{"sessionId":42,"seq":9,"event":{"kind":"unrecognized_block","blockType":"future_block","data":{"nested":{"keep":true}}}}`,
		string(params))
}
