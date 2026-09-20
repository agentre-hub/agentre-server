package engine_svc

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agentre-hub/agentre/pkg/syncwire"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// 这一组钉住控制台写出去的载荷与共享契约 syncwire 的关系。
//
// 后端（agent_backend）与供应商（llm_provider，规格 backend-config-sync 问题 6，S3）
// 都改为**按 JSON 键合并**：只改请求涉及的键，存着的其它键——含本仓 pin 的契约还
// 不认识的键——原样保留；供应商的 models 数组同理，不带 Models 的写入连那个键都不碰，
// 数组里每个模型元素服务端不认识的键因此也原样活下来。这两组因此比的是 JSON 语义
// （键集与取值，assert.JSONEq），不是结构体重编码后的字节序——map 编码的键序本就
// 与 syncwire 结构体的字段声明顺序不同。

func contractJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}

// 只填了名字与类型的新建：契约的每个顶层键照样写出来（空串、config 为 {}），
// 与桌面端写的那一种载荷键集一致。
func TestCreateBackend_ThenWritesTheSharedContractKeys(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(3), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	ctx, _ := hubtest.TxDatabase(t)
	_, err := New().CreateBackend(ctx, BackendWriteInput{
		UserID: 7, Name: stringPtr("Claude Code"), Type: stringPtr("claudecode"),
		DeviceFingerprint: stringPtr("sha256:aaaa"),
	})

	require.NoError(t, err)
	assert.JSONEq(t, contractJSON(t, syncwire.AgentBackendPayload{
		Name: "Claude Code", Type: "claudecode",
	}), saved.Payload)
}

// 桌面端写下的满值载荷（含 ACP 启动身份、hermes 字段，外加一个契约还不认识的键），
// 控制台只改一个名字：其余每个键一个不少、一个不变，未知键原样留下。config 里刻意
// 混入 acpCommand / acpArgs 与 hermes_*：控制台既不认识它们也没有对应的写入键，
// 这正是要守的场景——按 JSON 键合并时没被点名的键必须原样活下来。
func TestUpdateBackend_GivenDesktopWrittenPayload_ThenOnlyTheTouchedKeyChanges(t *testing.T) {
	stored := syncwire.AgentBackendPayload{
		Type: "claudecode", Name: "Claude Code", ProviderKey: "anthropic-main", ModelKey: "sonnet",
		EnvJSON:         `{"HTTPS_PROXY":"http://127.0.0.1:7890"}`,
		ReasoningEffort: "high",
		Config: syncwire.AgentBackendConfig{
			ModelRoutes:           json.RawMessage(`{"plan":{"providerKey":"anthropic-main","modelKey":"opus"}}`),
			Sandbox:               "workspace-write",
			Approval:              "on-request",
			DefaultPermissionMode: "acceptEdits",
			DefaultModel:          "sonnet",
			OpenClawGatewayURL:    "https://gw.example.com",
			OpenClawAgentID:       "agent-9",
			OpenClawDefaultModel:  "gpt-5",
			OpenClawSessionMode:   "resume",
			HermesURL:             "https://hermes.example.com",
			HermesAuthProvider:    "basic",
			HermesUserID:          "user-7",
			ACPCommand:            "/opt/acp/agent",
			ACPArgs:               []string{"serve", "--stdio"},
		},
	}
	var storedDoc map[string]any
	require.NoError(t, json.Unmarshal([]byte(contractJSON(t, stored)), &storedDoc))
	storedDoc["future_key"] = map[string]any{"added": "by a newer desktop"}

	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "backend-1").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		AgentredFingerprint: "sha256:aaaa", Payload: contractJSON(t, storedDoc),
	}, nil)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	ctx, _ := hubtest.TxDatabase(t)
	_, err := New().UpdateBackend(ctx, BackendWriteInput{
		UserID: 7, SyncID: "backend-1", Name: stringPtr("Claude Code 2"),
		DeviceFingerprint: stringPtr("sha256:aaaa"),
	})

	require.NoError(t, err)
	storedDoc["name"] = "Claude Code 2"
	assert.JSONEq(t, contractJSON(t, storedDoc), saved.Payload)
}

// 供应商同理：内嵌的模型行也归契约（LLMProviderModel），控制台写出去的
// llm_provider 载荷与桌面端逐字一致。
func TestUpdateProvider_ThenWritesExactlyTheSharedContractEncoding(t *testing.T) {
	stored := syncwire.LLMProviderPayload{
		Name: "Anthropic", Type: "anthropic", BaseURL: "https://api.anthropic.com",
		APIKey: "sk-secret", DefaultModelKey: "sonnet", Enabled: true,
		Models: []syncwire.LLMProviderModel{
			{ModelKey: "sonnet", ModelID: "claude-sonnet-4", Name: "Sonnet", Enabled: true, ContextWindow: 200000, MaxOutput: 8192},
			// 未填上限的一行：契约按 0 = 未知处理，两个键一并缺席。
			{ModelKey: "haiku", ModelID: "claude-haiku-4", Name: "Haiku", Enabled: false},
		},
	}

	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
		Payload: contractJSON(t, stored),
	}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	ctx, _ := hubtest.TxDatabase(t)
	got, err := New().UpdateProvider(ctx, ProviderWriteInput{
		UserID: 7, ProviderKey: "anthropic-main", Name: stringPtr("Anthropic 主号"),
	})

	require.NoError(t, err)
	want := stored
	want.Name = "Anthropic 主号"
	assert.JSONEq(t, contractJSON(t, want), saved.Payload)

	// 读侧照旧走 engine_svc 自己的 view 类型：上限「未填」在 REST 那一层仍然是
	// 缺席（*int64 为 nil），填了的那一行如实带出来。
	require.Len(t, got.Models, 2)
	require.NotNil(t, got.Models[0].ContextWindow)
	assert.Equal(t, int64(200000), *got.Models[0].ContextWindow)
	require.NotNil(t, got.Models[0].MaxOutput)
	assert.Equal(t, int64(8192), *got.Models[0].MaxOutput)
	assert.Nil(t, got.Models[1].ContextWindow)
	assert.Nil(t, got.Models[1].MaxOutput)
}

// 浏览器送上来的模型行走同一条转换：填了的上限进载荷，没填的（nil）落成契约的
// 0 = 未知，因此在载荷里缺席。
func TestCreateProvider_GivenModelsFromBrowser_ThenCarriesTheLimitsIntoTheContract(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(3), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	ctx, _ := hubtest.TxDatabase(t)
	_, err := New().CreateProvider(ctx, ProviderWriteInput{
		UserID: 7, Name: stringPtr("Anthropic"), Type: stringPtr("anthropic"),
		BaseURL: stringPtr("https://api.anthropic.com"), APIKey: stringPtr("sk-secret"),
		Models: &[]Model{
			{ModelKey: "sonnet", ModelID: "claude-sonnet-4", Name: "Sonnet", Enabled: true,
				ContextWindow: int64Ptr(200000), MaxOutput: int64Ptr(8192)},
			{ModelKey: "haiku", ModelID: "claude-haiku-4", Name: "Haiku"},
		},
	})

	require.NoError(t, err)
	assert.JSONEq(t, contractJSON(t, syncwire.LLMProviderPayload{
		Name: "Anthropic", Type: "anthropic", BaseURL: "https://api.anthropic.com",
		APIKey: "sk-secret", Enabled: true,
		Models: []syncwire.LLMProviderModel{
			{ModelKey: "sonnet", ModelID: "claude-sonnet-4", Name: "Sonnet", Enabled: true, ContextWindow: 200000, MaxOutput: 8192},
			{ModelKey: "haiku", ModelID: "claude-haiku-4", Name: "Haiku"},
		},
	}), saved.Payload)
}

// 供应商同样改为按 JSON 键合并（问题 6，S3）：控制台不认识的顶层键与模型内部键
// 原样保留，不因为 re-marshal 消失——数组里没被点名的模型更是原封不动地连同它
// 未知的键一起搬运（与 TestUpdateBackend_GivenDesktopWrittenPayload... 同一套断言）。
func TestUpdateProvider_GivenPayloadWithUnknownKeys_ThenOnlyTheTouchedKeyChanges(t *testing.T) {
	stored := syncwire.LLMProviderPayload{
		Name: "Anthropic", Type: "anthropic", BaseURL: "https://api.anthropic.com",
		APIKey: "sk-secret", DefaultModelKey: "sonnet", Enabled: true,
		Models: []syncwire.LLMProviderModel{
			{ModelKey: "sonnet", ModelID: "claude-sonnet-4", Name: "Sonnet", Enabled: true},
		},
	}
	var storedDoc map[string]any
	require.NoError(t, json.Unmarshal([]byte(contractJSON(t, stored)), &storedDoc))
	storedDoc["future_key"] = "added by a newer desktop"
	models, ok := storedDoc["models"].([]any)
	require.True(t, ok)
	firstModel, ok := models[0].(map[string]any)
	require.True(t, ok)
	firstModel["future_model_key"] = "unknown per-model field"

	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
		Payload: contractJSON(t, storedDoc),
	}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	ctx, _ := hubtest.TxDatabase(t)
	_, err := New().UpdateProvider(ctx, ProviderWriteInput{
		UserID: 7, ProviderKey: "anthropic-main", Name: stringPtr("Anthropic 2"),
	})

	require.NoError(t, err)
	storedDoc["name"] = "Anthropic 2"
	assert.JSONEq(t, contractJSON(t, storedDoc), saved.Payload)
}

// 覆盖行的形状同样归契约（agent_backend_cli 只带 cli_path），编码不变，
// 这一条守的是「以后契约改了这边跟着改」。
func TestCreateBackend_GivenCLIPath_ThenTheOverlayIsTheSharedContractEncoding(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{sync_entity.KindAgentBackendCLI}).
		Return([]*sync_entity.SyncObject{}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(3), nil).Times(2)
	var saved []*sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = append(saved, row)
		return nil
	}).Times(2)

	ctx, _ := hubtest.TxDatabase(t)
	_, err := New().CreateBackend(ctx, BackendWriteInput{
		UserID: 7, Name: stringPtr("Claude Code"), Type: stringPtr("claudecode"),
		DeviceFingerprint: stringPtr("sha256:aaaa"), CLIPath: stringPtr("/usr/local/bin/claude"),
	})

	require.NoError(t, err)
	require.Len(t, saved, 2)
	assert.Equal(t, contractJSON(t, syncwire.AgentBackendCLIPayload{
		CLIPath: "/usr/local/bin/claude",
	}), saved[1].Payload)
}

func int64Ptr(v int64) *int64 { return &v }
