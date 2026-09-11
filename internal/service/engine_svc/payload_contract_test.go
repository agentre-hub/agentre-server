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

// 这一组把「控制台写出去的字节 == 共享契约自己的编码」钉住。
//
// 三条写路径（saveProvider / saveBackend / saveCLIOverlay）都是**解进结构体再整体
// re-marshal**：这个结构体没声明的键，每一次控制台编辑都会被静默抹掉。断言写成整串
// 字节相等而不是逐键比对，正是因为要拦的就是「少了一个键」——逐键比对只看得见自己
// 列出来的那几个键，漏掉的那个恰恰是它看不见的。
//
// 用 syncwire 自己 marshal 出来的字节当期望值，而不是手写字面量：契约加一个字段时
// 这几条当场红，而不是等到某个账号在某一端静默变空。

func contractJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}

// 只填了名字与类型的新建：其余十三个键在契约里**照样写出来**（空串），
// 而不是按 omitempty 缺席。桌面端写的就是这一种编码，控制台从此与它一致。
func TestCreateBackend_ThenWritesExactlyTheSharedContractEncoding(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
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
	assert.Equal(t, contractJSON(t, syncwire.AgentBackendPayload{
		Name: "Claude Code", Type: "claudecode",
	}), saved.Payload)
}

// 桌面端写下的满值载荷，控制台只改一个名字：其余十四个键一个不少、一个不变，
// 而且写回去的仍然是契约那一种编码。
func TestUpdateBackend_GivenDesktopWrittenPayload_ThenEveryContractKeySurvivesTheRewrite(t *testing.T) {
	stored := syncwire.AgentBackendPayload{
		Type: "claudecode", Name: "Claude Code", ProviderKey: "anthropic-main", ModelKey: "sonnet",
		ModelRoutes: `{"plan":{"provider_key":"anthropic-main","model_key":"opus"}}`,
		Sandbox:     "workspace-write", Approval: "on-request",
		EnvJSON:               `{"HTTPS_PROXY":"http://127.0.0.1:7890"}`,
		ReasoningEffort:       "high",
		DefaultPermissionMode: "acceptEdits",
		DefaultModel:          "sonnet",
		OpenClawGatewayURL:    "https://gw.example.com",
		OpenClawAgentID:       "agent-9",
		OpenClawDefaultModel:  "gpt-5",
		OpenClawSessionMode:   "resume",
	}

	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	objects.EXPECT().Find(gomock.Any(), int64(7), "backend-1").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		AgentredFingerprint: "sha256:aaaa", Payload: contractJSON(t, stored),
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
	want := stored
	want.Name = "Claude Code 2"
	assert.Equal(t, contractJSON(t, want), saved.Payload)
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
	objects.EXPECT().Find(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
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
	assert.Equal(t, contractJSON(t, want), saved.Payload)

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
	assert.Equal(t, contractJSON(t, syncwire.LLMProviderPayload{
		Name: "Anthropic", Type: "anthropic", BaseURL: "https://api.anthropic.com",
		APIKey: "sk-secret", Enabled: true,
		Models: []syncwire.LLMProviderModel{
			{ModelKey: "sonnet", ModelID: "claude-sonnet-4", Name: "Sonnet", Enabled: true, ContextWindow: 200000, MaxOutput: 8192},
			{ModelKey: "haiku", ModelID: "claude-haiku-4", Name: "Haiku"},
		},
	}), saved.Payload)
}

// 覆盖行的形状同样归契约（agent_backend_cli 只带 cli_path），编码不变，
// 这一条守的是「以后契约改了这边跟着改」。
func TestCreateBackend_GivenCLIPath_ThenTheOverlayIsTheSharedContractEncoding(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
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
