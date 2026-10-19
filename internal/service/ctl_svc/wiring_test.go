package ctl_svc

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/cago-frame/cago/pkg/consts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// 写入要照常推进同步版本、广播账号信号（spec「server 执行者」），桌面端与控制台据此
// 实时刷新。这里不替换写端口：默认执行者经真实的 workspace_svc / engine_svc 落库，只有
// 仓储是 mock——断言的是那两条既有写路径真的被走到了，而不是 ctl 自己又写了一遍。

type recordedBroadcast struct {
	mu       sync.Mutex
	versions []int64
}

func (r *recordedBroadcast) Broadcast(_ context.Context, accountID int64, f accountchan_svc.Frame) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if accountID == userID {
		r.versions = append(r.versions, f.Version)
	}
	return nil
}

func (r *recordedBroadcast) Subscribe(context.Context, int64) (accountchan_svc.Subscription, error) {
	return nil, errors.New("not used")
}

func setupWiring(t *testing.T) (context.Context, *mock_sync_repo.MockSyncObjectRepo, *mock_sync_repo.MockSyncStateRepo, *recordedBroadcast) {
	t.Helper()
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	device_repo.RegisterDevice(devices)
	objects.EXPECT().ListByKinds(gomock.Any(), userID, readKinds).Return(fixtureRows(), nil).AnyTimes()
	devices.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{
		{ID: agentredID, UserID: userID, Kind: device_entity.KindAgentred, Fingerprint: "fp-red", Name: "red-box", Status: consts.ACTIVE},
	}, nil).AnyTimes()
	states.EXPECT().LockAccountSeq(gomock.Any(), userID).Return(nil).AnyTimes()
	ctx, _ := hubtest.TxDatabase(t)
	rec := &recordedBroadcast{}
	accountchan_svc.SetDefault(rec)
	t.Cleanup(func() { accountchan_svc.SetDefault(nil) })
	return ctx, objects, states, rec
}

func TestDefaultExecutor_GivenDepartmentRename_ThenSyncVersionAdvancesAndAccountIsSignalled(t *testing.T) {
	ctx, objects, states, rec := setupWiring(t)
	objects.EXPECT().FindForUpdate(gomock.Any(), userID, "dept-1").
		Return(&sync_entity.SyncObject{ID: 10, UserID: userID, Kind: sync_entity.KindDepartment, SyncID: "dept-1", Payload: `{"name":"研发部"}`}, nil)
	states.EXPECT().NextVersion(gomock.Any(), userID, int64(1)).Return(int64(31), nil)
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		assert.Equal(t, int64(31), row.Version)
		assert.JSONEq(t, `{"name":"R&D"}`, row.Payload)
		return nil
	})

	_, err := New(nil, nil).Handle(ctx, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_DEPARTMENT, Id: 10,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Department{Department: &agentrewire.CtlDepartment{Name: "R&D"}}},
		Fields:   []string{"name"},
	}), false)
	require.NoError(t, err)
	assert.Equal(t, []int64{31}, rec.versions)
}

func TestDefaultExecutor_GivenProviderRename_ThenEnginePathBumpsVersionAndSignals(t *testing.T) {
	ctx, objects, states, rec := setupWiring(t)
	provider := fixtureRows()[7]
	require.Equal(t, "prov-1", provider.SyncID)
	objects.EXPECT().FindForUpdate(gomock.Any(), userID, "prov-1").Return(provider, nil)
	states.EXPECT().NextVersion(gomock.Any(), userID, int64(1)).Return(int64(32), nil)
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(func(_ context.Context, row *sync_entity.SyncObject) error {
		assert.Equal(t, int64(32), row.Version)
		assert.Contains(t, row.Payload, `"name":"or"`)
		assert.Contains(t, row.Payload, plainAPIKey, "没写 api key 就保留原值")
		return nil
	})

	_, err := New(nil, nil).Handle(ctx, fromAgentred, write(&agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_PROVIDER, Id: 50,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Provider{Provider: &agentrewire.CtlProvider{Name: "or"}}},
		Fields:   []string{"name"},
	}), false)
	require.NoError(t, err)
	assert.Equal(t, []int64{32}, rec.versions)
}
