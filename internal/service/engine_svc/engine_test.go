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

func TestCreateBackend_GivenCLIPath_ThenReturnsTheDedicatedPathForbiddenCode(t *testing.T) {
	_, err := New().CreateBackend(context.Background(), BackendWriteInput{
		UserID: 7, Name: stringPtr("Claude Code"), Type: stringPtr("claude"), CLIPath: stringPtr("/usr/local/bin/claude"),
	})
	assert.Equal(t, 30902, engineErrorCode(t, err))
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
