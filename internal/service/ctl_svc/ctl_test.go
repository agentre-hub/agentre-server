package ctl_svc

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/ctl_svc/mock_ctl_svc"
	"github.com/agentre-hub/agentre-server/internal/service/engine_svc"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

const (
	userID      = int64(7)
	agentredID  = int64(3)
	desktopID   = int64(4)
	plainAPIKey = "sk-or-1234567890abcd"
)

// fixture 是一个账号的同步组：两个部门（dept-2 挂在 dept-1 下）、一个 Agent（在 dept-1，
// 执行目标 be-1）、两个后端（都绑在 agentred 上）、一个提供方（一个模型、是默认）、
// 一个项目（成员 agent-1，agentred 上有路径），以及账号里那一个系统 Agent（不属于部门、
// 没有上级）。
func fixtureRows() []*sync_entity.SyncObject {
	return []*sync_entity.SyncObject{
		{ID: 10, Kind: sync_entity.KindDepartment, SyncID: "dept-1", Payload: `{"name":"研发部"}`},
		{ID: 11, Kind: sync_entity.KindDepartment, SyncID: "dept-2", Payload: `{"name":"平台","parent_sync_id":"dept-1"}`},
		{ID: 20, Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: `{"name":"Eva","department_sync_id":"dept-1","pinned":true}`},
		{ID: 30, Kind: sync_entity.KindAgentExecTarget, SyncID: "et-1", Payload: `{"agent_sync_id":"agent-1","backend_sync_id":"be-1","sort_order":0}`},
		{ID: 40, Kind: sync_entity.KindAgentBackend, SyncID: "be-1", AgentredFingerprint: "fp-red",
			Payload: `{"name":"claude-red","type":"claudecode","provider_key":"prov-1","model_key":"mk-1","env_json":"{\"A\":\"1\"}","config":{"sandbox":"workspace"}}`},
		{ID: 41, Kind: sync_entity.KindAgentBackend, SyncID: "be-2", AgentredFingerprint: "fp-red", Payload: `{"name":"codex-red","type":"codex"}`},
		{ID: 42, Kind: sync_entity.KindAgentBackendCLI, SyncID: "cli-1", ScopeSyncID: "be-1", AgentredFingerprint: "fp-red", Payload: `{"cli_path":"/usr/bin/claude"}`},
		{ID: 50, Kind: sync_entity.KindLLMProvider, SyncID: "prov-1", Payload: `{"name":"openrouter","type":"openai","base_url":"https://openrouter.ai/api","api_key":"` + plainAPIKey + `","default_model_key":"mk-1","enabled":true,"models":[{"model_key":"mk-1","model_id":"openai/gpt-5.1","name":"GPT","enabled":true,"context_window":400000}]}`},
		{ID: 60, Kind: sync_entity.KindProject, SyncID: "proj-1", Payload: `{"name":"agentre"}`},
		{ID: 61, Kind: sync_entity.KindProjectAgent, SyncID: "pa-1", Payload: `{"project_sync_id":"proj-1","agent_sync_id":"agent-1"}`},
		{ID: 62, Kind: sync_entity.KindProjectLocation, SyncID: "loc-1", ScopeSyncID: "proj-1", AgentredFingerprint: "fp-red", Payload: `{"path":"/srv/agentre"}`},
		{ID: 19, Kind: sync_entity.KindAgent, SyncID: "agent-sys", Payload: `{"name":"CEO","system_badge":"ceo"}`},
	}
}

type harness struct {
	svc     *ctlSvc
	objects *mock_sync_repo.MockSyncObjectRepo
	org     *mock_ctl_svc.MockOrgWriter
	engine  *mock_ctl_svc.MockEngineWriter
}

func setup(t *testing.T) *harness {
	t.Helper()
	return setupWith(t, fixtureRows())
}

// setupWith 同 setup，只是同步组换成 rows（删除的连带效果要一份专门的组织形状）。
func setupWith(t *testing.T, rows []*sync_entity.SyncObject) *harness {
	t.Helper()
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	device_repo.RegisterDevice(devices)
	objects.EXPECT().ListByKinds(gomock.Any(), userID, readKinds).Return(rows, nil).AnyTimes()
	devices.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{
		{ID: agentredID, UserID: userID, Kind: device_entity.KindAgentred, Fingerprint: "fp-red", Name: "red-box", Status: consts.ACTIVE},
		{ID: desktopID, UserID: userID, Kind: device_entity.KindDesktop, Fingerprint: "fp-mac", Name: "mac", Status: consts.ACTIVE},
	}, nil).AnyTimes()
	h := &harness{objects: objects, org: mock_ctl_svc.NewMockOrgWriter(ctrl), engine: mock_ctl_svc.NewMockEngineWriter(ctrl)}
	h.svc = New(h.org, h.engine).(*ctlSvc)
	h.svc.newKey = func() string { return "mk-new" }
	h.svc.writeBatch = runInline
	return h
}

// runInline 顶替写入批：这里的写端口是 mock，事务与广播由 write_tx_test.go 经真实写路径断言。
func runInline(ctx context.Context, _ int64, fn func(context.Context) error) error { return fn(ctx) }

var fromAgentred = Caller{UserID: userID, DeviceID: agentredID}

func (h *harness) do(t *testing.T, caller Caller, req *agentrewire.CtlRequest, preview bool) (*agentrewire.CtlResponse, error) {
	t.Helper()
	return h.svc.Handle(context.Background(), caller, req, preview)
}

func list(kind agentrewire.CtlKind) *agentrewire.CtlRequest {
	return &agentrewire.CtlRequest{Op: &agentrewire.CtlRequest_List{List: &agentrewire.CtlListRequest{Kind: kind}}}
}

func get(kind agentrewire.CtlKind, id int64) *agentrewire.CtlRequest {
	return &agentrewire.CtlRequest{Op: &agentrewire.CtlRequest_Get{Get: &agentrewire.CtlGetRequest{Kind: kind, Id: id}}}
}

func write(w *agentrewire.CtlWriteRequest) *agentrewire.CtlRequest {
	return &agentrewire.CtlRequest{Op: &agentrewire.CtlRequest_Write{Write: w}}
}

func statusOf(t *testing.T, err error) int {
	t.Helper()
	var e *Error
	require.True(t, errors.As(err, &e), "want *ctl_svc.Error, got %v", err)
	return e.Status
}

func strp(s string) *string { return &s }

// ---- 读 ----

func TestList_GivenProvider_ThenKeyIsMaskedAndPlaintextNeverLeaves(t *testing.T) {
	h := setup(t)
	resp, err := h.do(t, fromAgentred, list(agentrewire.CtlKind_CTL_KIND_PROVIDER), false)
	require.NoError(t, err)
	items := resp.GetList().GetItems()
	require.Len(t, items, 1)
	p := items[0].GetProvider()
	assert.Equal(t, int64(50), p.GetId())
	assert.Equal(t, "sk-o••••••abcd", p.GetApiKey())
	assert.True(t, p.GetApiKeySet())
	assert.Equal(t, int32(1), p.GetBackendRefs())
	raw, err := protojson.Marshal(resp)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), plainAPIKey)
}

func TestGet_GivenAgent_ThenReferencesAreRowIDsInChainOrder(t *testing.T) {
	h := setup(t)
	resp, err := h.do(t, fromAgentred, get(agentrewire.CtlKind_CTL_KIND_AGENT, 20), false)
	require.NoError(t, err)
	a := resp.GetGet().GetResource().GetAgent()
	assert.Equal(t, "Eva", a.GetName())
	assert.Equal(t, int64(10), a.GetDepartmentId())
	assert.Equal(t, []int64{40}, a.GetBackendIds())
	assert.True(t, a.GetPinned())
}

func TestList_GivenModels_ThenIDIsDerivedStablyFromProviderAndKey(t *testing.T) {
	h := setup(t)
	resp, err := h.do(t, fromAgentred, list(agentrewire.CtlKind_CTL_KIND_MODEL), false)
	require.NoError(t, err)
	m := resp.GetList().GetItems()[0].GetModel()
	assert.Equal(t, modelID("prov-1", "mk-1"), m.GetId())
	assert.Positive(t, m.GetId())
	assert.Equal(t, int64(50), m.GetProviderId())
	assert.True(t, m.GetIsDefault())
	assert.Equal(t, int64(400000), m.GetContextWindow())
	assert.Equal(t, int32(1), m.GetBackendRefs())

	again, err := h.do(t, fromAgentred, get(agentrewire.CtlKind_CTL_KIND_MODEL, m.GetId()), false)
	require.NoError(t, err)
	assert.Equal(t, "openai/gpt-5.1", again.GetGet().GetResource().GetModel().GetModelId())
}

func TestGet_GivenProjectAndBackend_ThenCallerLocalValuesAreResolved(t *testing.T) {
	h := setup(t)
	resp, err := h.do(t, fromAgentred, get(agentrewire.CtlKind_CTL_KIND_PROJECT, 60), false)
	require.NoError(t, err)
	p := resp.GetGet().GetResource().GetProject()
	assert.Equal(t, "/srv/agentre", p.GetPath(), "路径是发起请求那台 agentred 上的")
	assert.Equal(t, []int64{20}, p.GetMemberAgentIds())
	require.Len(t, p.GetLocations(), 1)
	assert.Equal(t, "red-box", p.GetLocations()[0].GetDeviceName())

	resp, err = h.do(t, fromAgentred, get(agentrewire.CtlKind_CTL_KIND_BACKEND, 40), false)
	require.NoError(t, err)
	b := resp.GetGet().GetResource().GetBackend()
	assert.Equal(t, "red-box", b.GetDevice())
	assert.Equal(t, int64(50), b.GetProviderId())
	assert.Equal(t, modelID("prov-1", "mk-1"), b.GetModelId())
	assert.Equal(t, "/usr/bin/claude", b.GetCliPath())
	assert.Equal(t, map[string]string{"A": "1"}, b.GetEnv())
	assert.JSONEq(t, `{"sandbox":"workspace"}`, b.GetConfigJson())
	assert.Equal(t, "be-1", b.GetSyncId(), "同步标识原样给出，设备本地凭据按它存取")
	assert.Equal(t, "fp-red", b.GetDeviceFingerprint(), "绑定设备的指纹")
	assert.Equal(t, agentrewire.CtlTokenState_CTL_TOKEN_STATE_UNSPECIFIED, b.GetTokenState(), "claudecode 没有 token")
}

func TestGet_GivenOpenClawBackend_ThenTokenStateIsUnknown(t *testing.T) {
	rows := fixtureRows()
	rows = append(rows, &sync_entity.SyncObject{
		ID: 43, Kind: sync_entity.KindAgentBackend, SyncID: "be-3", AgentredFingerprint: "fp-red",
		Payload: `{"name":"claw-red","type":"openclaw"}`,
	})
	h := setupWith(t, rows)
	resp, err := h.do(t, fromAgentred, get(agentrewire.CtlKind_CTL_KIND_BACKEND, 43), false)
	require.NoError(t, err)
	b := resp.GetGet().GetResource().GetBackend()
	assert.Equal(t, agentrewire.CtlTokenState_CTL_TOKEN_STATE_UNKNOWN, b.GetTokenState(),
		"server 不持有设备本地的 OpenClaw token，只能报未知")
	assert.Equal(t, "be-3", b.GetSyncId())
	assert.Equal(t, "fp-red", b.GetDeviceFingerprint())
}

func TestGet_GivenUnknownIDOrWrongKind_ThenNotFound(t *testing.T) {
	h := setup(t)
	_, err := h.do(t, fromAgentred, get(agentrewire.CtlKind_CTL_KIND_AGENT, 999), false)
	assert.Equal(t, http.StatusNotFound, statusOf(t, err))
	_, err = h.do(t, fromAgentred, get(agentrewire.CtlKind_CTL_KIND_AGENT, 10), false)
	assert.Equal(t, http.StatusNotFound, statusOf(t, err), "部门的 id 不是 Agent")
}

// ---- 写：变更清单与服务调用 ----

func updateProvider() *agentrewire.CtlRequest {
	return write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_PROVIDER, Id: 50,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Provider{Provider: &agentrewire.CtlProvider{
			Name: "or", ApiKey: "sk-new-0000000000000001",
		}}},
		Fields: []string{"name", "apiKey"},
	})
}

func TestWrite_GivenProviderUpdate_ThenEngineGetsOnlyChangedKeysAndSecretIsOnlyMarked(t *testing.T) {
	h := setup(t)
	h.engine.EXPECT().UpdateProvider(gomock.Any(), engine_svc.ProviderWriteInput{
		UserID: userID, ProviderKey: "prov-1", Name: strp("or"), APIKey: strp("sk-new-0000000000000001"),
	}).Return(&engine_svc.ProviderView{}, nil)

	resp, err := h.do(t, fromAgentred, updateProvider(), false)
	require.NoError(t, err)
	w := resp.GetWrite()
	assert.Equal(t, int64(50), w.GetId())
	assert.Equal(t, "openrouter", w.GetName())
	fields := w.GetChanges()[0].GetFields()
	require.Len(t, fields, 2)
	assert.Equal(t, "name", fields[0].GetField())
	assert.Equal(t, "openrouter", fields[0].GetBefore())
	assert.Equal(t, "or", fields[0].GetAfter())
	assert.Equal(t, "apiKey", fields[1].GetField())
	assert.True(t, fields[1].GetSecret())
	assert.Nil(t, fields[1].Before)
	assert.Nil(t, fields[1].After)
	raw, _ := protojson.Marshal(resp)
	assert.NotContains(t, string(raw), "sk-new-0000000000000001")
	assert.NotContains(t, string(raw), plainAPIKey)
}

func TestWrite_GivenPreview_ThenChangesAreComputedButNothingIsWritten(t *testing.T) {
	h := setup(t) // 写端口没有任何期望：被调用即失败
	resp, err := h.do(t, fromAgentred, updateProvider(), true)
	require.NoError(t, err)
	assert.Len(t, resp.GetWrite().GetChanges()[0].GetFields(), 2)
}

func TestWrite_GivenDepartmentCreate_ThenOrgPathCreatesAndNewRowIDIsReturned(t *testing.T) {
	h := setup(t)
	h.org.EXPECT().CreateOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
		UserID: userID, Kind: sync_entity.KindDepartment,
		Fields: map[string]any{"name": "QA", "parent_sync_id": "dept-1"},
	}).Return(&workspace_svc.OrgWriteResult{SyncID: "dept-new", Version: 12}, nil)
	h.objects.EXPECT().Find(gomock.Any(), userID, "dept-new").Return(&sync_entity.SyncObject{ID: 99, SyncID: "dept-new"}, nil)

	resp, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_CREATE, Kind: agentrewire.CtlKind_CTL_KIND_DEPARTMENT,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Department{Department: &agentrewire.CtlDepartment{
			Name: "QA", ParentId: 10,
		}}},
		Fields: []string{"name", "parentId"},
	}), false)
	require.NoError(t, err)
	w := resp.GetWrite()
	assert.Equal(t, int64(99), w.GetId())
	assert.Equal(t, int64(99), w.GetChanges()[0].GetId())
	fields := w.GetChanges()[0].GetFields()
	assert.Equal(t, "研发部", fields[1].GetAfter(), "引用写成对方的名字")
}

func TestWrite_GivenAgentBackendsReordered_ThenMissingTargetIsAddedAndChainReordered(t *testing.T) {
	h := setup(t)
	gomock.InOrder(
		h.org.EXPECT().CreateOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
			UserID: userID, Kind: sync_entity.KindAgentExecTarget,
			Fields: map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "be-2", "sort_order": 0},
		}).Return(&workspace_svc.OrgWriteResult{SyncID: "et-2"}, nil),
		h.org.EXPECT().SetExecTargetOrder(gomock.Any(), workspace_svc.SetExecTargetOrderInput{
			UserID: userID, AgentSyncID: "agent-1", BackendSyncIDs: []string{"be-2", "be-1"},
		}).Return(nil),
	)

	resp, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_AGENT, Id: 20,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Agent{Agent: &agentrewire.CtlAgent{BackendIds: []int64{41, 40}}}},
		Fields:   []string{"backendIds"},
	}), false)
	require.NoError(t, err)
	f := resp.GetWrite().GetChanges()[0].GetFields()[0]
	assert.Equal(t, "claude-red", f.GetBefore())
	assert.Equal(t, "codex-red, claude-red", f.GetAfter())
}

func TestWrite_GivenAgentredCaller_WhenProjectPathSet_ThenLocationIsWrittenForThatMachine(t *testing.T) {
	h := setup(t)
	h.org.EXPECT().SetProjectLocation(gomock.Any(), workspace_svc.SetProjectLocationInput{
		UserID: userID, ProjectSyncID: "proj-1", Fingerprint: "fp-red", Path: "/opt/agentre",
	}).Return(&workspace_svc.OrgWriteResult{}, nil)

	_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_PROJECT, Id: 60,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Project{Project: &agentrewire.CtlProject{Path: "/opt/agentre"}}},
		Fields:   []string{"path"},
	}), false)
	require.NoError(t, err)
}

func TestWrite_GivenMembersAddedAndRemoved_ThenMembershipRowsFollow(t *testing.T) {
	h := setup(t)
	h.org.EXPECT().DeleteOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
		UserID: userID, Kind: sync_entity.KindProjectAgent, SyncID: "pa-1",
	}).Return(&workspace_svc.OrgWriteResult{}, nil)

	_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_PROJECT, Id: 60,
		RemoveMemberAgentIds: []int64{20},
	}), false)
	require.NoError(t, err)
}

func TestWrite_GivenModelCreate_ThenServerGeneratesKeyAndReturnsDerivedID(t *testing.T) {
	h := setup(t)
	h.engine.EXPECT().CreateProviderModel(gomock.Any(), engine_svc.ModelWriteInput{
		UserID: userID, ProviderKey: "prov-1", ModelKey: "mk-new", ModelID: strp("anthropic/claude"),
	}).Return(&engine_svc.ProviderView{}, nil)

	resp, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_CREATE, Kind: agentrewire.CtlKind_CTL_KIND_MODEL,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Model{Model: &agentrewire.CtlModel{
			ProviderId: 50, ModelId: "anthropic/claude",
		}}},
		Fields: []string{"providerId", "modelId"},
	}), false)
	require.NoError(t, err)
	assert.Equal(t, modelID("prov-1", "mk-new"), resp.GetWrite().GetId())
	assert.Equal(t, "openrouter/anthropic/claude", resp.GetWrite().GetName())
}

func TestWrite_GivenBackendMovedByDeviceName_ThenFingerprintIsResolvedAndCardShowsNames(t *testing.T) {
	h := setup(t)
	fp := "fp-mac"
	h.engine.EXPECT().UpdateBackend(gomock.Any(), engine_svc.BackendWriteInput{
		UserID: userID, SyncID: "be-1", DeviceFingerprint: &fp,
	}).Return(&engine_svc.BackendView{}, nil)

	resp, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 40,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{Device: "mac"}}},
		Fields:   []string{"device"},
	}), false)
	require.NoError(t, err)
	f := resp.GetWrite().GetChanges()[0].GetFields()[0]
	assert.Equal(t, "red-box", f.GetBefore())
	assert.Equal(t, "mac", f.GetAfter())
}

func TestWrite_GivenBackendConfigPatch_ThenOnlyPatchedKeysChangeAndWholeConfigIsSent(t *testing.T) {
	h := setup(t)
	fp := "fp-red"
	h.engine.EXPECT().UpdateBackend(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, in engine_svc.BackendWriteInput) (*engine_svc.BackendView, error) {
			assert.Equal(t, &fp, in.DeviceFingerprint, "没改设备就沿用它绑定的那台")
			assert.JSONEq(t, `{"sandbox":"workspace","approval":"never"}`, string(in.Config))
			return &engine_svc.BackendView{}, nil
		})

	resp, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 40,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{ConfigJson: `{"approval":"never"}`}}},
		Fields:   []string{"configJson"},
	}), false)
	require.NoError(t, err)
	f := resp.GetWrite().GetChanges()[0].GetFields()
	require.Len(t, f, 1)
	assert.Equal(t, "config.approval", f[0].GetField())
}

// ---- 删除 ----

func TestWrite_GivenReferencedProvider_ThenDeleteNeedsForce(t *testing.T) {
	h := setup(t)
	del := &agentrewire.CtlWriteRequest{Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_PROVIDER, Id: 50}
	_, err := h.do(t, fromAgentred, write(del), false)
	assert.Equal(t, http.StatusConflict, statusOf(t, err))

	h.engine.EXPECT().DeleteProvider(gomock.Any(), userID, "prov-1").Return(nil)
	del.Force = true
	_, err = h.do(t, fromAgentred, write(del), false)
	require.NoError(t, err)
}

func TestWrite_GivenDepartmentDeleteWithoutCascade_ThenChildrenMoveUpBeforeTombstone(t *testing.T) {
	h := setup(t)
	gomock.InOrder(
		h.org.EXPECT().UpdateOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
			UserID: userID, Kind: sync_entity.KindDepartment, SyncID: "dept-2", Fields: map[string]any{"parent_sync_id": ""},
		}).Return(&workspace_svc.OrgWriteResult{}, nil),
		h.org.EXPECT().UpdateOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
			// 顶层部门没有父部门可上移：它的 Agent 挂到系统 Agent 下（桌面端 department_svc 同口径），
			// 而不是成为既无部门也无上级的孤儿。
			UserID: userID, Kind: sync_entity.KindAgent, SyncID: "agent-1",
			Fields: map[string]any{"department_sync_id": "", "parent_agent_sync_id": "agent-sys"},
		}).Return(&workspace_svc.OrgWriteResult{}, nil),
		h.org.EXPECT().DeleteOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
			UserID: userID, Kind: sync_entity.KindDepartment, SyncID: "dept-1",
		}).Return(&workspace_svc.OrgWriteResult{}, nil),
	)
	_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_DEPARTMENT, Id: 10,
	}), false)
	require.NoError(t, err)
}

func TestWrite_GivenCascadePreview_ThenNoteCountsTheSubtree(t *testing.T) {
	h := setup(t)
	resp, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_DEPARTMENT, Id: 10, Cascade: true,
	}), true)
	require.NoError(t, err)
	assert.Equal(t, "also deletes 1 sub-department and 1 agent", resp.GetWrite().GetChanges()[0].GetNote())
}

// 级联附注的句式是 agentred 还原审批卡数量的约定（agentre 的 transcript/blocks
// .ParseCtlCascadeNote 用的就是下面这个正则）：0、1、多个都得对得上。
func TestWrite_GivenCascadePreview_ThenNoteMatchesAgentredParserForAnyCount(t *testing.T) {
	agentredParser := regexp.MustCompile(`^also deletes (\d+) sub-departments? and (\d+) agents?$`)
	rows := append(fixtureRows(),
		&sync_entity.SyncObject{ID: 12, Kind: sync_entity.KindDepartment, SyncID: "dept-3", Payload: `{"name":"运维","parent_sync_id":"dept-1"}`},
		&sync_entity.SyncObject{ID: 21, Kind: sync_entity.KindAgent, SyncID: "agent-2", Payload: `{"name":"Kai","department_sync_id":"dept-2"}`},
	)
	h := setupWith(t, rows)
	for id, want := range map[int64]string{
		10: "also deletes 2 sub-departments and 2 agents",
		11: "also deletes 0 sub-departments and 1 agent",
		12: "also deletes 0 sub-departments and 0 agents",
	} {
		resp, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_DEPARTMENT, Id: id, Cascade: true,
		}), true)
		require.NoError(t, err)
		note := resp.GetWrite().GetChanges()[0].GetNote()
		assert.Equal(t, want, note)
		assert.Regexp(t, agentredParser, note)
	}
}

// 与桌面端 agent_svc 同口径：Agent 必须挂在一个部门上（或是某个 Agent 的下级）。create 不给
// 部门、update 把部门清成空，都在预览时就拒绝，审批卡不会出现，也不会写出一个在组织里
// 没有位置的 Agent。
func TestWrite_GivenAgentWithoutDepartment_ThenBadRequestInPreviewAndNoWrite(t *testing.T) {
	h := setup(t) // 写端口没有任何期望
	for _, preview := range []bool{true, false} {
		_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_CREATE, Kind: agentrewire.CtlKind_CTL_KIND_AGENT,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Agent{Agent: &agentrewire.CtlAgent{Name: "Kai"}}},
			Fields:   []string{"name"},
		}), preview)
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, statusOf(t, err))
		assert.Contains(t, err.Error(), "department")

		_, err = h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_AGENT, Id: 20,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Agent{Agent: &agentrewire.CtlAgent{}}},
			Fields:   []string{"departmentId"},
		}), preview)
		require.Error(t, err)
		assert.Equal(t, http.StatusBadRequest, statusOf(t, err))
	}
}

// ---- server 路径上不支持的操作 ----

func TestWrite_GivenUnsupportedServerOps_ThenClearRejectionAndNoWrite(t *testing.T) {
	h := setup(t) // 写端口没有任何期望
	_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 40,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{Token: "gw-secret"}}},
		Fields:   []string{"token"},
	}), false)
	assert.Equal(t, http.StatusUnprocessableEntity, statusOf(t, err))
	assert.Contains(t, err.Error(), "OpenClaw token")
	assert.NotContains(t, err.Error(), "gw-secret")

	_, err = h.do(t, Caller{UserID: userID, DeviceID: desktopID}, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_PROJECT, Id: 60,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Project{Project: &agentrewire.CtlProject{Path: "/Users/me/agentre"}}},
		Fields:   []string{"path"},
	}), false)
	assert.Equal(t, http.StatusUnprocessableEntity, statusOf(t, err))
	assert.Contains(t, err.Error(), "desktop")

	assert.Equal(t, http.StatusUnprocessableEntity, statusOf(t, ErrSendUnsupported))
}

func TestWrite_GivenReadOnlyField_ThenBadRequest(t *testing.T) {
	h := setup(t)
	_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_PROVIDER, Id: 50,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Provider{Provider: &agentrewire.CtlProvider{Type: "x"}}},
		Fields:   []string{"type"},
	}), false)
	assert.Equal(t, http.StatusBadRequest, statusOf(t, err))
}

// 两台机器同名时，按指纹指定设备必须落到那一台：解析一次就用那次的指纹，不能再拿
// 规范化后的名字去解析第二遍（那一遍会撞上歧义）。
func TestWrite_GivenTwoDevicesWithSameName_WhenBackendTargetsFingerprint_ThenThatDeviceIsUsed(t *testing.T) {
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	device_repo.RegisterDevice(devices)
	objects.EXPECT().ListByKinds(gomock.Any(), userID, readKinds).Return(fixtureRows(), nil).AnyTimes()
	devices.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{
		{ID: agentredID, UserID: userID, Kind: device_entity.KindAgentred, Fingerprint: "fp-red", Name: "box", Status: consts.ACTIVE},
		{ID: 5, UserID: userID, Kind: device_entity.KindAgentred, Fingerprint: "fp-twin", Name: "box", Status: consts.ACTIVE},
	}, nil).AnyTimes()
	engine := mock_ctl_svc.NewMockEngineWriter(ctrl)
	fp := "fp-twin"
	engine.EXPECT().UpdateBackend(gomock.Any(), engine_svc.BackendWriteInput{
		UserID: userID, SyncID: "be-1", DeviceFingerprint: &fp,
	}).Return(&engine_svc.BackendView{}, nil)

	svc := New(mock_ctl_svc.NewMockOrgWriter(ctrl), engine).(*ctlSvc)
	svc.writeBatch = runInline
	_, err := svc.Handle(context.Background(), fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 40,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{Device: "fp-twin"}}},
		Fields:   []string{"device"},
	}), false)
	require.NoError(t, err)
}

func TestWrite_GivenSubDepartmentDelete_ThenAgentsMoveToParentDepartment(t *testing.T) {
	rows := fixtureRows()
	rows = append(rows, &sync_entity.SyncObject{ID: 22, Kind: sync_entity.KindAgent, SyncID: "agent-2", Payload: `{"name":"Bo","department_sync_id":"dept-2"}`})
	h := setupWith(t, rows)
	gomock.InOrder(
		h.org.EXPECT().UpdateOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
			UserID: userID, Kind: sync_entity.KindAgent, SyncID: "agent-2", Fields: map[string]any{"department_sync_id": "dept-1"},
		}).Return(&workspace_svc.OrgWriteResult{}, nil),
		h.org.EXPECT().DeleteOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
			UserID: userID, Kind: sync_entity.KindDepartment, SyncID: "dept-2",
		}).Return(&workspace_svc.OrgWriteResult{}, nil),
	)
	_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_DEPARTMENT, Id: 11,
	}), false)
	require.NoError(t, err)
}

// ---- 部门环路 ----

func moveDepartment(id, parent int64) *agentrewire.CtlRequest {
	return write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_DEPARTMENT, Id: id,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Department{Department: &agentrewire.CtlDepartment{ParentId: parent}}},
		Fields:   []string{"parentId"},
	})
}

func TestWrite_GivenDepartmentMovedUnderItsOwnDescendant_ThenBadRequestAndNoWrite(t *testing.T) {
	rows := fixtureRows()
	rows = append(rows, &sync_entity.SyncObject{ID: 12, Kind: sync_entity.KindDepartment, SyncID: "dept-3", Payload: `{"name":"基础","parent_sync_id":"dept-2"}`})
	h := setupWith(t, rows) // 写端口没有任何期望：被调用即失败

	for name, parent := range map[string]int64{"self": 10, "child": 11, "grandchild": 12} {
		_, err := h.do(t, fromAgentred, moveDepartment(10, parent), false)
		require.Error(t, err, name)
		assert.Equal(t, http.StatusBadRequest, statusOf(t, err), name)
		assert.Contains(t, err.Error(), "研发部", name)
	}
}

func TestWrite_GivenDepartmentMovedUnderUnrelatedDepartment_ThenParentIsWritten(t *testing.T) {
	rows := fixtureRows()
	rows = append(rows, &sync_entity.SyncObject{ID: 13, Kind: sync_entity.KindDepartment, SyncID: "dept-4", Payload: `{"name":"销售"}`})
	h := setupWith(t, rows)
	h.org.EXPECT().UpdateOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
		UserID: userID, Kind: sync_entity.KindDepartment, SyncID: "dept-2", Fields: map[string]any{"parent_sync_id": "dept-4"},
	}).Return(&workspace_svc.OrgWriteResult{}, nil)

	_, err := h.do(t, fromAgentred, moveDepartment(11, 13), false)
	require.NoError(t, err)
}

// ---- Agent 删除的连带效果 ----

// leadAndReports 在 fixture 上加两处引用 agent-1 的地方：它是 dept-1 的负责人，agent-3
// 是它的下级。
func leadAndReports() []*sync_entity.SyncObject {
	rows := fixtureRows()
	rows[0].Payload = `{"name":"研发部","lead_agent_sync_id":"agent-1"}`
	return append(rows, &sync_entity.SyncObject{ID: 23, Kind: sync_entity.KindAgent, SyncID: "agent-3", Payload: `{"name":"Kai","parent_agent_sync_id":"agent-1"}`})
}

func TestWrite_GivenAgentDelete_ThenLeadIsClearedAndReportsMoveUpBeforeTombstone(t *testing.T) {
	h := setupWith(t, leadAndReports())
	gomock.InOrder(
		h.org.EXPECT().UpdateOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
			UserID: userID, Kind: sync_entity.KindDepartment, SyncID: "dept-1", Fields: map[string]any{"lead_agent_sync_id": ""},
		}).Return(&workspace_svc.OrgWriteResult{}, nil),
		// 下级接替它的位置：它在哪个部门、上级是谁，下级就挂到哪里（桌面端 agent_svc.Delete 同口径）。
		h.org.EXPECT().UpdateOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
			UserID: userID, Kind: sync_entity.KindAgent, SyncID: "agent-3",
			Fields: map[string]any{"department_sync_id": "dept-1", "parent_agent_sync_id": ""},
		}).Return(&workspace_svc.OrgWriteResult{}, nil),
		h.org.EXPECT().DeleteOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
			UserID: userID, Kind: sync_entity.KindAgent, SyncID: "agent-1",
		}).Return(&workspace_svc.OrgWriteResult{}, nil),
	)
	_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_AGENT, Id: 20,
	}), false)
	require.NoError(t, err)
}

func TestWrite_GivenSystemAgentDelete_ThenServiceRefusalPassesThroughAndNothingElseIsTouched(t *testing.T) {
	rows := leadAndReports()
	rows[0].Payload = `{"name":"研发部","lead_agent_sync_id":"agent-sys"}`
	rows = append(rows, &sync_entity.SyncObject{ID: 24, Kind: sync_entity.KindAgent, SyncID: "agent-4", Payload: `{"name":"Lu","parent_agent_sync_id":"agent-sys"}`})
	h := setupWith(t, rows)
	refusal := errors.New("the system agent cannot be deleted or moved")
	h.org.EXPECT().DeleteOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
		UserID: userID, Kind: sync_entity.KindAgent, SyncID: "agent-sys",
	}).Return(nil, refusal) // 没有 UpdateOrgObject 期望：连带改写一条都不能先落

	_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_AGENT, Id: 19,
	}), false)
	assert.ErrorIs(t, err, refusal)
}

// ---- 项目删除 ----

func withSubProject() []*sync_entity.SyncObject {
	return append(fixtureRows(), &sync_entity.SyncObject{ID: 63, Kind: sync_entity.KindProject, SyncID: "proj-2", Payload: `{"name":"web","parent_sync_id":"proj-1"}`})
}

func deleteProject(id int64) *agentrewire.CtlRequest {
	return write(&agentrewire.CtlWriteRequest{Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_PROJECT, Id: id})
}

func TestWrite_GivenProjectWithSubProjects_ThenDeleteIsRefusedInPreviewAndWrite(t *testing.T) {
	h := setupWith(t, withSubProject()) // 写端口没有任何期望：不能静默删掉整棵子树
	for _, preview := range []bool{true, false} {
		_, err := h.do(t, fromAgentred, deleteProject(60), preview)
		require.Error(t, err)
		assert.Equal(t, http.StatusConflict, statusOf(t, err))
		assert.Equal(t, `project "agentre" has sub-projects; delete or move them first`, err.Error())
	}
}

func TestWrite_GivenLeafProject_ThenDeleteGoesThrough(t *testing.T) {
	h := setupWith(t, withSubProject())
	h.org.EXPECT().DeleteOrgObject(gomock.Any(), workspace_svc.OrgWriteInput{
		UserID: userID, Kind: sync_entity.KindProject, SyncID: "proj-2",
	}).Return(&workspace_svc.OrgWriteResult{}, nil)
	_, err := h.do(t, fromAgentred, deleteProject(63), false)
	require.NoError(t, err)
}

// ---- CLI 路径覆盖不在本 spec 内 ----

func TestWrite_GivenBackendCLIPath_ThenReadOnlyBadRequestAndNoWrite(t *testing.T) {
	h := setup(t) // 写端口没有任何期望
	for _, op := range []agentrewire.CtlOp{agentrewire.CtlOp_CTL_OP_UPDATE, agentrewire.CtlOp_CTL_OP_CREATE} {
		_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
			Op: op, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 40,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{
				Name: "x", Type: "claudecode", CliPath: "/opt/claude",
			}}},
			Fields: []string{"name", "type", "cliPath"}[boolToInt(op == agentrewire.CtlOp_CTL_OP_UPDATE)*2:],
		}), false)
		require.Error(t, err, op.String())
		assert.Equal(t, http.StatusBadRequest, statusOf(t, err), op.String())
		assert.Contains(t, err.Error(), "cliPath", op.String())
	}
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// 实测：agentred 会话里 `agrctl create backend --type openclaw`（没给 --config）经 server
// 建出了网关地址为空的行，桌面端永远收不下它。网关地址与桌面端同一规则，在预览（审批卡
// 出现之前）就拒绝，写端口一次都不碰；拒绝带着说明原因的专属码。
func TestWrite_GivenOpenClawBackendWithInvalidGateway_ThenRejectedInPreviewAndNoWrite(t *testing.T) {
	rows := append(fixtureRows(), &sync_entity.SyncObject{
		ID: 43, Kind: sync_entity.KindAgentBackend, SyncID: "be-3", AgentredFingerprint: "fp-red",
		Payload: `{"name":"claw-red","type":"openclaw","config":{"openclawGatewayUrl":"ws://127.0.0.1:18789","openclawSessionMode":"per-agentre-session"}}`,
	})
	h := setupWith(t, rows) // 写端口没有任何期望
	cases := []struct {
		name string
		req  *agentrewire.CtlWriteRequest
		code int
	}{
		{"create without config", &agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_CREATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{
				Name: "claw-self", Type: "openclaw",
			}}},
			Fields: []string{"name", "type"},
		}, code.EngineOpenClawGatewayURLRequired},
		{"create with plaintext remote gateway", &agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_CREATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{
				Name: "claw-self", Type: "openclaw", ConfigJson: `{"openclawGatewayUrl":"ws://gateway.example.com:18789"}`,
			}}},
			Fields: []string{"name", "type", "configJson"},
		}, code.EngineOpenClawGatewayURLPlaintextRemote},
		{"update patching in a credentialed gateway", &agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 43,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{
				ConfigJson: `{"openclawGatewayUrl":"wss://gateway.example.com/?token=secret"}`,
			}}},
			Fields: []string{"configJson"},
		}, code.EngineOpenClawGatewayURLCredentials},
		{"create bound to a provider", &agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_CREATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{
				Name: "claw-self", Type: "openclaw", ProviderId: 50,
				ConfigJson: `{"openclawGatewayUrl":"ws://127.0.0.1:18789"}`,
			}}},
			Fields: []string{"name", "type", "providerId", "configJson"},
		}, code.EngineOpenClawProviderModelNotAllowed},
		{"update adding env", &agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 43,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{
				Env: map[string]string{"TOKEN": "secret"},
			}}},
			Fields: []string{"env"},
		}, code.EngineOpenClawEnvNotAllowed},
		{"update setting reasoning effort", &agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 43,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{
				ReasoningEffort: "high",
			}}},
			Fields: []string{"reasoningEffort"},
		}, code.EngineOpenClawReasoningEffortNotAllowed},
		{"update patching in a sandbox", &agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 43,
			Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Backend{Backend: &agentrewire.CtlBackend{
				ConfigJson: `{"sandbox":"workspace-write"}`,
			}}},
			Fields: []string{"configJson"},
		}, code.EngineOpenClawCLISettingsNotAllowed},
	}
	for _, tc := range cases {
		for _, preview := range []bool{true, false} {
			_, err := h.do(t, fromAgentred, write(tc.req), preview)
			require.Error(t, err, tc.name)
			var he *httputils.Error
			require.True(t, errors.As(err, &he), "%s: want *httputils.Error, got %v", tc.name, err)
			assert.Equal(t, http.StatusBadRequest, he.Status, tc.name)
			assert.Equal(t, tc.code, he.Code, tc.name)
			assert.NotEmpty(t, he.Msg, tc.name)
			assert.NotContains(t, he.Msg, "secret", tc.name)
			// 与桌面端 ctl 同一口径：网关地址被拒时点名 agrctl 该改的 --config 字段。
			gatewayURLReject := tc.code >= code.EngineOpenClawGatewayURLRequired && tc.code <= code.EngineOpenClawGatewayURLPlaintextRemote
			assert.Equal(t, gatewayURLReject, strings.Contains(he.Msg, "(--config openclawGatewayUrl)"), "%s: %s", tc.name, he.Msg)
		}
	}
}

// 已经落在 server 上、桌面端收不下的坏行（网关为空、还绑着供应商）仍然删得掉：删除不做
// config 校验，否则用户没有任何办法清掉它。
func TestWrite_GivenInvalidOpenClawBackendRow_ThenDeleteStillGoesThrough(t *testing.T) {
	rows := append(fixtureRows(), &sync_entity.SyncObject{
		ID: 43, Kind: sync_entity.KindAgentBackend, SyncID: "be-3", AgentredFingerprint: "fp-red",
		Payload: `{"name":"claw-self","type":"openclaw","provider_key":"prov-1","env_json":"","config":{}}`,
	})
	h := setupWith(t, rows)
	h.engine.EXPECT().DeleteBackend(gomock.Any(), userID, "be-3").Return(nil)
	for _, preview := range []bool{true, false} {
		_, err := h.do(t, fromAgentred, write(&agentrewire.CtlWriteRequest{
			Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_BACKEND, Id: 43,
		}), preview)
		require.NoError(t, err)
	}
}
