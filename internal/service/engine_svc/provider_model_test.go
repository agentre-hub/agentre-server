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

// 规格「模型开关」：启用/停用或编辑单个模型只影响该模型，同一供应商的其它模型
// （含页面打开后其它设备新增或改动的）保持服务端当前值。这一组用「stored 里已经有
// 一个请求方根本不知道的模型」模拟「浏览器打开编辑器之后，另一台设备新增/改动了
// 一个模型」，断言那个模型的原始字节（含它自己服务端不认识的键）一个不少地留下。

func twoModelProviderPayload() string {
	return `{"name":"Anthropic","type":"anthropic","base_url":"https://api.anthropic.com","api_key":"sk-secret","default_model_key":"m1","enabled":true,` +
		`"models":[{"model_key":"m1","model_id":"claude-1","name":"Model 1","enabled":true},` +
		`{"model_key":"m2","model_id":"claude-2","name":"Model 2","enabled":true,"future_model_key":"unknown per-model field"}]}`
}

func TestUpdateProviderModel_GivenDisable_ThenLeavesAConcurrentlyAddedModelUntouched(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
		Payload: twoModelProviderPayload(),
	}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	ctx, _ := hubtest.TxDatabase(t)
	enabled := false
	got, err := New().UpdateProviderModel(ctx, ModelWriteInput{
		UserID: 7, ProviderKey: "anthropic-main", ModelKey: "m1", Enabled: &enabled,
	})

	require.NoError(t, err)
	// 目标模型改了,其它字段没动。
	require.Len(t, got.Models, 2)
	assert.False(t, got.Models[0].Enabled)
	assert.Equal(t, "m1", got.Models[0].ModelKey)
	assert.Equal(t, "claude-1", got.Models[0].ModelID)
	// 「其它设备并发新增/改动」的那个模型——连它服务端不认识的键——原封不动。
	assert.JSONEq(t,
		`{"model_key":"m2","model_id":"claude-2","name":"Model 2","enabled":true,"future_model_key":"unknown per-model field"}`,
		rawModelAt(t, saved.Payload, 1))
}

func TestCreateProviderModel_ThenAppendsWithoutTouchingExistingModels(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
		Payload: twoModelProviderPayload(),
	}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	ctx, _ := hubtest.TxDatabase(t)
	got, err := New().CreateProviderModel(ctx, ModelWriteInput{
		UserID: 7, ProviderKey: "anthropic-main", ModelKey: "m3",
		ModelID: stringPtr("claude-3"), Name: stringPtr("Model 3"),
	})

	require.NoError(t, err)
	require.Len(t, got.Models, 3)
	assert.Equal(t, "m3", got.Models[2].ModelKey)
	assert.Equal(t, "claude-3", got.Models[2].ModelID)
	assert.True(t, got.Models[2].Enabled, "新增模型没给 enabled 时默认开启")
	assert.JSONEq(t,
		`{"model_key":"m2","model_id":"claude-2","name":"Model 2","enabled":true,"future_model_key":"unknown per-model field"}`,
		rawModelAt(t, saved.Payload, 1))
}

func TestDeleteProviderModel_ThenRemovesOnlyThatEntry(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
		Payload: twoModelProviderPayload(),
	}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	ctx, _ := hubtest.TxDatabase(t)
	got, err := New().DeleteProviderModel(ctx, 7, "anthropic-main", "m1")

	require.NoError(t, err)
	require.Len(t, got.Models, 1)
	assert.Equal(t, "m2", got.Models[0].ModelKey)
	assert.JSONEq(t,
		`{"model_key":"m2","model_id":"claude-2","name":"Model 2","enabled":true,"future_model_key":"unknown per-model field"}`,
		rawModelAt(t, saved.Payload, 0))
}

func TestUpdateProviderModel_GivenUnknownModelKey_ThenReturnsNotFoundError(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
		Payload: twoModelProviderPayload(),
	}, nil)

	ctx, _ := hubtest.TxDatabase(t)
	enabled := false
	_, err := New().UpdateProviderModel(ctx, ModelWriteInput{
		UserID: 7, ProviderKey: "anthropic-main", ModelKey: "missing", Enabled: &enabled,
	})
	require.Error(t, err)
	assert.Equal(t, code.NotFound, engineErrorCode(t, err))
}

func TestDeleteProviderModel_GivenUnknownModelKey_ThenReturnsNotFoundError(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
		Payload: twoModelProviderPayload(),
	}, nil)

	ctx, _ := hubtest.TxDatabase(t)
	_, err := New().DeleteProviderModel(ctx, 7, "anthropic-main", "missing")
	require.Error(t, err)
	assert.Equal(t, code.NotFound, engineErrorCode(t, err))
}

// 删掉最后一个模型之后 models 仍是空数组而不是 null：契约里 LLMProviderPayload.Models
// 没有 omitempty（桌面端逐字写出 []），newProviderDoc 起手也是 []。落一个 null 进去，
// 载荷的键集就和两端写出的不一样了，而这条通道的整个设计前提是「同一份 JSON，
// 谁写都长一个样」。
func TestDeleteProviderModel_GivenTheLastModel_ThenModelsStaysAnEmptyArray(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	allowSeqLock(states)
	objects.EXPECT().FindForUpdate(gomock.Any(), int64(7), "anthropic-main").Return(&sync_entity.SyncObject{
		ID: 1, UserID: 7, Kind: sync_entity.KindLLMProvider, SyncID: "anthropic-main",
		Payload: `{"name":"Anthropic","type":"anthropic","base_url":"https://api.anthropic.com",` +
			`"api_key":"sk-secret","default_model_key":"m1","enabled":true,` +
			`"models":[{"model_key":"m1","model_id":"claude-1","name":"Model 1","enabled":true}]}`,
	}, nil)
	states.EXPECT().NextVersion(gomock.Any(), int64(7), int64(1)).Return(int64(4), nil)
	var saved *sync_entity.SyncObject
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		saved = row
		return nil
	})

	ctx, _ := hubtest.TxDatabase(t)
	got, err := New().DeleteProviderModel(ctx, 7, "anthropic-main", "m1")

	require.NoError(t, err)
	assert.Empty(t, got.Models)
	doc, ok := parseProviderDoc(saved.Payload)
	require.True(t, ok)
	assert.Equal(t, "[]", string(doc["models"]))
}

// rawModelAt 从落库的供应商载荷里取出 models 数组第 idx 项的原始 JSON 文本,
// 用来断言「没被点名的模型连字节都没动」。
func rawModelAt(t *testing.T, payload string, idx int) string {
	t.Helper()
	doc, ok := parseProviderDoc(payload)
	require.True(t, ok)
	var models []json.RawMessage
	require.NoError(t, json.Unmarshal(doc["models"], &models))
	require.Greater(t, len(models), idx)
	return string(models[idx])
}
