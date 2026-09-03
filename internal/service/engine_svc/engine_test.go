package engine_svc

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
)

// registerActiveDevice 让 (userID, fingerprint) 在 device_repo 里解出一台账号内的活跃设备，
// 给后端写入路径的运行设备校验用。
func registerActiveDevice(ctrl *gomock.Controller, userID int64, fingerprint string) {
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(devices)
	devices.EXPECT().FindByFingerprint(gomock.Any(), userID, fingerprint).
		Return(&device_entity.Device{UserID: userID, Fingerprint: fingerprint, Status: consts.ACTIVE}, nil)
}

func TestCreateProvider_GivenNoAPIKey_ThenRejectsTheIncompleteProvider(t *testing.T) {
	errSvc := New()
	_, err := errSvc.CreateProvider(context.Background(), ProviderWriteInput{
		UserID: 7, Name: stringPtr("Anthropic"), Type: stringPtr("anthropic"), BaseURL: stringPtr("https://api.anthropic.com"),
	})
	require.Error(t, err)
}

// 账号级对象不依赖任何登记设备：用户可在 browser 先配置，后续设备再拉快照。
func TestCreateProvider_GivenNoRegisteredDevice_ThenPersistsTheAccountObject(t *testing.T) {
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

	got, err := New().CreateProvider(context.Background(), ProviderWriteInput{
		UserID: 7, Name: stringPtr("Anthropic"), Type: stringPtr("anthropic"),
		BaseURL: stringPtr("https://api.anthropic.com"), APIKey: stringPtr("sk-secret"),
	})

	require.NoError(t, err)
	assert.NotEmpty(t, got.ProviderKey)
	assert.Equal(t, sync_entity.KindLLMProvider, saved.Kind)
	assert.Equal(t, ServerOriginFingerprint, saved.OriginFingerprint)
}

func TestCreateBackend_GivenNoRegisteredDevice_ThenPersistsTheAccountIdentity(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	registerActiveDevice(ctrl, 7, "fp-account")
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(3), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	got, err := New().CreateBackend(context.Background(), BackendWriteInput{
		UserID: 7, Name: stringPtr("Claude Code"), Type: stringPtr("claude"), DeviceID: stringPtr("fp-account"),
	})

	require.NoError(t, err)
	assert.NotEmpty(t, got.SyncID)
	assert.Equal(t, sync_entity.KindAgentBackend, saved.Kind)
	assert.Equal(t, ServerOriginFingerprint, saved.OriginFingerprint)
}

// 决策 5：运行设备必填，没有机器就没有这一套安装——服务端拒绝缺设备的写入。
func TestCreateBackend_GivenNoDeviceID_ThenRejectsTheIncompleteBackend(t *testing.T) {
	_, err := New().CreateBackend(context.Background(), BackendWriteInput{
		UserID: 7, Name: stringPtr("Claude Code"), Type: stringPtr("claude"),
	})
	require.Error(t, err)
	assert.Equal(t, code.InvalidParameter, engineErrorCode(t, err))
}

// 所选设备在编辑期间被撤销/在这个账号下根本不存在：保存时如实报「该设备已不在
// 账号内」，而不是静默落一个指向撤销设备的取值——这条码要能跟「没填设备」的
// InvalidParameter 分开，好让浏览器区分「请选设备」与「该设备已不在账号内」。
func TestCreateBackend_GivenFingerprintNotInAccount_ThenReturnsTheDedicatedDeviceNotFoundCode(t *testing.T) {
	ctrl := gomock.NewController(t)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(devices)
	devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "sha256:unknown").Return(nil, nil)

	_, err := New().CreateBackend(context.Background(), BackendWriteInput{
		UserID: 7, Name: stringPtr("Claude Code"), Type: stringPtr("claude"), DeviceID: stringPtr("sha256:unknown"),
	})
	require.Error(t, err)
	got := engineErrorCode(t, err)
	assert.Equal(t, code.EngineBackendDeviceNotFound, got)
	assert.NotEqual(t, code.InvalidParameter, got)
}

// 撤销留下的是一台状态非活跃的设备行，不是查不到——两种情形都必须拒同一个码。
func TestUpdateBackend_GivenRevokedDeviceFingerprint_ThenReturnsTheDedicatedDeviceNotFoundCode(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().Find(gomock.Any(), int64(7), "backend-1").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		AgentredFingerprint: "sha256:aaaa",
		Payload:             `{"name":"Claude Code","type":"claude"}`,
	}, nil)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	device_repo.RegisterDevice(devices)
	devices.EXPECT().FindByFingerprint(gomock.Any(), int64(7), "sha256:aaaa").
		Return(&device_entity.Device{UserID: 7, Fingerprint: "sha256:aaaa", Status: consts.DELETE}, nil)

	_, err := New().UpdateBackend(context.Background(), BackendWriteInput{
		UserID: 7, SyncID: "backend-1", DeviceID: stringPtr("sha256:aaaa"),
	})
	require.Error(t, err)
	assert.Equal(t, code.EngineBackendDeviceNotFound, engineErrorCode(t, err))
}

// 运行设备走既有列 sync_objects.agentred_fingerprint，不是 agent_backend 载荷里的一个键。
func TestCreateBackend_GivenDeviceID_ThenWritesTheFingerprintColumnNotThePayload(t *testing.T) {
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

	got, err := New().CreateBackend(context.Background(), BackendWriteInput{
		UserID: 7, Name: stringPtr("Claude Code"), Type: stringPtr("claude"), DeviceID: stringPtr("sha256:aaaa"),
	})

	require.NoError(t, err)
	assert.Equal(t, "sha256:aaaa", saved.AgentredFingerprint)
	assert.NotContains(t, saved.Payload, "device_id")
	assert.Equal(t, "sha256:aaaa", got.DeviceID)
}

// 编辑既有后端换一台机器：指纹改写，其它字段不受影响。
func TestUpdateBackend_GivenNewDeviceID_ThenRewritesFingerprintWithoutLosingOtherFields(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	objects.EXPECT().Find(gomock.Any(), int64(7), "backend-1").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		AgentredFingerprint: "sha256:aaaa",
		Payload:             `{"name":"Claude Code","type":"claude"}`,
	}, nil)
	registerActiveDevice(ctrl, 7, "sha256:bbbb")
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	got, err := New().UpdateBackend(context.Background(), BackendWriteInput{
		UserID: 7, SyncID: "backend-1", DeviceID: stringPtr("sha256:bbbb"),
	})

	require.NoError(t, err)
	assert.Equal(t, "sha256:bbbb", saved.AgentredFingerprint)
	assert.Equal(t, "sha256:bbbb", got.DeviceID)
	assert.Equal(t, "Claude Code", got.Name)
	assert.Equal(t, "claude", got.Type)
}

// 存量行没有登记设备：读回原样是空指纹，不被悄悄补一台机器。
func TestListBackends_GivenLegacyRowWithoutDevice_ThenReadsBackEmptyDeviceID(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{
		sync_entity.KindAgentBackend, sync_entity.KindAgentBackendCLI, sync_entity.KindAgentExecTarget,
	}).Return([]*sync_entity.SyncObject{{
		Kind: sync_entity.KindAgentBackend, SyncID: "backend-legacy",
		Payload: `{"name":"Legacy","type":"claude"}`,
	}}, nil)

	got, err := New().ListBackends(context.Background(), 7)

	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Empty(t, got[0].DeviceID)
}

func TestUpdateProvider_GivenEmptyAPIKey_ThenPreservesStoredCredential(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)

	objects.EXPECT().Find(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
		Payload: `{"name":"Anthropic","type":"anthropic","base_url":"https://api.anthropic.com","api_key":"sk-old"}`,
	}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(3), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	got, err := New().UpdateProvider(context.Background(), ProviderWriteInput{
		UserID: 7, ProviderKey: "anthropic-main", Name: stringPtr("Anthropic 2"), APIKey: stringPtr(""),
	})
	require.NoError(t, err)
	assert.Equal(t, "sk-old", payloadString(t, saved.Payload, "api_key"))
	assert.Equal(t, "Anthropic 2", got.Name)
	assert.Equal(t, "-old", got.MaskedTail)
}

func TestListBackends_GivenAdvancedAccountSettings_ThenReturnsThemForBrowserEdits(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{
		sync_entity.KindAgentBackend, sync_entity.KindAgentBackendCLI, sync_entity.KindAgentExecTarget,
	}).Return([]*sync_entity.SyncObject{{
		Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		Payload: `{"name":"Codex","type":"codex","model_routes":"{\"OPUS\":{\"providerKey\":\"openai-main\",\"modelKey\":\"gpt-5\"}}","sandbox":"workspace-write","approval":"on-request","reasoning_effort":"high","default_permission_mode":"acceptEdits","default_model":"gpt-5"}`,
	}}, nil)

	got, err := New().ListBackends(context.Background(), 7)

	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "{\"OPUS\":{\"providerKey\":\"openai-main\",\"modelKey\":\"gpt-5\"}}", got[0].ModelRoutes)
	assert.Equal(t, "workspace-write", got[0].Sandbox)
	assert.Equal(t, "on-request", got[0].Approval)
	assert.Equal(t, "high", got[0].ReasoningEffort)
	assert.Equal(t, "acceptEdits", got[0].DefaultPermissionMode)
	assert.Equal(t, "gpt-5", got[0].DefaultModel)
}

func TestSnapshot_GivenTwoDeviceOverlays_ThenReturnsOnlyCallersPathAndProviderKey(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{
		sync_entity.KindLLMProvider, sync_entity.KindAgentBackendCLI,
	}).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main", Payload: `{"name":"Anthropic","api_key":"sk-secret"}`},
		{Kind: sync_entity.KindAgentBackendCLI, ProjectSyncID: "backend-1", AgentredFingerprint: "fp-1", Payload: `{"cli_path":"/usr/local/bin/claude"}`},
		{Kind: sync_entity.KindAgentBackendCLI, ProjectSyncID: "backend-1", AgentredFingerprint: "fp-2", Payload: `{"cli_path":"/opt/claude"}`},
	}, nil)

	got, err := New().Snapshot(context.Background(), 7, "fp-1")
	require.NoError(t, err)
	require.Len(t, got.Providers, 1)
	assert.Equal(t, "sk-secret", got.Providers[0].APIKey)
	require.Len(t, got.CLIOverlays, 1)
	assert.Equal(t, "/usr/local/bin/claude", got.CLIOverlays[0].CLIPath)
}

// 引擎拒绝原因要有稳定业务码：控制台据此既不把本机路径误报成普通表单错误，
// 也不让将来改文案影响调用方。
func TestUpdateProvider_GivenUnknownKey_ThenReturnsTheDedicatedProviderNotFoundCode(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().Find(gomock.Any(), int64(7), "missing").Return(nil, nil)

	_, err := New().UpdateProvider(context.Background(), ProviderWriteInput{UserID: 7, ProviderKey: "missing"})
	assert.Equal(t, 30900, engineErrorCode(t, err))
}

func TestUpdateBackend_GivenUnknownID_ThenReturnsTheDedicatedBackendNotFoundCode(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().Find(gomock.Any(), int64(7), "missing").Return(nil, nil)

	_, err := New().UpdateBackend(context.Background(), BackendWriteInput{UserID: 7, SyncID: "missing"})
	assert.Equal(t, 30901, engineErrorCode(t, err))
}

func TestCreateBackend_GivenBuiltinType_ThenReturnsTheDedicatedBuiltinForbiddenCode(t *testing.T) {
	_, err := New().CreateBackend(context.Background(), BackendWriteInput{
		UserID: 7, Name: stringPtr("Builtin"), Type: stringPtr("builtin"),
	})
	assert.Equal(t, 30903, engineErrorCode(t, err))
}

func engineErrorCode(t *testing.T, err error) int {
	t.Helper()
	var httpErr *httputils.Error
	if !errors.As(err, &httpErr) {
		t.Fatalf("expected httputils.Error, got %T: %v", err, err)
	}
	return httpErr.Code
}

func stringPtr(v string) *string { return &v }

func payloadString(t *testing.T, payload, key string) string {
	t.Helper()
	var values map[string]any
	require.NoError(t, json.Unmarshal([]byte(payload), &values))
	got, _ := values[key].(string)
	return got
}

// ── env_json 整表读写（控制台与桌面端对齐）──────────────────────────────────
//
// 这张表此前不下发浏览器：控制台看不到用户在桌面端填过的透传环境变量，也就改不了，
// 只能通过一个只收 sync_id 的专用接口补一个固定键（已随本轮删除）。
// 本轮按「两个入口一份能力」放开整表。

// 读侧：存量后端里填过的表原样读回，控制台据此渲染编辑器。
func TestListBackends_GivenEnvJSON_ThenReturnsTheTableForBrowserEdits(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{
		sync_entity.KindAgentBackend, sync_entity.KindAgentBackendCLI, sync_entity.KindAgentExecTarget,
	}).Return([]*sync_entity.SyncObject{{
		Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		Payload: `{"name":"CC","type":"claudecode","env_json":"{\"HTTPS_PROXY\":\"http://127.0.0.1:7890\"}"}`,
	}}, nil)

	got, err := New().ListBackends(context.Background(), 7)

	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.JSONEq(t, `{"HTTPS_PROXY":"http://127.0.0.1:7890"}`, got[0].EnvJSON)
}

// 写侧：给了就是整表覆写，和桌面端同一套语义——编辑器把读到的表读进 entries，
// 保存时把 entries 序列化回来。删掉一个键，保存后它就该没了。
func TestUpdateBackend_GivenEnvJSON_ThenReplacesTheWholeTable(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	objects.EXPECT().Find(gomock.Any(), int64(7), "backend-1").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		AgentredFingerprint: "sha256:aaaa",
		Payload:             `{"name":"CC","type":"claudecode","env_json":"{\"HTTPS_PROXY\":\"http://127.0.0.1:7890\",\"STALE\":\"1\"}"}`,
	}, nil)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	got, err := New().UpdateBackend(context.Background(), BackendWriteInput{
		UserID: 7, SyncID: "backend-1", DeviceID: stringPtr("sha256:aaaa"),
		EnvJSON: stringPtr(`{"HTTPS_PROXY":"http://127.0.0.1:7890","IS_SANDBOX":"1"}`),
	})

	require.NoError(t, err)
	assert.JSONEq(t, `{"HTTPS_PROXY":"http://127.0.0.1:7890","IS_SANDBOX":"1"}`, payloadString(t, saved.Payload, "env_json"))
	assert.JSONEq(t, `{"HTTPS_PROXY":"http://127.0.0.1:7890","IS_SANDBOX":"1"}`, got.EnvJSON)
}

// **整表覆写的代价全在这一条上。** 不带这个字段的 PATCH（比如只换执行设备）不能把
// 存着的表顺手抹掉——`applyBackend` 逐字段判 nil 就是为了这个，这里把它钉住。
func TestUpdateBackend_GivenNoEnvJSON_ThenKeepsTheStoredTable(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	objects.EXPECT().Find(gomock.Any(), int64(7), "backend-1").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		AgentredFingerprint: "sha256:aaaa",
		Payload:             `{"name":"CC","type":"claudecode","env_json":"{\"MY_TOKEN\":\"s3cret\"}"}`,
	}, nil)
	registerActiveDevice(ctrl, 7, "sha256:bbbb")
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	_, err := New().UpdateBackend(context.Background(), BackendWriteInput{
		UserID: 7, SyncID: "backend-1", DeviceID: stringPtr("sha256:bbbb"),
	})

	require.NoError(t, err)
	assert.JSONEq(t, `{"MY_TOKEN":"s3cret"}`, payloadString(t, saved.Payload, "env_json"))
}

// ── cli_path 的按设备覆盖（控制台与桌面端对齐）────────────────────────────────
//
// cli_path 不在 backend 载荷里，它是一条独立的 agent_backend_cli 同步对象，身份是
// (backend 同步标识, 机器指纹)——同一条后端在不同机器上各有一个可执行文件路径。
// 控制台此前连提交都被拒（EngineCLIPathForbidden），于是网页上建的后端永远配不出
// 路径。放开之后落在**这条后端绑定的那台设备**上（决策 5 已要求运行设备必填）。

// 新建：后端行之外再落一条覆盖行，身份是 (backend, 绑定设备)。
func TestCreateBackend_GivenCLIPath_ThenWritesThePerDeviceOverlay(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	// 覆盖行要先看这台机器上有没有既存的一条
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{sync_entity.KindAgentBackendCLI}).
		Return([]*sync_entity.SyncObject{}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(3), nil).Times(2)
	var saved []*sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = append(saved, row)
		return nil
	}).Times(2)

	_, err := New().CreateBackend(context.Background(), BackendWriteInput{
		UserID: 7, Name: stringPtr("Claude Code"), Type: stringPtr("claudecode"),
		DeviceID: stringPtr("sha256:aaaa"), CLIPath: stringPtr("/usr/local/bin/claude"),
	})

	require.NoError(t, err)
	require.Len(t, saved, 2)
	backendRow := saved[0]
	overlay := saved[1]
	assert.Equal(t, sync_entity.KindAgentBackend, backendRow.Kind)
	// 路径不进 backend 载荷——它不是后端配置的一部分，而是那台机器上的东西
	assert.NotContains(t, backendRow.Payload, "cli_path")
	assert.Equal(t, sync_entity.KindAgentBackendCLI, overlay.Kind)
	assert.Equal(t, backendRow.SyncID, overlay.ProjectSyncID)
	assert.Equal(t, "sha256:aaaa", overlay.AgentredFingerprint)
	assert.JSONEq(t, `{"cli_path":"/usr/local/bin/claude"}`, overlay.Payload)
}

// 编辑：改的是绑定设备上那一条，**别的机器上的覆盖一个字不动**。
// 这是整件事最容易写错的地方：cli_path 按机器分身，拿 backend 同步标识当唯一键
// 就会把用户在另一台机器上填的路径覆盖掉。
func TestUpdateBackend_GivenCLIPath_ThenRewritesOnlyTheBoundDeviceOverlay(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	objects.EXPECT().Find(gomock.Any(), int64(7), "backend-1").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		AgentredFingerprint: "sha256:aaaa",
		Payload:             `{"name":"CC","type":"claudecode"}`,
	}, nil)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{sync_entity.KindAgentBackendCLI}).
		Return([]*sync_entity.SyncObject{
			{ID: 9, UserID: 7, Kind: sync_entity.KindAgentBackendCLI, SyncID: "overlay-a",
				ProjectSyncID: "backend-1", AgentredFingerprint: "sha256:aaaa", Payload: `{"cli_path":"/old/claude"}`},
			{ID: 10, UserID: 7, Kind: sync_entity.KindAgentBackendCLI, SyncID: "overlay-b",
				ProjectSyncID: "backend-1", AgentredFingerprint: "sha256:bbbb", Payload: `{"cli_path":"/other/machine/claude"}`},
		}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil).Times(2)
	var saved []*sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = append(saved, row)
		return nil
	}).Times(2)

	_, err := New().UpdateBackend(context.Background(), BackendWriteInput{
		UserID: 7, SyncID: "backend-1", DeviceID: stringPtr("sha256:aaaa"),
		CLIPath: stringPtr("/opt/homebrew/bin/claude"),
	})

	require.NoError(t, err)
	require.Len(t, saved, 2)
	overlay := saved[1]
	assert.Equal(t, "overlay-a", overlay.SyncID, "改的必须是绑定设备上那一条既存覆盖")
	assert.JSONEq(t, `{"cli_path":"/opt/homebrew/bin/claude"}`, overlay.Payload)
}

// 不带 cli_path 的写（改名、换模型）不碰覆盖行——一次都不该多存。
func TestUpdateBackend_GivenNoCLIPath_ThenLeavesTheOverlayAlone(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	objects.EXPECT().Find(gomock.Any(), int64(7), "backend-1").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		AgentredFingerprint: "sha256:aaaa", Payload: `{"name":"CC","type":"claudecode"}`,
	}, nil)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).Return(nil).Times(1)

	_, err := New().UpdateBackend(context.Background(), BackendWriteInput{
		UserID: 7, SyncID: "backend-1", Name: stringPtr("CC 2"), DeviceID: stringPtr("sha256:aaaa"),
	})

	require.NoError(t, err)
}

// 读侧：路径随覆盖清单下发，控制台开编辑器时按 (backend, 绑定设备) 取回它。
func TestListCLIOverlays_ThenReturnsThePathForBrowserEdits(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{sync_entity.KindAgentBackendCLI}).
		Return([]*sync_entity.SyncObject{{
			Kind: sync_entity.KindAgentBackendCLI, ProjectSyncID: "backend-1",
			AgentredFingerprint: "sha256:aaaa", Payload: `{"cli_path":"/usr/local/bin/claude"}`,
		}}, nil)

	got, err := New().ListCLIOverlays(context.Background(), 7)

	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "/usr/local/bin/claude", got[0].CLIPath)
}
