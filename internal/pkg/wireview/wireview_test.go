package wireview

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// conversationID 是一条对话的全局标识（UUIDv7），线格式上取代了原先的 int64 会话号。
const conversationID = "3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"

func TestNotificationViewProjectsTypedRuntimeEvent(t *testing.T) {
	method, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: &agentrewire.RuntimeEventNotification{
		ConversationId: conversationID, Seq: 7, Event: &agentrewire.RuntimeEventNotification_TextDelta{
			TextDelta: &agentrewire.TextDelta{Text: "你好"},
		},
	}},
	})
	require.NoError(t, err)
	require.Equal(t, "runtime.event", method)
	require.JSONEq(t, `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","seq":7,"event":{"kind":"text_delta","text":"你好"}}`, string(params))
}

func TestNotificationViewKeepsToolInputAsJSONObject(t *testing.T) {
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: &agentrewire.RuntimeEventNotification{
		ConversationId: conversationID, Seq: 8, Event: &agentrewire.RuntimeEventNotification_ToolCall{
			ToolCall: &agentrewire.ToolCall{Id: "tool-1", Name: "Read", Input: []byte(`{"path":"README.md"}`)},
		},
	}},
	})
	require.NoError(t, err)
	require.JSONEq(t, `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","seq":8,"event":{"kind":"tool_use_start","id":"tool-1","name":"Read","input":{"path":"README.md"}}}`, string(params))
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
				RunResultDone: &agentrewire.RunResultDoneNotification{ConversationId: conversationID},
			}},
			want: `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"}`,
		},
		{
			name: "autonomous turn started",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_AutonomousTurnStarted{
				AutonomousTurnStarted: &agentrewire.AutonomousTurnStartedNotification{ConversationId: conversationID},
			}},
			want: `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"}`,
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
		RuntimeEvent: &agentrewire.RuntimeEventNotification{ConversationId: conversationID, Seq: 9,
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
		"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","seq":9,"event":{"kind":"plan_updated","plan":{
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
				RuntimeEvent: &agentrewire.RuntimeEventNotification{ConversationId: conversationID,
					Event: &agentrewire.RuntimeEventNotification_TextDelta{TextDelta: &agentrewire.TextDelta{}},
				},
			}},
			want: `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","event":{"kind":"text_delta","text":""}}`,
		},
		{
			name: "zero context window still has tokens",
			notification: &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{
				RuntimeEvent: &agentrewire.RuntimeEventNotification{ConversationId: conversationID,
					Event: &agentrewire.RuntimeEventNotification_ContextWindowUpdated{
						ContextWindowUpdated: &agentrewire.ContextWindowUpdated{},
					},
				},
			}},
			want: `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","event":{"kind":"context_window_updated","tokens":0}}`,
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
		RunResultDone: &agentrewire.RunResultDoneNotification{ConversationId: conversationID, Usage: &agentrewire.Usage{}},
	}})
	require.NoError(t, err)
	require.JSONEq(t, `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","usage":{
		"promptTokens":0,"completionTokens":0,"reasoningTokens":0,
		"cachedTokens":0,"cacheCreationTokens":0,"totalTokens":0
	}}`, string(params))
}

// TestNotificationViewCoversEveryRuntimeEventCase 守的是「每条事件分支都投影得出来」。
//
// 手抄词表已经没有了:判别值写在 .proto 的 (agentre.wire.event_kind) 上,本包经
// pkg/wire/eventkind 从 descriptor 读。但「读得到」不等于「投影得出来」—— 上游漏标
// 一条新分支,eventkind.Of 就报不认识,于是 runtimeEventView 报错 → journalFrameView
// 报错 → **整页转录取不出来**,而不是少一行。这条用例是本仓这一侧对那件事的兜底。
//
// 断言仍然从生成的 descriptor 枚举 oneof、逐个真的走一遍投射,不比对字符串清单 ——
// 比对清单只是把手抄换个地方再写一遍。
func TestNotificationViewCoversEveryRuntimeEventCase(t *testing.T) {
	fields := (&agentrewire.RuntimeEventNotification{}).ProtoReflect().Descriptor().Oneofs().ByName("event").Fields()
	require.Positive(t, fields.Len())

	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		t.Run(string(field.Name()), func(t *testing.T) {
			frame := &agentrewire.RuntimeEventNotification{ConversationId: conversationID, Seq: 1}
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
		ConversationId: conversationID, Seq: 9, Event: &agentrewire.RuntimeEventNotification_UnrecognizedBlock{
			UnrecognizedBlock: &agentrewire.UnrecognizedBlock{
				BlockType: "future_block",
				Data:      []byte(`{"nested":{"keep":true}}`),
			},
		},
	}}})
	require.NoError(t, err)
	require.JSONEq(t,
		`{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","seq":9,"event":{"kind":"unrecognized_block","blockType":"future_block","data":{"nested":{"keep":true}}}}`,
		string(params))
}

// 终态帧的本轮计时必须一起过投影。
//
// 这条路径是**账号镜像**：库里存着的原始 journal 帧解出来发给浏览器，转录里那一
// 行 meta（模型 · 耗时 · 首字 · 速率）就靠它。doneView 是逐字段手写的，漏一个的
// 表现不是报错而是**静默变空**——历史会话上那三个数没了，实时那一轮却有，两边
// 对不上还查不出来路。
func TestNotificationViewCarriesTurnStats(t *testing.T) {
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RunResultDone{
		RunResultDone: &agentrewire.RunResultDoneNotification{
			ConversationId: conversationID, DurationMs: 9640, FirstTokenMs: 8010, TokensPerSec: 14.2,
		},
	}})
	require.NoError(t, err)
	require.JSONEq(t, `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","durationMs":9640,"firstTokenMs":8010,"tokensPerSec":14.2}`, string(params))
}

// 零值按本包的约定省略（putNonzero）：浏览器那侧 journaledToFrame 会把它补回 0，
// 而 0 在转录里读作「这台机器答不出这个数」，不是「这一轮零耗时」。
func TestNotificationViewOmitsZeroTurnStats(t *testing.T) {
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RunResultDone{
		RunResultDone: &agentrewire.RunResultDoneNotification{ConversationId: conversationID},
	}})
	require.NoError(t, err)
	require.JSONEq(t, `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"}`, string(params))
}

// Given daemon 现在会在客户端要的一轮开始时发一条 runtime.turnStarted;
// When 它经镜像落库、再从库里投影给浏览器;Then 照常投影成 (方法名, params)。
//
// 认不出的通知这里是**报错**的（丢一帧就是页面上一段无声消失的转录），而账号镜像
// 的详情页整页共用这一次投影 —— 不接这一格，新 agentred 上线之后每一条跑过轮次的
// 对话，历史都读不出来。
func TestNotificationViewProjectsTurnStarted(t *testing.T) {
	method, params, err := Notification(&agentrewire.RpcNotification{
		Payload: &agentrewire.RpcNotification_TurnStarted{
			TurnStarted: &agentrewire.TurnStartedNotification{ConversationId: conversationID, Seq: 3},
		},
	})
	require.NoError(t, err)
	require.Equal(t, "runtime.turnStarted", method)
	require.JSONEq(t, `{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","seq":3}`, string(params))
}

// Given 一个本该装 JSON 的 bytes 字段里装的不是合法 JSON；When 投射成视图；
// Then 该字段以 {"$b64": ...} 出现，字节一个不丢。
//
// 从前这里是**静默丢键**：putRawJSON 解不动就什么都不写，页面上那次工具调用于是
// 没有 input，而且哪儿都不报错。载荷改为 JSON 落库之后，同一条路径丢掉的就不再是
// 一次渲染，而是库里再也找不回来的原件。
func TestNotificationViewWrapsNonJSONBytesInsteadOfDroppingTheKey(t *testing.T) {
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: &agentrewire.RuntimeEventNotification{
		ConversationId: conversationID, Seq: 11, Event: &agentrewire.RuntimeEventNotification_ToolCall{
			ToolCall: &agentrewire.ToolCall{Id: "tool-9", Name: "Read", Input: []byte{0x00, 0x01, 0xff}},
		},
	}}})
	require.NoError(t, err)
	require.JSONEq(t,
		`{"conversationId":"3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88","seq":11,"event":{"kind":"tool_use_start","id":"tool-9","name":"Read","input":{"$b64":"AAH/"}}}`,
		string(params))
}

// rawJSONByteFields 是**允许**出现在可投射通知里的 bytes 字段：它们装的都是原始
// JSON，proto 上用 bytes 只是因为没有 raw-JSON 类型，投影时由 putRawJSON 还原。
//
// 这张表是白名单而不是记录：给转录类消息新加一个 bytes 字段时守卫会点名它，逼一次
// 明确判断 —— 它到底装的是 JSON（补进这里、并在 RuntimeEvent 里加 putRawJSON），
// 还是真的二进制（那它就不该进这条通道，见下面那半个守卫）。
var rawJSONByteFields = map[string]bool{
	"agentre.wire.ToolCall.input":              true,
	"agentre.wire.ToolCall.canonical":          true,
	"agentre.wire.ToolResult.meta":             true,
	"agentre.wire.ToolPermissionRequest.input": true,
	"agentre.wire.UnrecognizedBlock.data":      true,
}

// projectableNotifications 是 Notification 认得的那些 RpcNotification 分支。
var projectableNotifications = map[string]bool{
	"runtime_event":           true,
	"run_result_done":         true,
	"autonomous_turn_started": true,
	"autonomous_turn_event":   true,
	"autonomous_turn_done":    true,
	"turn_started":            true,
}

// Given 一条 RpcNotification 的每一路 oneof；When 交给 Notification；Then 只有
// 转录相关的那些投得出来，承载真实二进制的那些（terminal_data 的 bytes data）
// 继续被拒。
//
// 两个方向都断言：只查"该过的过了"会让一个什么都放行的实现照样绿。
func TestNotificationRejectsTheBranchesThatCarryRealBinary(t *testing.T) {
	fields := (&agentrewire.RpcNotification{}).ProtoReflect().Descriptor().Oneofs().ByName("payload").Fields()
	require.Positive(t, fields.Len())

	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		t.Run(string(field.Name()), func(t *testing.T) {
			notification := &agentrewire.RpcNotification{}
			message := notification.ProtoReflect()
			inner := message.Mutable(field).Message()
			// 运行时事件那两路的内层还有一个 oneof，空着的话报的是「没有 typed
			// event」——那不是本守卫要问的问题。同样按 descriptor 填第一路。
			if events := inner.Descriptor().Oneofs().ByName("event"); events != nil {
				first := events.Fields().Get(0)
				inner.Set(first, inner.NewField(first))
			}

			_, _, err := Notification(notification)
			if projectableNotifications[string(field.Name())] {
				require.NoError(t, err, "%s 该投得出来", field.Name())
				return
			}
			require.Error(t, err,
				"%s 必须继续被拒 —— 它不该进镜像日志那条通道", field.Name())
		})
	}
}

// Given 可投射的那些通知的整棵消息树；When 找出其中所有 bytes 字段；Then 每一个
// 都在 rawJSONByteFields 白名单里。
//
// 这是「镜像日志里没有真二进制」这条性质的守卫。载荷以 JSON 落库之后，一个真二进制
// 字段会变成一大段 base64：既搜不到，又把那张唯一的无界表撑大，而且不会有任何报错。
func TestProjectableNotificationsCarryNoUnknownBinaryField(t *testing.T) {
	fields := (&agentrewire.RpcNotification{}).ProtoReflect().Descriptor().Oneofs().ByName("payload").Fields()
	seen := map[protoreflect.FullName]bool{}
	var found []string

	var walk func(descriptor protoreflect.MessageDescriptor)
	walk = func(descriptor protoreflect.MessageDescriptor) {
		if seen[descriptor.FullName()] {
			return
		}
		seen[descriptor.FullName()] = true
		for i := 0; i < descriptor.Fields().Len(); i++ {
			field := descriptor.Fields().Get(i)
			switch field.Kind() {
			case protoreflect.BytesKind:
				if !rawJSONByteFields[string(field.FullName())] {
					found = append(found, string(field.FullName()))
				}
			case protoreflect.MessageKind, protoreflect.GroupKind:
				walk(field.Message())
			}
		}
	}

	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		if !projectableNotifications[string(field.Name())] {
			continue
		}
		walk(field.Message())
	}

	require.Empty(t, found,
		"这些 bytes 字段能进镜像日志：装 JSON 就补进 rawJSONByteFields 并在 RuntimeEvent 里 putRawJSON，"+
			"是真二进制就不该走这条通道")
}

// Given 一条投影得出来的通知；When 编码落库再解回来；Then 方法名与 params 与直接
// 投影的结果一致。
func TestStoredFrameRoundTripsTheProjectedView(t *testing.T) {
	notification := &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: &agentrewire.RuntimeEventNotification{
		ConversationId: conversationID, Seq: 12, Event: &agentrewire.RuntimeEventNotification_TextDelta{
			TextDelta: &agentrewire.TextDelta{Text: "落库再读回来"},
		},
	}}}
	wantMethod, wantParams, err := Notification(notification)
	require.NoError(t, err)

	stored, err := EncodeStoredFrame(notification)
	require.NoError(t, err)
	require.Contains(t, string(stored), `"method"`, "落库那一行必须是可读的 JSON")

	method, params, err := DecodeStoredFrame(stored)
	require.NoError(t, err)
	assert.Equal(t, wantMethod, method)
	assert.JSONEq(t, string(wantParams), string(params))
}

// Given 一条这一侧投影不出来的通知；When 编码落库；Then 它走 $proto 逃生路，且**读**
// 的时候再投影一次 —— 换一个认得它的版本读同一行仍然读得出来。
//
// 这是决策 4「存的是原始帧」在写侧的兑现方式：写入时投不出来不等于这一行作废。
func TestStoredFrameEscapesWhatItCannotProject(t *testing.T) {
	opaque := &agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_TerminalData{
		TerminalData: &agentrewire.TerminalDataNotification{TerminalId: "t1", Data: []byte{0x00, 0x01}},
	}}
	_, _, err := Notification(opaque)
	require.Error(t, err, "前提：这一条本来就投影不出来")

	stored, err := EncodeStoredFrame(opaque)
	require.NoError(t, err, "投影不出来不该让落库失败 —— 那会卡死整条镜像")
	require.Contains(t, string(stored), storedFrameProtoKey)

	// 读的时候仍然读不懂,但原件还在:解出来的字节能还原成同一条通知。
	var escaped struct {
		Proto string `json:"$proto"`
	}
	require.NoError(t, json.Unmarshal(stored, &escaped))
	raw, err := base64.StdEncoding.DecodeString(escaped.Proto)
	require.NoError(t, err)
	round := &agentrewire.RpcNotification{}
	require.NoError(t, proto.Unmarshal(raw, round))
	assert.Equal(t, []byte{0x00, 0x01}, round.GetTerminalData().GetData())

	_, _, err = DecodeStoredFrame(stored)
	require.Error(t, err, "这一侧读不懂就该说读不懂,而不是编一个视图出来")
}

// 形状不对的那一行要报错，不能悄悄交出一个空视图 —— 空视图在页面上是一段无声消失的
// 转录，报错则由读侧兜成一个看得见的缺口帧。
func TestStoredFrameRejectsAShapeItDoesNotRecognise(t *testing.T) {
	for name, payload := range map[string][]byte{
		"不是 JSON":             []byte("\x00\x01\xff"),
		"既无 method 也无 $proto": []byte(`{"seq":3}`),
	} {
		t.Run(name, func(t *testing.T) {
			_, _, err := DecodeStoredFrame(payload)
			require.Error(t, err)
		})
	}
}

// Given 一个 tool_call 的 input 里带着超出 float64 精度的整数与一个写作 1.0 的小数；
// When 投射成视图；Then 两个数都原样出现。
//
// putRawJSON 从前把载荷解成 any 再重编：JSON 数字一律经 float64 中转，19 位的整数
// （纳秒时刻、雪花 ID、大文件偏移）于是被改成**另一个值**并写成科学计数法。载荷改
// 为 JSON 落库之后这份视图就是库里那一行，原件不再另存一份 —— 改掉的位再也找不
// 回来。同一条路径上的 transcript_projection.go 早就为这件事开了 UseNumber。
func TestNotificationViewKeepsRawJSONNumbersExact(t *testing.T) {
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: &agentrewire.RuntimeEventNotification{
		ConversationId: conversationID, Seq: 13, Event: &agentrewire.RuntimeEventNotification_ToolCall{
			ToolCall: &agentrewire.ToolCall{Id: "tool-3", Name: "Read", Input: []byte(`{"offset":1234567890123456789,"ratio":1.0}`)},
		},
	}}})
	require.NoError(t, err)

	var view struct {
		Event struct {
			Input map[string]json.Number `json:"input"`
		} `json:"event"`
	}
	require.NoError(t, json.Unmarshal(params, &view))
	assert.Equal(t, "1234567890123456789", view.Event.Input["offset"].String())
	assert.Equal(t, "1.0", view.Event.Input["ratio"].String())
}

// Given 一个 bytes 字段装着**语法上合法、但内含非 UTF-8 字节**的 JSON；When 投射成
// 视图；Then 它走 {"$b64": ...}，字节一个不丢。
//
// 视图落的是 MySQL 的 json 列，那一列只收 utf8mb4：非法字节要么被静默改写成 U+FFFD
// （原件从此找不回来），要么让整批写入失败、这条对话的镜像卡在原地重试。$b64 两头
// 都不占：字节原样留着，列拿到的仍是合法 utf8mb4。
func TestNotificationViewEscapesJSONThatIsNotValidUTF8(t *testing.T) {
	raw := []byte("{\"path\":\"\xff\xfe\"}")
	_, params, err := Notification(&agentrewire.RpcNotification{Payload: &agentrewire.RpcNotification_RuntimeEvent{RuntimeEvent: &agentrewire.RuntimeEventNotification{
		ConversationId: conversationID, Seq: 14, Event: &agentrewire.RuntimeEventNotification_ToolCall{
			ToolCall: &agentrewire.ToolCall{Id: "tool-4", Name: "Read", Input: raw},
		},
	}}})
	require.NoError(t, err)

	var view struct {
		Event struct {
			Input map[string]string `json:"input"`
		} `json:"event"`
	}
	require.NoError(t, json.Unmarshal(params, &view))
	decoded, err := base64.StdEncoding.DecodeString(view.Event.Input[rawBytesEscapeKey])
	require.NoError(t, err)
	assert.Equal(t, raw, decoded)
	assert.True(t, utf8.Valid(params), "落库那一行必须是合法 utf8mb4")
}
