package ctl_svc

import (
	"context"
	"errors"
	"slices"
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

// 一次 agrctl 写入涉及多行时（删 Agent 连带摘负责人、上移下级；改执行目标链；删部门的
// 级联或上移；项目连成员带路径；模型连默认模型……），这些行要么一起落、要么一起不落，
// 而且提交之后只广播一次、带这次推进到的最高版本。逐行各自提交会在中途失败时留下一个
// 谁也没要过的中间态（它照常同步到每一台机器上），逐行广播则让每台桌面端为同一次操作
// 白拉 N 次。
//
// 这里走真实的 workspace_svc / engine_svc 写路径，仓储换成一份内存里的同步组
// （memStore）：断言的是事务时序与广播，而不是某一条写路径内部的调用细节。

// memStore 是一个账号的同步组在内存里的样子，外加每一次写发生那一刻的事务状态。
type memStore struct {
	mu       sync.Mutex
	rows     []*sync_entity.SyncObject
	version  int64
	nextID   int64
	txLog    *hubtest.TxLog
	writes   []storeWrite
	failSave string // 落这一行（同步标识）时失败
}

type storeWrite struct {
	syncID string
	inTx   bool
	events []string
}

func (s *memStore) record(ctx context.Context, syncID string) {
	s.writes = append(s.writes, storeWrite{syncID: syncID, inTx: hubtest.InTransaction(ctx), events: s.txLog.Events()})
}

func (s *memStore) find(syncID string) *sync_entity.SyncObject {
	for _, r := range s.rows {
		if r.SyncID == syncID {
			c := *r
			return &c
		}
	}
	return nil
}

func (s *memStore) live(kinds []string) []*sync_entity.SyncObject {
	var out []*sync_entity.SyncObject
	for _, r := range s.rows {
		if !r.IsDeleted() && slices.Contains(kinds, r.Kind) {
			c := *r
			out = append(out, &c)
		}
	}
	return out
}

func (s *memStore) save(ctx context.Context, obj *sync_entity.SyncObject) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.record(ctx, obj.SyncID)
	if obj.SyncID == s.failSave {
		return errors.New("memStore: save failed")
	}
	c := *obj
	for i, r := range s.rows {
		if r.SyncID == obj.SyncID {
			c.ID = r.ID
			s.rows[i] = &c
			return nil
		}
	}
	s.nextID++
	c.ID = s.nextID
	s.rows = append(s.rows, &c)
	return nil
}

func (s *memStore) tombstone(ctx context.Context, id, version, now int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.rows {
		if r.ID == id && !r.IsDeleted() {
			s.record(ctx, r.SyncID)
			r.DeletedAt, r.Version = now, version
			return 1, nil
		}
	}
	return 0, nil
}

// setupStore 装好内存同步组、真实的写路径（New(nil, nil)）与记广播的替身。
func setupStore(t *testing.T, rows []*sync_entity.SyncObject) (context.Context, *memStore, *recordedBroadcast) {
	t.Helper()
	ctrl := gomock.NewController(t)
	objects := mock_sync_repo.NewMockSyncObjectRepo(ctrl)
	states := mock_sync_repo.NewMockSyncStateRepo(ctrl)
	devices := mock_device_repo.NewMockDeviceRepo(ctrl)
	sync_repo.RegisterSyncObject(objects)
	sync_repo.RegisterSyncState(states)
	device_repo.RegisterDevice(devices)
	ctx, txLog := hubtest.TxDatabase(t)
	st := &memStore{rows: rows, version: 100, nextID: 1000, txLog: txLog}

	objects.EXPECT().ListByKinds(gomock.Any(), userID, gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, kinds []string) ([]*sync_entity.SyncObject, error) {
			st.mu.Lock()
			defer st.mu.Unlock()
			return st.live(kinds), nil
		}).AnyTimes()
	findRow := func(_ context.Context, _ int64, syncID string) (*sync_entity.SyncObject, error) {
		st.mu.Lock()
		defer st.mu.Unlock()
		return st.find(syncID), nil
	}
	objects.EXPECT().Find(gomock.Any(), userID, gomock.Any()).DoAndReturn(findRow).AnyTimes()
	objects.EXPECT().FindForUpdate(gomock.Any(), userID, gomock.Any()).DoAndReturn(findRow).AnyTimes()
	objects.EXPECT().FindLocationByNaturalKey(gomock.Any(), userID, gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, project, fp string) (*sync_entity.SyncObject, error) {
			st.mu.Lock()
			defer st.mu.Unlock()
			for _, r := range st.live([]string{sync_entity.KindProjectLocation}) {
				if r.ScopeSyncID == project && r.AgentredFingerprint == fp {
					return r, nil
				}
			}
			return nil, nil
		}).AnyTimes()
	objects.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(st.save).AnyTimes()
	objects.EXPECT().Tombstone(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).DoAndReturn(st.tombstone).AnyTimes()
	states.EXPECT().LockAccountSeq(gomock.Any(), userID).Return(nil).AnyTimes()
	states.EXPECT().NextVersion(gomock.Any(), userID, int64(1)).DoAndReturn(
		func(context.Context, int64, int64) (int64, error) {
			st.mu.Lock()
			defer st.mu.Unlock()
			st.version++
			return st.version, nil
		}).AnyTimes()
	red := &device_entity.Device{ID: agentredID, UserID: userID, Kind: device_entity.KindAgentred, Fingerprint: "fp-red", Name: "red-box", Status: consts.ACTIVE}
	devices.EXPECT().ListByUser(gomock.Any(), userID).Return([]*device_entity.Device{red}, nil).AnyTimes()
	devices.EXPECT().FindByFingerprint(gomock.Any(), userID, "fp-red").Return(red, nil).AnyTimes()

	rec := &recordedBroadcast{}
	accountchan_svc.SetDefault(rec)
	t.Cleanup(func() { accountchan_svc.SetDefault(nil) })
	return ctx, st, rec
}

// assertOneCommitOneSignal：整次写入是一个事务（一次 BEGIN、一次 COMMIT），每一行都
// 落在那一个事务里，提交之后只广播一次、带的是这次推进到的最高版本。
func assertOneCommitOneSignal(t *testing.T, st *memStore, rec *recordedBroadcast, wantWrites []string) {
	t.Helper()
	assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxCommit}, st.txLog.Events(), "整次写入只开一个事务")
	var written []string
	for _, w := range st.writes {
		written = append(written, w.syncID)
		assert.True(t, w.inTx, "%s 落在事务外", w.syncID)
		assert.Equal(t, []string{hubtest.TxBegin}, w.events, "%s 不与其它行同在一个事务里", w.syncID)
	}
	assert.Equal(t, wantWrites, written)
	assert.Equal(t, []int64{st.version}, rec.versions, "提交之后只广播一次，带最高版本")
}

func runWrite(ctx context.Context, req *agentrewire.CtlWriteRequest) error {
	_, err := New(nil, nil).Handle(ctx, fromAgentred, write(req), false)
	return err
}

// 删 Agent：摘掉部门负责人、把直接下级挂到它原来的位置、它的执行目标与项目成员关系
// 落墓碑、它自己落墓碑——一个事务，一次广播。
func TestAtomicWrite_GivenAgentDelete_ThenLeadClearMoveUpCascadeAndTombstoneCommitOnceAndSignalOnce(t *testing.T) {
	rows := fixtureRows()
	rows[0].Payload = `{"name":"研发部","lead_agent_sync_id":"agent-1"}`
	rows = append(rows, &sync_entity.SyncObject{ID: 22, Kind: sync_entity.KindAgent, SyncID: "agent-2", Payload: `{"name":"Bo","parent_agent_sync_id":"agent-1"}`})
	ctx, st, rec := setupStore(t, rows)

	require.NoError(t, runWrite(ctx, &agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_AGENT, Id: 20,
	}))
	assertOneCommitOneSignal(t, st, rec, []string{"dept-1", "agent-2", "et-1", "pa-1", "agent-1"})
}

// 中途任一步失败：整体回滚，一行都不算落，也不广播。
func TestAtomicWrite_GivenAgentDelete_WhenLastRowFails_ThenEverythingRollsBackAndNothingIsSignalled(t *testing.T) {
	rows := fixtureRows()
	rows[0].Payload = `{"name":"研发部","lead_agent_sync_id":"agent-1"}`
	ctx, st, rec := setupStore(t, rows)
	st.failSave = "agent-1"

	err := runWrite(ctx, &agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_AGENT, Id: 20,
	})
	require.Error(t, err)
	assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxRollback}, st.txLog.Events(), "前面落下的负责人清空与级联墓碑一起回滚")
	for _, w := range st.writes {
		assert.Equal(t, []string{hubtest.TxBegin}, w.events, "%s 在别的事务里提交了", w.syncID)
	}
	assert.Empty(t, rec.versions)
}

// 改执行目标链：删掉不再要的档、补上新档，一个事务。
func TestAtomicWrite_GivenAgentBackendsReplaced_ThenDropAndAddCommitOnceAndSignalOnce(t *testing.T) {
	ctx, st, rec := setupStore(t, fixtureRows())

	require.NoError(t, runWrite(ctx, &agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_AGENT, Id: 20,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Agent{Agent: &agentrewire.CtlAgent{BackendIds: []int64{41}}}},
		Fields:   []string{"backendIds"},
	}))
	require.Len(t, st.writes, 2)
	assert.Equal(t, "et-1", st.writes[0].syncID)
	assertOneCommitOneSignal(t, st, rec, []string{"et-1", st.writes[1].syncID})
}

// 新建 Agent 连同执行目标链：Agent 行、两档执行目标，一个事务。
func TestAtomicWrite_GivenAgentCreateWithBackends_ThenAgentAndExecTargetsCommitOnceAndSignalOnce(t *testing.T) {
	ctx, st, rec := setupStore(t, fixtureRows())

	require.NoError(t, runWrite(ctx, &agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_CREATE, Kind: agentrewire.CtlKind_CTL_KIND_AGENT,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Agent{Agent: &agentrewire.CtlAgent{
			Name: "Zed", DepartmentId: 10, BackendIds: []int64{41, 40},
		}}},
		Fields: []string{"name", "departmentId", "backendIds"},
	}))
	require.Len(t, st.writes, 3)
	assertOneCommitOneSignal(t, st, rec, []string{st.writes[0].syncID, st.writes[1].syncID, st.writes[2].syncID})
}

// 级联删部门：子树里的 Agent（连同它们的执行目标与成员关系）、子部门、部门自己。
func TestAtomicWrite_GivenDepartmentCascadeDelete_ThenSubtreeCommitsOnceAndSignalsOnce(t *testing.T) {
	ctx, st, rec := setupStore(t, fixtureRows())

	require.NoError(t, runWrite(ctx, &agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_DEPARTMENT, Id: 10, Cascade: true,
	}))
	assertOneCommitOneSignal(t, st, rec, []string{"et-1", "pa-1", "agent-1", "dept-2", "dept-1"})
}

// 不级联删顶层部门：子部门上移、Agent 挂到系统 Agent 下、部门落墓碑。
func TestAtomicWrite_GivenDepartmentDeleteWithoutCascade_ThenMoveUpAndTombstoneCommitOnceAndSignalOnce(t *testing.T) {
	ctx, st, rec := setupStore(t, fixtureRows())

	require.NoError(t, runWrite(ctx, &agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_DELETE, Kind: agentrewire.CtlKind_CTL_KIND_DEPARTMENT, Id: 10,
	}))
	assertOneCommitOneSignal(t, st, rec, []string{"dept-2", "agent-1", "dept-1"})
}

// 项目成员增减：删一条关系、补一条关系。
func TestAtomicWrite_GivenMembersAddedAndRemoved_ThenMembershipRowsCommitOnceAndSignalOnce(t *testing.T) {
	rows := append(fixtureRows(), &sync_entity.SyncObject{ID: 22, Kind: sync_entity.KindAgent, SyncID: "agent-2", Payload: `{"name":"Bo","department_sync_id":"dept-1"}`})
	ctx, st, rec := setupStore(t, rows)

	require.NoError(t, runWrite(ctx, &agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_UPDATE, Kind: agentrewire.CtlKind_CTL_KIND_PROJECT, Id: 60,
		AddMemberAgentIds: []int64{22}, RemoveMemberAgentIds: []int64{20},
	}))
	require.Len(t, st.writes, 2)
	assertOneCommitOneSignal(t, st, rec, []string{"pa-1", st.writes[1].syncID})
}

// 新建项目连成员带本机路径：项目行、成员关系、路径记录。
func TestAtomicWrite_GivenProjectCreateWithMembersAndPath_ThenAllRowsCommitOnceAndSignalOnce(t *testing.T) {
	ctx, st, rec := setupStore(t, fixtureRows())

	require.NoError(t, runWrite(ctx, &agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_CREATE, Kind: agentrewire.CtlKind_CTL_KIND_PROJECT,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Project{Project: &agentrewire.CtlProject{
			Name: "hub", MemberAgentIds: []int64{20}, Path: "/srv/hub",
		}}},
		Fields: []string{"name", "memberAgentIds", "path"},
	}))
	require.Len(t, st.writes, 3)
	assertOneCommitOneSignal(t, st, rec, []string{st.writes[0].syncID, st.writes[1].syncID, st.writes[2].syncID})
}

// 新建模型并设为默认：供应商行上的模型数组与默认模型键，一个事务。
func TestAtomicWrite_GivenModelCreateAsDefault_ThenModelAndDefaultCommitOnceAndSignalOnce(t *testing.T) {
	ctx, st, rec := setupStore(t, fixtureRows())

	require.NoError(t, runWrite(ctx, &agentrewire.CtlWriteRequest{
		Op: agentrewire.CtlOp_CTL_OP_CREATE, Kind: agentrewire.CtlKind_CTL_KIND_MODEL,
		Resource: &agentrewire.CtlResource{Doc: &agentrewire.CtlResource_Model{Model: &agentrewire.CtlModel{
			ProviderId: 50, ModelId: "anthropic/claude", IsDefault: true,
		}}},
		Fields: []string{"providerId", "modelId", "isDefault"},
	}))
	assertOneCommitOneSignal(t, st, rec, []string{"prov-1", "prov-1"})
}
