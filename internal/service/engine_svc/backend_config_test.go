package engine_svc

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// ── 后端 config 对象（规格 backend-config-sync「后端读写」）──────────────────
//
// 后端的单类型独占设置在载荷与 web API 上都是一个 config 对象：带就整体替换、
// 不带就保留、不是对象就拒绝且不落库；旧的平铺格式行读出 {}。

// expectLockedBackend 让写入事务里的加锁读取回 payload 这一行（绑定设备 sha256:aaaa）。
func expectLockedBackend(objects *mock_sync_repo.MockSyncObjectRepo, payload string) {
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "backend-1").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
		AgentredFingerprint: "sha256:aaaa", Payload: payload,
	}, nil)
}

// captureSave 接住一次落库（版本号 4），返回落下去的那一行。
func captureSave(objects *mock_sync_repo.MockSyncObjectRepo, states *mock_sync_repo.MockSyncStateRepo) *sync_entity.SyncObject {
	saved := &sync_entity.SyncObject{}
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		*saved = *row
		return nil
	})
	return saved
}

func payloadRaw(t *testing.T, payload, key string) string {
	t.Helper()
	var values map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(payload), &values))
	return string(values[key])
}

func setupBackendWrite(t *testing.T) (context.Context, *gomock.Controller, *mock_sync_repo.MockSyncObjectRepo, *mock_sync_repo.MockSyncStateRepo) {
	t.Helper()
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	ctx, _ := hubtest.TxDatabase(t)
	return ctx, ctrl, objects, states
}

func TestUpdateBackend_GivenConfig_ThenReplacesTheStoredConfigWholesale(t *testing.T) {
	ctx, ctrl, objects, states := setupBackendWrite(t)
	expectLockedBackend(objects, `{"name":"CC","type":"claudecode","config":{"sandbox":"workspace-write","approval":"on-request"}}`)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	saved := captureSave(objects, states)

	got, err := New().UpdateBackend(ctx, BackendWriteInput{
		UserID: 7, SyncID: "backend-1", DeviceFingerprint: stringPtr("sha256:aaaa"),
		Config: json.RawMessage(`{"defaultPermissionMode":"acceptEdits"}`),
	})

	require.NoError(t, err)
	assert.JSONEq(t, `{"defaultPermissionMode":"acceptEdits"}`, payloadRaw(t, saved.Payload, "config"))
	assert.JSONEq(t, `{"defaultPermissionMode":"acceptEdits"}`, string(got.Config))
}

func TestUpdateBackend_GivenNoConfig_ThenKeepsTheStoredConfig(t *testing.T) {
	ctx, ctrl, objects, states := setupBackendWrite(t)
	expectLockedBackend(objects, `{"name":"CC","type":"claudecode","config":{"sandbox":"workspace-write","futureKey":"x"}}`)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	saved := captureSave(objects, states)

	got, err := New().UpdateBackend(ctx, BackendWriteInput{
		UserID: 7, SyncID: "backend-1", Name: stringPtr("CC 2"), DeviceFingerprint: stringPtr("sha256:aaaa"),
	})

	require.NoError(t, err)
	assert.JSONEq(t, `{"sandbox":"workspace-write","futureKey":"x"}`, payloadRaw(t, saved.Payload, "config"))
	assert.JSONEq(t, `{"sandbox":"workspace-write","futureKey":"x"}`, string(got.Config))
	assert.Equal(t, "CC 2", got.Name)
}

// 不是对象的 config（字符串、数组、null）一律拒绝：不加锁读、不取号、不落库。
func TestBackendWrites_GivenNonObjectConfig_ThenRejectWithoutWriting(t *testing.T) {
	for _, raw := range []string{`"sandbox"`, `[]`, `null`, `1`, `{"broken"`} {
		t.Run(raw, func(t *testing.T) {
			ctx, _, _, _ := setupBackendWrite(t)

			_, err := New().UpdateBackend(ctx, BackendWriteInput{
				UserID: 7, SyncID: "backend-1", DeviceFingerprint: stringPtr("sha256:aaaa"),
				Config: json.RawMessage(raw),
			})
			require.Error(t, err)
			assert.Equal(t, code.InvalidParameter, engineErrorCode(t, err))

			_, err = New().CreateBackend(ctx, BackendWriteInput{
				UserID: 7, Name: stringPtr("CC"), Type: stringPtr("claudecode"),
				DeviceFingerprint: stringPtr("sha256:aaaa"), Config: json.RawMessage(raw),
			})
			require.Error(t, err)
			assert.Equal(t, code.InvalidParameter, engineErrorCode(t, err))
		})
	}
}

func TestCreateBackend_GivenConfig_ThenStoresItAsTheConfigObject(t *testing.T) {
	ctx, ctrl, objects, states := setupBackendWrite(t)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	saved := captureSave(objects, states)

	got, err := New().CreateBackend(ctx, BackendWriteInput{
		UserID: 7, Name: stringPtr("Codex"), Type: stringPtr("codex"), DeviceFingerprint: stringPtr("sha256:aaaa"),
		Config: json.RawMessage(`{"sandbox":"workspace-write","modelRoutes":{"OPUS":{"providerKey":"p","modelKey":"m"}}}`),
	})

	require.NoError(t, err)
	assert.JSONEq(t, `{"sandbox":"workspace-write","modelRoutes":{"OPUS":{"providerKey":"p","modelKey":"m"}}}`, payloadRaw(t, saved.Payload, "config"))
	assert.JSONEq(t, `{"sandbox":"workspace-write","modelRoutes":{"OPUS":{"providerKey":"p","modelKey":"m"}}}`, string(got.Config))
}

// 桌面端升级前写下的平铺格式：读出 config 为 {}，整行照常列出、不报错。
func TestListBackends_GivenLegacyFlatRow_ThenReadsConfigAsEmptyObject(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{
		sync_entity.KindAgentBackend, sync_entity.KindAgentBackendCLI, sync_entity.KindAgentExecTarget,
	}).Return([]*sync_entity.SyncObject{{
		Kind: sync_entity.KindAgentBackend, SyncID: "backend-legacy",
		Payload: `{"name":"Codex","type":"codex","model_routes":"{\"OPUS\":{}}","sandbox":"workspace-write","default_permission_mode":"acceptEdits"}`,
	}}, nil)

	got, err := New().ListBackends(context.Background(), 7)

	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Codex", got[0].Name)
	assert.JSONEq(t, `{}`, string(got[0].Config))
}

// 服务端不认识的载荷键（桌面端比服务端 pin 先加的键）在控制台编辑之后原样保留（问题 6）。
func TestUpdateBackend_GivenUnknownPayloadKey_ThenTheKeySurvivesTheEdit(t *testing.T) {
	ctx, ctrl, objects, states := setupBackendWrite(t)
	expectLockedBackend(objects, `{"name":"CC","type":"claudecode","config":{},"future_key":{"nested":[1,2]}}`)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	saved := captureSave(objects, states)

	_, err := New().UpdateBackend(ctx, BackendWriteInput{
		UserID: 7, SyncID: "backend-1", Name: stringPtr("CC 2"), DeviceFingerprint: stringPtr("sha256:aaaa"),
	})

	require.NoError(t, err)
	assert.JSONEq(t, `{"nested":[1,2]}`, payloadRaw(t, saved.Payload, "future_key"))
	assert.Equal(t, `"CC 2"`, payloadRaw(t, saved.Payload, "name"))
}

// 覆盖行同样按键合并：cli_path 之外存着的键原样保留。
func TestUpdateBackend_GivenCLIPath_ThenTheOverlayKeepsUnknownKeys(t *testing.T) {
	ctx, ctrl, objects, states := setupBackendWrite(t)
	expectLockedBackend(objects, `{"name":"CC","type":"claudecode"}`)
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	overlay := &sync_entity.SyncObject{ID: 9, UserID: 7, Kind: sync_entity.KindAgentBackendCLI, SyncID: "overlay-a",
		ScopeSyncID: "backend-1", AgentredFingerprint: "sha256:aaaa", Payload: `{"cli_path":"/old/claude","future_key":true}`}
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{sync_entity.KindAgentBackendCLI}).
		Return([]*sync_entity.SyncObject{overlay}, nil)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "overlay-a").Return(overlay, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil).Times(2)
	var saved []*sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = append(saved, row)
		return nil
	}).Times(2)

	_, err := New().UpdateBackend(ctx, BackendWriteInput{
		UserID: 7, SyncID: "backend-1", DeviceFingerprint: stringPtr("sha256:aaaa"), CLIPath: stringPtr("/opt/claude"),
	})

	require.NoError(t, err)
	require.Len(t, saved, 2)
	assert.JSONEq(t, `{"cli_path":"/opt/claude","future_key":true}`, saved[1].Payload)
}

// 加锁次序：账号序列那一行先锁住，再去锁 sync_objects 的行。
//
// 反过来（先 FOR UPDATE 住要改的那一行、再取号）与设备上行构成环：上行先取整批版本号
// （sync_account_seqs 那一行的 X 锁，持到提交）再写 sync_objects 的各行，两条事务于是
// 各持一把、各等一把，InnoDB 判环回滚其中一条（ERROR 1213）——一次正常的浏览器保存
// 撞上一次正常的设备上行就会失败。约束落在 workspace_svc.WithOrgWriteTx 上，这里钉住
// 后端这条路真的走过它。
func TestUpdateBackend_ThenLocksTheAccountSeqBeforeTheObjectRow(t *testing.T) {
	ctx, trace, ctrl, objects, states := setupEngineTxTest(t)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "backend-1").DoAndReturn(
		func(ctx context.Context, _ int64, _ string) (*sync_entity.SyncObject, error) {
			trace.record(ctx, "FindForUpdate")
			return &sync_entity.SyncObject{ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
				AgentredFingerprint: "sha256:aaaa", Payload: `{"name":"CC","type":"claudecode"}`}, nil
		})
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	expectTracedWrite(trace, objects, states, 4, nil)

	_, err := New().UpdateBackend(ctx, BackendWriteInput{
		UserID: 7, SyncID: "backend-1", Name: stringPtr("CC 2"), DeviceFingerprint: stringPtr("sha256:aaaa"),
	})

	require.NoError(t, err)
	require.GreaterOrEqual(t, len(trace.recorded()), 2)
	assert.Equal(t, "LockAccountSeq inTx=true [BEGIN]", trace.recorded()[0])
	assert.Equal(t, "FindForUpdate inTx=true [BEGIN]", trace.recorded()[1])
}

// 问题 7：改与删的读在写入事务里且带行锁，广播在提交之后。
func TestUpdateBackend_ThenReadsTheRowLockedInsideTheWriteTransaction(t *testing.T) {
	ctx, trace, ctrl, objects, states := setupEngineTxTest(t)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "backend-1").DoAndReturn(
		func(ctx context.Context, _ int64, _ string) (*sync_entity.SyncObject, error) {
			trace.record(ctx, "FindForUpdate")
			return &sync_entity.SyncObject{ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
				AgentredFingerprint: "sha256:aaaa", Payload: `{"name":"CC","type":"claudecode"}`}, nil
		})
	registerActiveDevice(ctrl, 7, "sha256:aaaa")
	expectTracedWrite(trace, objects, states, 4, nil)

	_, err := New().UpdateBackend(ctx, BackendWriteInput{
		UserID: 7, SyncID: "backend-1", Name: stringPtr("CC 2"), DeviceFingerprint: stringPtr("sha256:aaaa"),
	})

	require.NoError(t, err)
	assert.Equal(t, append([]string{committedWriteTrace[0], "FindForUpdate inTx=true [BEGIN]"}, committedWriteTrace[1:]...), trace.recorded())
}

func TestDeleteBackend_ThenReadsTheRowLockedInsideTheWriteTransaction(t *testing.T) {
	ctx, trace, _, objects, states := setupEngineTxTest(t)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "backend-1").DoAndReturn(
		func(ctx context.Context, _ int64, _ string) (*sync_entity.SyncObject, error) {
			trace.record(ctx, "FindForUpdate")
			return &sync_entity.SyncObject{ID: 1, UserID: 7, Kind: sync_entity.KindAgentBackend, SyncID: "backend-1",
				Payload: `{"name":"CC","type":"claudecode","future_key":1}`}, nil
		})
	objects.EXPECT().ListByKinds(gomock.Any(), int64(7), []string{sync_entity.KindAgentExecTarget}).Return(nil, nil)
	expectTracedWrite(trace, objects, states, 5, nil)

	require.NoError(t, New().DeleteBackend(ctx, 7, "backend-1"))
	assert.Equal(t, append([]string{committedWriteTrace[0], "FindForUpdate inTx=true [BEGIN]"}, committedWriteTrace[1:]...), trace.recorded())
}
