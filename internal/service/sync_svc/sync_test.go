package sync_svc

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/sync_entity"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/repository/sync_repo"
	"agentre-server/internal/repository/sync_repo/mock_sync_repo"
	hubtest "agentre-server/internal/testutils"
)

const (
	testUserID   = int64(7)
	testDeviceID = int64(2)
	testNow      = int64(1_700_000_000_000)
)

type syncMocks struct {
	object    *mock_sync_repo.MockSyncObjectRepo
	state     *mock_sync_repo.MockSyncStateRepo
	avatar    *mock_sync_repo.MockSyncAvatarRepo
	localPath *mock_sync_repo.MockSyncLocalPathRepo
	sql       sqlmock.Sqlmock
}

func setupSyncTest(t *testing.T) (context.Context, *syncMocks, *syncSvc) {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)

	m := &syncMocks{
		object:    mock_sync_repo.NewMockSyncObjectRepo(ctrl),
		state:     mock_sync_repo.NewMockSyncStateRepo(ctrl),
		avatar:    mock_sync_repo.NewMockSyncAvatarRepo(ctrl),
		localPath: mock_sync_repo.NewMockSyncLocalPathRepo(ctrl),
	}
	sync_repo.RegisterSyncObject(m.object)
	sync_repo.RegisterSyncState(m.state)
	sync_repo.RegisterSyncAvatar(m.avatar)
	sync_repo.RegisterSyncLocalPath(m.localPath)

	ctx, _, sqlMock := hubtest.DatabasePG(t)
	m.sql = sqlMock

	svc := newSyncSvc()
	svc.now = func() int64 { return testNow }
	return ctx, m, svc
}

// expectTx 给 Push 外层的事务备好 Begin/Commit。
func expectTx(m *syncMocks) {
	m.sql.ExpectBegin()
	m.sql.ExpectCommit()
}

// onlineDevice 让这台设备刚刚同步过，不落进 R6a 的超窗口分支。
func onlineDevice(m *syncMocks) {
	m.state.EXPECT().FindDeviceState(gomock.Any(), testUserID, testDeviceID).
		Return(&sync_entity.DeviceSyncState{UserID: testUserID, DeviceID: testDeviceID, LastSyncAt: testNow - 60_000}, nil)
}

func captureSave(m *syncMocks, saved *[]*sync_entity.SyncObject) *gomock.Call {
	return m.object.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, obj *sync_entity.SyncObject) error {
			cp := *obj
			*saved = append(*saved, &cp)
			return nil
		},
	)
}

func errCode(t *testing.T, err error) int {
	t.Helper()
	var he *httputils.Error
	if !errors.As(err, &he) {
		t.Fatalf("期望 httputils.Error，实际 %T: %v", err, err)
	}
	return he.Code
}

func projectItem(syncID string, base int64) PushItem {
	return PushItem{
		Kind:        sync_entity.KindProject,
		SyncID:      syncID,
		BaseVersion: base,
		UpdatedAt:   testNow,
		Payload:     []byte(`{"name":"alpha"}`),
	}
}

// R4a 第一条：基版本等于该行当前版本 → 正常接受，分配新版本号。
func TestPush_GivenBaseVersionMatchesCurrent_ThenAccepted(t *testing.T) {
	convey.Convey("基版本与当前版本相符", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-p1").Return(&sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 7, SourceDeviceID: 9,
		}, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-p1", 7)}})

		assert.NoError(t, err)
		assert.Len(t, out.Results, 1)
		assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
		assert.Equal(t, int64(8), out.Results[0].Version)
		assert.Zero(t, out.Results[0].OverwrittenVersion)
		assert.Zero(t, out.Results[0].OverwrittenDeviceID)
		assert.Len(t, saved, 1)
		assert.Equal(t, int64(8), saved[0].Version)
		assert.Equal(t, testDeviceID, saved[0].SourceDeviceID)
		assert.NoError(t, m.sql.ExpectationsWereMet())
	})
}

// R4a 第二条：基版本与当前版本不符 → 判为冲突，本次上行照常生效，
// 但要回报被覆盖的是哪一版、来自哪台设备（R5 的追回承诺靠它兑现）。
func TestPush_GivenStaleBaseVersion_ThenAcceptedAndReportsOverwritten(t *testing.T) {
	convey.Convey("基版本落后于当前版本", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-p1").Return(&sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 7, SourceDeviceID: 9,
		}, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-p1", 5)}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusConflict, out.Results[0].Status)
		assert.Equal(t, int64(7), out.Results[0].OverwrittenVersion)
		assert.Equal(t, int64(9), out.Results[0].OverwrittenDeviceID)
		// 后到者仍然胜出：这一版照常落库。
		assert.Equal(t, int64(8), out.Results[0].Version)
		assert.Len(t, saved, 1)
	})
}

// R4a 第三条：基版本为空但该同步标识在 server 上已存在 → 同样按冲突处理，
// 否则两端会各自「新建」出同一个标识。
func TestPush_GivenEmptyBaseVersionOnExistingSyncID_ThenTreatedAsConflict(t *testing.T) {
	convey.Convey("基版本为空但同步标识已存在", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-p1").Return(&sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 7, SourceDeviceID: 9,
		}, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-p1", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusConflict, out.Results[0].Status)
		assert.Equal(t, int64(7), out.Results[0].OverwrittenVersion)
		assert.Equal(t, int64(9), out.Results[0].OverwrittenDeviceID)
	})
}

func TestPush_GivenBrandNewSyncID_ThenAcceptedWithoutConflict(t *testing.T) {
	convey.Convey("server 从未见过的同步标识", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-new").Return(nil, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(1), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-new", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
		assert.Equal(t, int64(1), saved[0].Version)
	})
}

// R6 / R5a：server 上已是墓碑时，任何非删除的上行都被拒——否则一台持有旧副本的
// 桌面端把它推上来就复活了。恢复动作据此得到「该对象已被删除」而不是悄悄生效。
func TestPush_GivenTombstonedRow_ThenNonDeletePushIsRejected(t *testing.T) {
	convey.Convey("上行撞墓碑", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-p1").Return(&sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 9, SourceDeviceID: 9, DeletedAt: testNow - 1000,
		}, nil)
		// 不该取版本号、更不该落库：没有 EXPECT，调用即失败。

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-p1", 9)}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusRejected, out.Results[0].Status)
		assert.Equal(t, PushRejectReasonDeleted, out.Results[0].Reason)
		// 回报 server 上的当前版本，本端据此知道自己落后到哪一版。
		assert.Equal(t, int64(9), out.Results[0].Version)
	})
}

// 重复投递的删除照常受理：离线队列恢复后同一条可能被投两次（R7），
// 第二次不该变成一条被拒记录。
func TestPush_GivenTombstonedRow_ThenRepeatedDeleteIsAccepted(t *testing.T) {
	convey.Convey("重复删除", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-p1").Return(&sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 9, SourceDeviceID: 9, DeletedAt: testNow - 1000,
		}, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(10), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		item := projectItem("sync-p1", 9)
		item.Deleted = true
		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
		assert.Equal(t, testNow, saved[0].DeletedAt)
	})
}

// R4b：两端在互不知情的情况下为同一（项目, agentred 指纹）各建了一行路径记录，
// 由 server 在上行时合并成一行——落败的那份落墓碑，胜者沿用自己的同步标识。
func TestPush_GivenSameProjectFingerprintFromBothEnds_ThenMergedIntoOneRow(t *testing.T) {
	convey.Convey("同一 (账号, 项目, 指纹) 上两个同步标识", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "loc-B").Return(nil, nil)
		m.object.EXPECT().FindLocationByNaturalKey(gomock.Any(), testUserID, "proj-1", "fp-a").
			Return(&sync_entity.SyncObject{
				ID: 55, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "loc-A",
				ProjectSyncID: "proj-1", AgentredFingerprint: "fp-a", Version: 4, SourceDeviceID: 9,
			}, nil)
		gomock.InOrder(
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil),
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(9), nil),
		)
		// 墓碑要先落，否则自然键上的唯一约束会挡住胜者入库。
		m.object.EXPECT().Tombstone(gomock.Any(), int64(55), int64(8), testNow).Return(int64(1), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", BaseVersion: 0, UpdatedAt: testNow,
			ProjectSyncID: "proj-1", AgentredFingerprint: "fp-a", Payload: []byte(`{"path":"/srv/a"}`),
		}}})

		assert.NoError(t, err)
		// 只剩一行：胜者用自己的同步标识落库，落败的那份被打成墓碑。
		assert.Len(t, saved, 1)
		assert.Equal(t, "loc-B", saved[0].SyncID)
		assert.Equal(t, int64(9), saved[0].Version)
		assert.Equal(t, "loc-A", out.Results[0].MergedSyncID)
		assert.Equal(t, int64(4), out.Results[0].MergedVersion)
		assert.Equal(t, int64(9), out.Results[0].MergedDeviceID)
	})
}

// R4 的兜底：自然键上那行版本更高时，胜者是它，本次上行落墓碑并让位。
// 序列单调之下走不到这一支（本次上行的版本必然更大），但胜负只能由 R4 决定，
// 不能靠「后到的那个一定赢」这个隐含假设。
func TestPush_GivenIncomingLosesNaturalKeyMerge_ThenItIsTheOneTombstoned(t *testing.T) {
	convey.Convey("本次上行在自然键合并里落败", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "loc-B").Return(nil, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(3), nil)
		m.object.EXPECT().FindLocationByNaturalKey(gomock.Any(), testUserID, "proj-1", "fp-a").
			Return(&sync_entity.SyncObject{
				ID: 55, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "loc-A",
				ProjectSyncID: "proj-1", AgentredFingerprint: "fp-a", Version: 10, SourceDeviceID: 9,
			}, nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", UpdatedAt: testNow,
			ProjectSyncID: "proj-1", AgentredFingerprint: "fp-a", Payload: []byte(`{"path":"/srv/a"}`),
		}}})

		assert.NoError(t, err)
		// 落败的是本次上行这一份：它落墓碑，自然键仍归 loc-A。
		assert.Equal(t, testNow, saved[0].DeletedAt)
		assert.Equal(t, "loc-B", out.Results[0].MergedSyncID)
	})
}

// 自然键上没有别的行时不该白白多取一个版本号，也不该落任何墓碑。
func TestPush_GivenLocationWithFreeNaturalKey_ThenNoMerge(t *testing.T) {
	convey.Convey("自然键上没有冲突行", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "loc-B").Return(nil, nil)
		m.object.EXPECT().FindLocationByNaturalKey(gomock.Any(), testUserID, "proj-1", "fp-a").Return(nil, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", UpdatedAt: testNow,
			ProjectSyncID: "proj-1", AgentredFingerprint: "fp-a", Payload: []byte(`{"path":"/srv/a"}`),
		}}})

		assert.NoError(t, err)
		assert.Empty(t, out.Results[0].MergedSyncID)
		assert.Equal(t, int64(8), saved[0].Version)
	})
}

// 删除一条路径记录时不该去做自然键合并——墓碑不占自然键。
func TestPush_GivenDeletedLocation_ThenNoNaturalKeyLookup(t *testing.T) {
	convey.Convey("路径记录的墓碑上行", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "loc-B").Return(&sync_entity.SyncObject{
			ID: 55, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", Version: 4,
		}, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		_, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", BaseVersion: 4, Deleted: true,
			ProjectSyncID: "proj-1", AgentredFingerprint: "fp-a",
		}}})

		assert.NoError(t, err)
		assert.Equal(t, testNow, saved[0].DeletedAt)
	})
}

// 墓碑没有自然键可言：桌面端的 buildPushItem 删除分支不读本地行（行可能已经软删），
// 因此路径记录的墓碑上行**不带** project_sync_id。把「缺自然键」的守卫套到它头上会整批
// 拒（30501/SyncKindInvalid），而整批失败时桌面端一行都不出队——删一个带路径记录的项目
// 就把那台机器的出站队列永久堵死（R6 的删除传不出去，连带 R3/R7 的一切上行）。
func TestPush_GivenDeletedLocationWithoutProjectSyncID_ThenAccepted(t *testing.T) {
	convey.Convey("路径记录的墓碑不带项目同步标识", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "loc-B").Return(&sync_entity.SyncObject{
			ID: 55, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", Version: 4,
		}, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		// 桌面端 sync_svc.buildPushItem 的删除分支产出的正是这个形状。
		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", BaseVersion: 4, Deleted: true,
		}}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
		assert.Equal(t, testNow, saved[0].DeletedAt)
	})
}

// R6a：距上次成功同步超过墓碑保留窗口的设备，上行一律被拒，必须先拉全量快照。
func TestPush_GivenDeviceBeyondTombstoneWindow_ThenRejectedWithResyncRequired(t *testing.T) {
	convey.Convey("设备离线超窗口", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.state.EXPECT().FindDeviceState(gomock.Any(), testUserID, testDeviceID).Return(
			&sync_entity.DeviceSyncState{UserID: testUserID, DeviceID: testDeviceID,
				LastSyncAt: testNow - TombstoneWindow.Milliseconds() - 1},
			nil,
		)
		// object / state 的写方法一个都不该被调用：没有 EXPECT，调用即失败。

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-p1", 3)}})

		assert.Nil(t, out)
		assert.Equal(t, code.SyncResyncRequired, errCode(t, err))
		assert.NoError(t, m.sql.ExpectationsWereMet())
	})
}

// R6a 末句：首次登录的设备在 server 上没有「最近一次成功同步」的记录，不算超窗口。
func TestPush_GivenFirstLoginDeviceWithoutLastSyncAt_ThenNotOverWindow(t *testing.T) {
	convey.Convey("没有 last_sync_at 记录的首次登录设备", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.state.EXPECT().FindDeviceState(gomock.Any(), testUserID, testDeviceID).Return(nil, nil)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-new").Return(nil, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(1), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-new", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
		assert.Len(t, saved, 1)
	})
}

// 决策 19/27 守卫：版本号只来自账号级单调序列，客户端提交的时间戳一律不参与胜负。
func TestPush_GivenClientTimestamps_ThenVersionComesOnlyFromAccountSequence(t *testing.T) {
	convey.Convey("客户端时间戳不参与胜负", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		// 库里那一行的客户端时间戳远在未来，本次上行的时间戳古老得多。
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-p1").Return(&sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 7, SourceDeviceID: 9, SyncUpdatedAt: testNow + (10 * 365 * 24 * time.Hour).Milliseconds(),
		}, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		item := projectItem("sync-p1", 7)
		item.UpdatedAt = 1
		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})

		assert.NoError(t, err)
		// 后到者照胜：版本号是序列给的 8，与两边的时间戳无关。
		assert.Equal(t, int64(8), out.Results[0].Version)
		assert.Equal(t, int64(8), saved[0].Version)
		// 时间戳照落库，但只供展示与 30 天窗口计算。
		assert.Equal(t, int64(1), saved[0].SyncUpdatedAt)
	})
}

// R4：任意到达顺序下所有端收敛到同一个版本——server 是唯一时钟源，后到者胜。
func TestPush_GivenBothArrivalOrders_ThenLastArrivalWins(t *testing.T) {
	convey.Convey("两种到达顺序", t, func() {
		run := func(t *testing.T, firstPayload, secondPayload string) *sync_entity.SyncObject {
			ctx, m, svc := setupSyncTest(t)
			m.state.EXPECT().FindDeviceState(gomock.Any(), testUserID, gomock.Any()).Return(
				&sync_entity.DeviceSyncState{LastSyncAt: testNow - 60_000}, nil).Times(2)
			expectTx(m)
			expectTx(m)
			var saved []*sync_entity.SyncObject
			m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-p1").Return(nil, nil)
			m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-p1").DoAndReturn(
				func(_ context.Context, _ int64, _ string) (*sync_entity.SyncObject, error) {
					return saved[0], nil
				})
			gomock.InOrder(
				m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(1), nil),
				m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(2), nil),
			)
			captureSave(m, &saved).Times(2)

			first := projectItem("sync-p1", 0)
			first.Payload = []byte(firstPayload)
			first.UpdatedAt = testNow + 5_000 // 先到的那端本地时钟更晚
			_, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: 2, Items: []PushItem{first}})
			assert.NoError(t, err)

			second := projectItem("sync-p1", 0)
			second.Payload = []byte(secondPayload)
			second.UpdatedAt = testNow
			_, err = svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: 3, Items: []PushItem{second}})
			assert.NoError(t, err)
			return saved[1]
		}

		convey.Convey("A 先到、B 后到 → B 胜", func() {
			final := run(t, `{"name":"A"}`, `{"name":"B"}`)
			assert.Equal(t, `{"name":"B"}`, final.Payload)
			assert.Equal(t, int64(2), final.Version)
		})
		convey.Convey("B 先到、A 后到 → A 胜", func() {
			final := run(t, `{"name":"B"}`, `{"name":"A"}`)
			assert.Equal(t, `{"name":"A"}`, final.Payload)
			assert.Equal(t, int64(2), final.Version)
		})
	})
}

// 守卫：载荷里不得出现任何桌面端的本地自增 ID。
func TestPush_GivenPayloadWithLocalAutoIncrementID_ThenRejected(t *testing.T) {
	convey.Convey("载荷带本地自增 ID", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		// 这一条不该落库：object / state 的写方法没有 EXPECT。

		item := projectItem("sync-p1", 0)
		item.Payload = []byte(`{"name":"alpha","agent_backend_id":12}`)
		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusRejected, out.Results[0].Status)
		assert.Equal(t, PushRejectReasonPayload, out.Results[0].Reason)
		assert.NoError(t, m.sql.ExpectationsWereMet())
	})
}

// 守卫：载荷里不得出现 APIKey 或任何 provider 行正文；provider_key 这个字符串引用照常放行。
func TestPush_GivenPayloadWithCredential_ThenRejected(t *testing.T) {
	convey.Convey("载荷带凭据", t, func() {
		convey.Convey("api_key 被拒", func() {
			ctx, m, svc := setupSyncTest(t)
			onlineDevice(m)
			expectTx(m)
			item := projectItem("sync-b1", 0)
			item.Payload = []byte(`{"name":"b","api_key":"sk-xxx"}`)
			out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})
			assert.NoError(t, err)
			assert.Equal(t, PushRejectReasonPayload, out.Results[0].Reason)
		})
		convey.Convey("provider 行正文被拒", func() {
			ctx, m, svc := setupSyncTest(t)
			onlineDevice(m)
			expectTx(m)
			item := projectItem("sync-b1", 0)
			item.Payload = []byte(`{"provider":{"provider_key":"openai","api_key":"sk-xxx"}}`)
			out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})
			assert.NoError(t, err)
			assert.Equal(t, PushRejectReasonPayload, out.Results[0].Reason)
		})
		convey.Convey("provider_key 字符串引用放行", func() {
			ctx, m, svc := setupSyncTest(t)
			onlineDevice(m)
			expectTx(m)
			m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-b1").Return(nil, nil)
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(1), nil)
			var saved []*sync_entity.SyncObject
			captureSave(m, &saved)

			item := projectItem("sync-b1", 0)
			item.Kind = sync_entity.KindAgentBackend
			item.Payload = []byte(`{"provider_key":"openai","device_id":"","agentred_fingerprint":"fp-a"}`)
			_, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})
			assert.NoError(t, err)
			assert.Len(t, saved, 1)
		})
	})
}

func TestPush_GivenUnknownKind_ThenRejected(t *testing.T) {
	convey.Convey("对象类型不属于同步组", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		item := projectItem("sync-x", 0)
		item.Kind = "llm_provider"
		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})
		assert.NoError(t, err)
		assert.Equal(t, PushRejectReasonKind, out.Results[0].Reason)
	})
}

func TestPush_GivenLocationWithoutProjectSyncID_ThenRejected(t *testing.T) {
	convey.Convey("路径记录缺项目同步标识", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", AgentredFingerprint: "fp-a",
			Payload: []byte(`{"path":"/srv/a"}`),
		}}})
		assert.NoError(t, err)
		assert.Equal(t, PushRejectReasonKind, out.Results[0].Reason)
	})
}

// 一次上行多条时，每条各取一个版本号，且严格递增。
func TestPush_GivenMultipleItems_ThenVersionsStrictlyIncrease(t *testing.T) {
	convey.Convey("一次上行多条", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, gomock.Any()).Return(nil, nil).Times(2)
		gomock.InOrder(
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(4), nil),
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(5), nil),
		)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved).Times(2)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-a", 0), projectItem("sync-b", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, int64(4), out.Results[0].Version)
		assert.Equal(t, int64(5), out.Results[1].Version)
	})
}

// R3 下行：按版本游标增量，墓碑也在其中（R6 的删除靠它到达各端）。
func TestPull_GivenCursor_ThenReturnsIncrementInVersionOrder(t *testing.T) {
	convey.Convey("按游标下行", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.object.EXPECT().ListSince(gomock.Any(), testUserID, int64(12), DefaultPullLimit).Return(
			[]*sync_entity.SyncObject{
				{Kind: sync_entity.KindProject, SyncID: "p1", Payload: `{"name":"a"}`, Version: 13, SourceDeviceID: 9},
				{Kind: sync_entity.KindAgent, SyncID: "a1", Version: 14, SourceDeviceID: 9, DeletedAt: testNow},
			}, nil)

		out, err := svc.Pull(ctx, PullInput{UserID: testUserID, DeviceID: testDeviceID, Cursor: 12})

		assert.NoError(t, err)
		assert.Len(t, out.Items, 2)
		assert.Equal(t, int64(14), out.NextCursor)
		assert.False(t, out.HasMore)
		assert.False(t, out.Items[0].Deleted)
		assert.True(t, out.Items[1].Deleted)
	})
}

func TestPull_GivenFullPage_ThenHasMoreAndCursorAdvances(t *testing.T) {
	convey.Convey("一页取满", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.object.EXPECT().ListSince(gomock.Any(), testUserID, int64(0), 2).Return(
			[]*sync_entity.SyncObject{
				{Kind: sync_entity.KindProject, SyncID: "p1", Version: 1},
				{Kind: sync_entity.KindProject, SyncID: "p2", Version: 2},
			}, nil)

		out, err := svc.Pull(ctx, PullInput{UserID: testUserID, DeviceID: testDeviceID, Cursor: 0, Limit: 2})

		assert.NoError(t, err)
		assert.True(t, out.HasMore)
		assert.Equal(t, int64(2), out.NextCursor)
	})
}

func TestPull_GivenEmptyPage_ThenCursorStaysPut(t *testing.T) {
	convey.Convey("没有增量", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.object.EXPECT().ListSince(gomock.Any(), testUserID, int64(12), DefaultPullLimit).Return(nil, nil)
		m.state.EXPECT().TouchDeviceState(gomock.Any(), testUserID, testDeviceID, testNow).Return(nil)

		out, err := svc.Pull(ctx, PullInput{UserID: testUserID, DeviceID: testDeviceID, Cursor: 12})

		assert.NoError(t, err)
		assert.Empty(t, out.Items)
		assert.Equal(t, int64(12), out.NextCursor)
	})
}

// 超窗口的设备照样能下行——R6a 要求它先拉一份全量快照，拉取本身不能被拦。
func TestPull_GivenDeviceBeyondWindow_ThenStillAllowed(t *testing.T) {
	convey.Convey("超窗口设备拉全量", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.object.EXPECT().ListSince(gomock.Any(), testUserID, int64(0), DefaultPullLimit).Return(
			[]*sync_entity.SyncObject{{Kind: sync_entity.KindProject, SyncID: "p1", Version: 1}}, nil)

		out, err := svc.Pull(ctx, PullInput{UserID: testUserID, DeviceID: testDeviceID, Cursor: 0})

		assert.NoError(t, err)
		assert.Len(t, out.Items, 1)
	})
}

// R16：上报组整份快照替换，且不碰同步组的任何一行。
func TestReportLocalPaths_GivenSnapshot_ThenReplacesDeviceScopedList(t *testing.T) {
	convey.Convey("本机路径整份上报", t, func() {
		ctx, m, svc := setupSyncTest(t)
		var got []*sync_entity.DeviceLocalPath
		m.localPath.EXPECT().ReplaceSnapshot(gomock.Any(), testUserID, testDeviceID, gomock.Any()).DoAndReturn(
			func(_ context.Context, _, _ int64, items []*sync_entity.DeviceLocalPath) error {
				got = items
				return nil
			})

		err := svc.ReportLocalPaths(ctx, LocalPathsInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []LocalPathItem{{ProjectSyncID: "p1", Path: "/Users/me/p1"}}})

		assert.NoError(t, err)
		assert.Len(t, got, 1)
		assert.Equal(t, testUserID, got[0].UserID)
		assert.Equal(t, testDeviceID, got[0].DeviceID)
		assert.Equal(t, "/Users/me/p1", got[0].Path)
		assert.Equal(t, testNow, got[0].Updatetime)
	})
}

func TestReportLocalPaths_GivenEmptySnapshot_ThenClearsTheList(t *testing.T) {
	convey.Convey("空快照 = 清空清单", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.localPath.EXPECT().ReplaceSnapshot(gomock.Any(), testUserID, testDeviceID, gomock.Len(0)).Return(nil)
		assert.NoError(t, svc.ReportLocalPaths(ctx, LocalPathsInput{UserID: testUserID, DeviceID: testDeviceID}))
	})
}

// R16a：头像按内容哈希存放，与设备无关；哈希对不上就是坏数据，直接拒。
func TestPutAvatar_GivenContent_ThenStoredUnderItsContentHash(t *testing.T) {
	convey.Convey("头像按内容哈希落库", t, func() {
		ctx, m, svc := setupSyncTest(t)
		content := "data:image/png;base64,AAAA"
		hash := sha256Hex(content)
		var saved *sync_entity.SyncAvatar
		m.avatar.EXPECT().Save(gomock.Any(), gomock.Any()).DoAndReturn(
			func(_ context.Context, a *sync_entity.SyncAvatar) error {
				saved = a
				return nil
			})

		err := svc.PutAvatar(ctx, AvatarInput{UserID: testUserID, ContentHash: hash,
			ContentType: "image/png", Content: content})

		assert.NoError(t, err)
		assert.Equal(t, hash, saved.ContentHash)
		assert.Equal(t, testUserID, saved.UserID)
		assert.Equal(t, int64(len(content)), saved.ByteSize)
	})
}

// desktopMaxDecodedAvatarBytes 是桌面端 agent_svc 的 avatarMaxBytes（2 MiB），
// 管的是 base64 **解码后**的字节数。这里照抄它，测的正是「桌面端放行的头像
// server 必须存得下」。
const desktopMaxDecodedAvatarBytes = 2 * 1024 * 1024

// R16a 承诺「换头像照常触发同步」。桌面端按解码后 2 MiB 判上限，而过机的是
// base64 data URL 整串（按 4/3 膨胀，再加 data:image/png;base64, 前缀）——server
// 的上限若比它小，一张桌面端明明接受了的头像就永远同步不上去，那个 Agent 在别的
// 端上会一直退回占位字母头像。
func TestPutAvatar_GivenAvatarAtTheDesktopLimit_ThenAccepted(t *testing.T) {
	convey.Convey("桌面端放行的最大一张头像，server 必须存得下", t, func() {
		ctx, m, svc := setupSyncTest(t)
		content := "data:image/png;base64," +
			base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x7f}, desktopMaxDecodedAvatarBytes))
		m.avatar.EXPECT().Save(gomock.Any(), gomock.Any()).Return(nil)

		err := svc.PutAvatar(ctx, AvatarInput{UserID: testUserID, ContentHash: sha256Hex(content),
			ContentType: "image/png", Content: content})

		assert.NoError(t, err)
	})
}

// 上限本身还在：抬高不等于取消，超过它的正文照拒。
func TestPutAvatar_GivenContentOverTheCap_ThenRejected(t *testing.T) {
	convey.Convey("超过上限的正文照拒", t, func() {
		ctx, _, svc := setupSyncTest(t)
		content := strings.Repeat("a", MaxAvatarBytes+1)

		err := svc.PutAvatar(ctx, AvatarInput{UserID: testUserID, ContentHash: sha256Hex(content), Content: content})

		assert.Equal(t, code.InvalidParameter, errCode(t, err))
	})
}

func TestPutAvatar_GivenHashMismatch_ThenRejected(t *testing.T) {
	convey.Convey("哈希与正文对不上", t, func() {
		ctx, _, svc := setupSyncTest(t)
		err := svc.PutAvatar(ctx, AvatarInput{UserID: testUserID, ContentHash: "deadbeef", Content: "whatever"})
		assert.Equal(t, code.SyncAvatarHashMismatch, errCode(t, err))
	})
}

func TestGetAvatar_GivenUnknownHash_ThenNotFound(t *testing.T) {
	convey.Convey("账号下没有这个哈希", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.avatar.EXPECT().Find(gomock.Any(), testUserID, "nope").Return(nil, nil)
		_, err := svc.GetAvatar(ctx, testUserID, "nope")
		assert.Equal(t, code.SyncAvatarNotFound, errCode(t, err))
	})
}

// 决策 9「超期由服务端与本地各自回收」+ R16a「无人引用即可回收」：服务端这一半
// 是一次周期性清扫，两处回收共用同一个 30 天窗口。窗口以 server 时钟为准（它是
// 唯一时钟源），墓碑早于窗口才删——提前删等于让还没拉取过的设备把已删除的对象
// 重新推回来，R6 的「删除不会被复活」当场失效。
func TestReclaimExpired_GivenTombstoneWindow_ThenSweepsBothWithTheSameCutoff(t *testing.T) {
	convey.Convey("周期性回收超期墓碑与无人引用的头像", t, func() {
		ctx, m, svc := setupSyncTest(t)
		wantCutoff := testNow - TombstoneWindow.Milliseconds()
		m.object.EXPECT().DeleteTombstonesBefore(gomock.Any(), wantCutoff).Return(int64(3), nil)
		m.avatar.EXPECT().DeleteUnreferencedBefore(gomock.Any(), wantCutoff).Return(int64(2), nil)

		out, err := svc.ReclaimExpired(ctx)

		assert.NoError(t, err)
		assert.Equal(t, int64(3), out.Tombstones)
		assert.Equal(t, int64(2), out.Avatars)
	})
}

// 墓碑那一半失败时整轮就地停下：头像回收要在墓碑删干净之后才判「无人引用」
// 才准确，而且下一个周期会原样重来一次，没有必要在半个已知失败的状态上继续。
func TestReclaimExpired_GivenTombstoneSweepFails_ThenAvatarSweepIsNotAttempted(t *testing.T) {
	convey.Convey("墓碑回收失败就不再动头像", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.object.EXPECT().DeleteTombstonesBefore(gomock.Any(), gomock.Any()).Return(int64(0), assert.AnError)

		_, err := svc.ReclaimExpired(ctx)

		assert.ErrorIs(t, err, assert.AnError)
	})
}

// R18：用户在 web 端删除（撤销）一台设备时，该设备上报的本机路径清单一并消失；
// 这条只碰上报组的一张表，不碰同步组（sync_objects）的任何一行。
func TestPurgeDeviceLocalPaths_GivenDeviceID_ThenDeletesItsReportedSnapshot(t *testing.T) {
	convey.Convey("撤销设备时清掉它上报的本机路径清单", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.localPath.EXPECT().DeleteByDevice(gomock.Any(), testDeviceID).Return(nil)

		assert.NoError(t, svc.PurgeDeviceLocalPaths(ctx, testDeviceID))
	})
}

func TestGetAvatar_GivenStoredHash_ThenReturnsContent(t *testing.T) {
	convey.Convey("取回头像正文", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.avatar.EXPECT().Find(gomock.Any(), testUserID, "h1").Return(&sync_entity.SyncAvatar{
			UserID: testUserID, ContentHash: "h1", ContentType: "image/png", Content: "data:image/png;base64,AAAA",
		}, nil)
		out, err := svc.GetAvatar(ctx, testUserID, "h1")
		assert.NoError(t, err)
		assert.Equal(t, "data:image/png;base64,AAAA", out.Content)
		assert.Equal(t, "image/png", out.ContentType)
	})
}
