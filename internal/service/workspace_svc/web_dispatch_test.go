package workspace_svc

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
)

// cli 设备（agrctl 账号对端）不是执行目标：即便有人把后端指到它的指纹、即便在线查询
// 说它在线，这一档也不可派发、不被选中，且不暴露设备身份。
func TestWebDispatchPlan_GivenBackendPinnedToCLIDevice_ThenNeverAvailableOrChosen(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{"fp-cli": true}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "A"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-cli", AgentredFingerprint: "fp-cli",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-cli", "sort_order": 0})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 50, UserID: 7, Name: "agrctl@laptop", Kind: device_entity.KindCLI, Fingerprint: "fp-cli", Status: 1},
	}, nil)

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{UserID: 7, AgentSyncID: "agent-1"})
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 1)
	assert.Equal(t, AvailabilityUnpaired, plan.Tiers[0].Availability)
	assert.Zero(t, plan.Tiers[0].DeviceID)
	assert.Nil(t, plan.Chosen)
}

// 设备被改名后，派发档里的机器名与设备列表一致：用户设的备注名优先，没设才回落到
// 设备自报的名字（主机名）。否则 agrctl 的「派给 X」「X 离线」说的是另一个名字。
func TestWebDispatchPlan_GivenRenamedDevice_ThenTierCarriesDisplayName(t *testing.T) {
	ctx, mObj, _, mDev, svc := setupWorkspaceTest(t)
	SetOnlineChecker(fakeOnlineChecker{online: map[string]bool{}})

	mObj.EXPECT().ListByKinds(ctx, int64(7), gomock.Any()).Return([]*sync_entity.SyncObject{
		{Kind: sync_entity.KindAgent, SyncID: "agent-1", Payload: mustJSON(t, map[string]any{"name": "A"})},
		{Kind: sync_entity.KindAgentBackend, SyncID: "b-1", AgentredFingerprint: "fp-ad",
			Payload: mustJSON(t, map[string]any{"type": "claude_code"})},
		{Kind: sync_entity.KindAgentExecTarget, SyncID: "t1",
			Payload: mustJSON(t, map[string]any{"agent_sync_id": "agent-1", "backend_sync_id": "b-1", "sort_order": 0})},
	}, nil)
	mDev.EXPECT().ListByUser(ctx, int64(7)).Return([]*device_entity.Device{
		{ID: 51, UserID: 7, Name: "host.local", DisplayName: "verify-box", Kind: device_entity.KindAgentred, Fingerprint: "fp-ad", Status: 1},
	}, nil)

	plan, err := svc.WebDispatchPlan(ctx, WebDispatchPlanInput{UserID: 7, AgentSyncID: "agent-1"})
	require.NoError(t, err)
	require.Len(t, plan.Tiers, 1)
	assert.Equal(t, AvailabilityOffline, plan.Tiers[0].Availability)
	assert.Equal(t, "verify-box", plan.Tiers[0].DeviceName)
}
