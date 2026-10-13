package engine_svc

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

// ── OpenClaw 后端的 config（规格 2026-09-22 agrctl-resource-management，修正轮 3）──
//
// 桌面端按 agent_backend_entity 的规则收同步行（agentre 仓库
// internal/model/entity/agent_backend_entity/agent_backend.go 的
// NormalizeOpenClawGatewayURL 与 kinds.go 的 openClawKind.ValidateExtra），过不了的行
// 永远落不了地。server 的写入口因此在落库前按同一规则判，下面的用例表与桌面端
// openclaw_kind_test.go 的 TestOpenClawBackendKind / TestNormalizeOpenClawGatewayURL 逐条对应。

// openClawFields 是一条只带 config 的 OpenClaw 后端（其余载荷键为空，env_json 是 {}）。
func openClawFields(config json.RawMessage) BackendFields {
	return BackendFields{Type: "openclaw", EnvJSON: "{}", Config: config}
}

func openClawConfig(gatewayURL string) json.RawMessage {
	raw, _ := json.Marshal(map[string]string{
		"openclawGatewayUrl": gatewayURL, "openclawSessionMode": "per-agentre-session",
	})
	return raw
}

func TestNormalizeBackendConfig_GivenOpenClawGatewayURL_ThenDesktopRulesApply(t *testing.T) {
	ctx := context.Background()

	for _, tc := range []struct{ in, want string }{
		{"ws://127.0.0.1:18789", "ws://127.0.0.1:18789"},
		{"wss://gateway.example.com/openclaw", "wss://gateway.example.com/openclaw"},
		{"  ws://LOCALHOST:18789/  ", "ws://localhost:18789/"},
		{"ws://[::1]:18789", "ws://[::1]:18789"},
	} {
		t.Run("Given a valid gateway when normalized then the stable URL is stored: "+tc.in, func(t *testing.T) {
			got, err := NormalizeBackendConfig(ctx, openClawFields(openClawConfig(tc.in)))
			require.NoError(t, err)
			assert.Equal(t, tc.want, rawKey(t, got, "openclawGatewayUrl"))
		})
	}

	for _, tc := range []struct {
		in   string
		code int
	}{
		{"", code.EngineOpenClawGatewayURLRequired},
		{"   ", code.EngineOpenClawGatewayURLRequired},
		{"http://127.0.0.1:18789", code.EngineOpenClawGatewayURLScheme},
		{"127.0.0.1:18789", code.EngineOpenClawGatewayURLInvalid},
		{"ws://192.168.1.10:18789", code.EngineOpenClawGatewayURLPlaintextRemote},
		{"ws://gateway.example.com:18789", code.EngineOpenClawGatewayURLPlaintextRemote},
		{"wss://token@gateway.example.com/openclaw", code.EngineOpenClawGatewayURLCredentials},
		{"wss://gateway.example.com/openclaw?token=secret", code.EngineOpenClawGatewayURLCredentials},
		{"wss://gateway.example.com/openclaw#frag", code.EngineOpenClawGatewayURLCredentials},
		{"wss:///missing-host", code.EngineOpenClawGatewayURLHost},
		{"wss://[::1", code.EngineOpenClawGatewayURLInvalid},
	} {
		t.Run("Given an unsafe or invalid gateway when normalized then the reason is its own code: "+tc.in, func(t *testing.T) {
			_, err := NormalizeBackendConfig(ctx, openClawFields(openClawConfig(tc.in)))
			require.Error(t, err)
			assert.Equal(t, tc.code, engineErrorCode(t, err))
			assert.NotContains(t, err.Error(), "secret", "拒绝原因里不回显 URL 本身")
		})
	}
}

func TestNormalizeBackendConfig_GivenOpenClawSessionMode_ThenEmptyDefaultsAndUnknownIsRejected(t *testing.T) {
	ctx := context.Background()

	t.Run("Given no session mode when normalized then per-agentre-session is filled in like the desktop service", func(t *testing.T) {
		got, err := NormalizeBackendConfig(ctx, openClawFields(json.RawMessage(`{"openclawGatewayUrl":"ws://127.0.0.1:18789","futureKey":1}`)))
		require.NoError(t, err)
		assert.JSONEq(t, `{"openclawGatewayUrl":"ws://127.0.0.1:18789","openclawSessionMode":"per-agentre-session","futureKey":1}`, string(got),
			"config 里服务端不认识的键原样保留")
	})

	t.Run("Given an unknown session mode when normalized then it is rejected", func(t *testing.T) {
		_, err := NormalizeBackendConfig(ctx, openClawFields(json.RawMessage(`{"openclawGatewayUrl":"ws://127.0.0.1:18789","openclawSessionMode":"shared"}`)))
		require.Error(t, err)
		assert.Equal(t, code.EngineOpenClawSessionModeInvalid, engineErrorCode(t, err))
	})
}

// 与桌面端 openclaw_kind_test.go:61-83（mutuallyExclusive 表）逐条对应：OpenClaw 自带
// 模型与运行参数，别的后端类型的字段一个都不收——kinds.go:207-219 openClawKind.ValidateExtra；
// hermes / acp 的独占配置则由 agent_backend.go:222-227 的 hasHermesConfig / hasACPConfig 拒。
func TestNormalizeBackendConfig_GivenOpenClawWithForeignFields_ThenRejectedWithTheReason(t *testing.T) {
	ctx := context.Background()
	valid := func() BackendFields {
		return openClawFields(openClawConfig("ws://127.0.0.1:18789"))
	}
	withConfig := func(key string, value any) func(*BackendFields) {
		return func(b *BackendFields) {
			var doc map[string]any
			require.NoError(t, json.Unmarshal(b.Config, &doc))
			doc[key] = value
			b.Config, _ = json.Marshal(doc)
		}
	}
	for _, tc := range []struct {
		name  string
		apply func(*BackendFields)
		code  int
	}{
		{"llm provider", func(b *BackendFields) { b.ProviderKey = "provider" }, code.EngineOpenClawProviderModelNotAllowed},
		{"llm model key", func(b *BackendFields) { b.ModelKey = "model-key" }, code.EngineOpenClawProviderModelNotAllowed},
		{"environment", func(b *BackendFields) { b.EnvJSON = `{"TOKEN":"secret"}` }, code.EngineOpenClawEnvNotAllowed},
		{"reasoning effort", func(b *BackendFields) { b.ReasoningEffort = "high" }, code.EngineOpenClawReasoningEffortNotAllowed},
		{"model routes", withConfig("modelRoutes", map[string]any{"OPUS": map[string]string{"providerKey": "p"}}), code.EngineOpenClawCLISettingsNotAllowed},
		{"sandbox", withConfig("sandbox", "workspace-write"), code.EngineOpenClawCLISettingsNotAllowed},
		{"approval", withConfig("approval", "on-request"), code.EngineOpenClawCLISettingsNotAllowed},
		{"permission mode", withConfig("defaultPermissionMode", "default"), code.EngineOpenClawCLISettingsNotAllowed},
		{"legacy default model", withConfig("defaultModel", "wrong-field"), code.EngineOpenClawCLISettingsNotAllowed},
		{"hermes url", withConfig("hermesUrl", "http://127.0.0.1:9119"), code.EngineOpenClawForeignConfigNotAllowed},
		{"hermes auth provider", withConfig("hermesAuthProvider", "github"), code.EngineOpenClawForeignConfigNotAllowed},
		{"hermes user", withConfig("hermesUserId", "u-1"), code.EngineOpenClawForeignConfigNotAllowed},
		{"acp command", withConfig("acpCommand", "hermes"), code.EngineOpenClawForeignConfigNotAllowed},
		{"acp args", withConfig("acpArgs", []string{"acp"}), code.EngineOpenClawForeignConfigNotAllowed},
	} {
		t.Run("Given OpenClaw with "+tc.name+" when normalized then it is rejected", func(t *testing.T) {
			b := valid()
			tc.apply(&b)
			_, err := NormalizeBackendConfig(ctx, b)
			require.Error(t, err)
			assert.Equal(t, tc.code, engineErrorCode(t, err))
			assert.NotContains(t, err.Error(), "secret")
		})
	}

	// 桌面端 isEmptyJSONObject（kinds.go:327）把 "" 与 "{}" 都当空，其余空白值同样放行。
	for _, tc := range []struct {
		name  string
		apply func(*BackendFields)
	}{
		{"empty env_json string", func(b *BackendFields) { b.EnvJSON = "" }},
		{"blank strings", func(b *BackendFields) { b.ProviderKey, b.ModelKey, b.ReasoningEffort = " ", "", " " }},
		{"empty model routes object", withConfig("modelRoutes", map[string]any{})},
		{"blank sandbox", withConfig("sandbox", "  ")},
		{"empty acp args", withConfig("acpArgs", []string{})},
		{"null sandbox", withConfig("sandbox", nil)},
		{"openclaw agent and model", func(b *BackendFields) {
			withConfig("openclawAgentId", "main")(b)
			withConfig("openclawDefaultModel", "anthropic/claude-sonnet-4-6")(b)
		}},
	} {
		t.Run("Given OpenClaw with "+tc.name+" when normalized then it is accepted", func(t *testing.T) {
			b := valid()
			tc.apply(&b)
			_, err := NormalizeBackendConfig(ctx, b)
			require.NoError(t, err)
		})
	}
}

func TestCreateBackend_GivenOpenClawWithProvider_ThenRejectWithoutWriting(t *testing.T) {
	ctx, _, _, _ := setupBackendWrite(t)
	_, err := New().CreateBackend(ctx, BackendWriteInput{
		UserID: 7, Name: stringPtr("claw"), Type: stringPtr("openclaw"), ProviderKey: stringPtr("prov-1"),
		DeviceFingerprint: stringPtr("sha256:aaaa"), Config: openClawConfig("ws://127.0.0.1:18789"),
	})
	require.Error(t, err)
	assert.Equal(t, code.EngineOpenClawProviderModelNotAllowed, engineErrorCode(t, err))
}

func TestNormalizeBackendConfig_GivenOtherBackendTypes_ThenConfigIsUntouched(t *testing.T) {
	for _, typ := range []string{"claudecode", "codex", "hermes", ""} {
		t.Run(typ, func(t *testing.T) {
			got, err := NormalizeBackendConfig(context.Background(), BackendFields{
				Type: typ, ProviderKey: "prov", EnvJSON: `{"A":"1"}`, ReasoningEffort: "high",
				Config: json.RawMessage(`{"sandbox":"workspace-write"}`),
			})
			require.NoError(t, err)
			assert.JSONEq(t, `{"sandbox":"workspace-write"}`, string(got))
		})
	}
}

// 实测：`agrctl create backend --type openclaw`（没给 --config）经 server 建出了 config {}
// 的行，桌面端每 30 s 报一次落不了地。创建与更新都要在落库前拒绝：不取号、不写。
func TestBackendWrites_GivenOpenClawWithoutGateway_ThenRejectWithoutWriting(t *testing.T) {
	ctx, _, _, _ := setupBackendWrite(t) // 没有查设备、取号、落库的期望：config 先判

	_, err := New().CreateBackend(ctx, BackendWriteInput{
		UserID: 7, Name: stringPtr("claw-self"), Type: stringPtr("openclaw"),
		DeviceFingerprint: stringPtr("sha256:aaaa"),
	})
	require.Error(t, err)
	assert.Equal(t, code.EngineOpenClawGatewayURLRequired, engineErrorCode(t, err))

	_, err = New().CreateBackend(ctx, BackendWriteInput{
		UserID: 7, Name: stringPtr("claw-self"), Type: stringPtr("openclaw"),
		DeviceFingerprint: stringPtr("sha256:aaaa"), Config: openClawConfig("ws://gateway.example.com:18789"),
	})
	require.Error(t, err)
	assert.Equal(t, code.EngineOpenClawGatewayURLPlaintextRemote, engineErrorCode(t, err))
}

func TestUpdateBackend_GivenOpenClawWithUnsafeGateway_ThenRejectWithoutWriting(t *testing.T) {
	ctx, _, objects, _ := setupBackendWrite(t)
	expectLockedBackend(objects, `{"name":"claw","type":"openclaw","config":{"openclawGatewayUrl":"ws://127.0.0.1:18789","openclawSessionMode":"per-agentre-session"}}`)

	_, err := New().UpdateBackend(ctx, BackendWriteInput{
		UserID: 7, SyncID: "backend-1", DeviceFingerprint: stringPtr("sha256:aaaa"),
		Config: openClawConfig("wss://gateway.example.com/openclaw?token=secret"),
	})
	require.Error(t, err)
	assert.Equal(t, code.EngineOpenClawGatewayURLCredentials, engineErrorCode(t, err))
}

func TestCreateBackend_GivenValidOpenClaw_ThenNormalizedConfigIsStored(t *testing.T) {
	ctx, ctrl, objects, states := setupBackendWrite(t)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	saved := captureSave(objects, states)

	got, err := New().CreateBackend(ctx, BackendWriteInput{
		UserID: 7, Name: stringPtr("claw"), Type: stringPtr("openclaw"), DeviceFingerprint: stringPtr("sha256:aaaa"),
		Config: json.RawMessage(`{"openclawGatewayUrl":" ws://LOCALHOST:18789/ ","openclawAgentId":"main"}`),
	})

	require.NoError(t, err)
	want := `{"openclawGatewayUrl":"ws://localhost:18789/","openclawAgentId":"main","openclawSessionMode":"per-agentre-session"}`
	assert.JSONEq(t, want, payloadRaw(t, saved.Payload, "config"))
	assert.JSONEq(t, want, string(got.Config))
}

func rawKey(t *testing.T, config json.RawMessage, key string) string {
	t.Helper()
	var values map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(config, &values))
	var v string
	require.NoError(t, json.Unmarshal(values[key], &v))
	return v
}
