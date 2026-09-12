package sync_svc

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/pkg/utils/httputils"
	mysqldriver "github.com/go-sql-driver/mysql"
	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo/mock_device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo/mock_sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	hubtest "github.com/agentre-hub/agentre-server/internal/testutils"
)

// accountChanCall 是 stubAccountChan 记下的一次广播。
type accountChanCall struct {
	accountID int64
	version   int64
}

// stubAccountChan 是账号级实时通道在服务层测试里的替身（SetDefault 换掉真实的
// Redis 实现），只记调用、可选地模拟广播失败——写路径测试据此断言「广播失败只记录、
// 不回滚已经落库的写入」。
type stubAccountChan struct {
	mu    sync.Mutex
	err   error
	calls []accountChanCall
	// onBroadcast（可空）在每次广播发出的那一刻被调用：自己开事务的写路径据此记下
	// 广播时的事务时序，断言「广播发生在提交之后」。
	onBroadcast func()
}

func (s *stubAccountChan) Broadcast(_ context.Context, accountID int64, frame accountchan_svc.Frame) error {
	if s.onBroadcast != nil {
		s.onBroadcast()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, accountChanCall{accountID: accountID, version: frame.Version})
	return s.err
}

func (s *stubAccountChan) Subscribe(context.Context, int64) (accountchan_svc.Subscription, error) {
	return nil, errors.New("stubAccountChan: Subscribe not used by write-path tests")
}

func (s *stubAccountChan) recordedCalls() []accountChanCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]accountChanCall(nil), s.calls...)
}

// registerAccountChanStub 换上替身并保证测试结束后恢复成未装配状态（Default() 的
// 安全占位），不让一个测试的广播替身漏到下一个测试里。
func registerAccountChanStub(t *testing.T) *stubAccountChan {
	t.Helper()
	stub := &stubAccountChan{}
	accountchan_svc.SetDefault(stub)
	t.Cleanup(func() { accountchan_svc.SetDefault(nil) })
	return stub
}

const (
	testUserID   = int64(7)
	testDeviceID = int64(2)
	// pushingFingerprint 是这台上行设备自己的指纹：origin_fingerprint 记的就是它
	// （决策 14）。
	pushingFingerprint = "fp-2"
	testNow            = int64(1_700_000_000_000)
)

type syncMocks struct {
	object    *mock_sync_repo.MockSyncObjectRepo
	state     *mock_sync_repo.MockSyncStateRepo
	avatar    *mock_sync_repo.MockSyncAvatarRepo
	localPath *mock_sync_repo.MockSyncLocalPathRepo
	device    *mock_device_repo.MockDeviceRepo
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
		device:    mock_device_repo.NewMockDeviceRepo(ctrl),
	}
	device_repo.RegisterDevice(m.device)
	// 每一次 Push 都要把上行这台机器的**指纹**记进 origin_fingerprint（决策 14），
	// 凭据里只有设备号，所以它一律解得出一行来。装在这里而不是逐个用例里：它是这条
	// 路径上的常量，不是任何一条用例的判据。
	m.device.EXPECT().Find(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, id int64) (*device_entity.Device, error) {
			return &device_entity.Device{
				ID: id, UserID: testUserID, Fingerprint: fmt.Sprintf("fp-%d", id),
			}, nil
		}).AnyTimes()
	sync_repo.RegisterSyncObject(m.object)
	sync_repo.RegisterSyncState(m.state)
	sync_repo.RegisterSyncAvatar(m.avatar)
	sync_repo.RegisterSyncLocalPath(m.localPath)
	// 没有 EXPECT 的调用会被 gomock 判失败——「不该删排列」的那几条边界靠这一点成立。

	ctx, _, sqlMock := hubtest.Database(t)
	m.sql = sqlMock

	svc := newSyncSvc()
	svc.now = func() int64 { return testNow }
	return ctx, m, svc
}

// setupSyncTxTest 与 setupSyncTest 是同一套仓储 mock，只把 ctx 换成 hubtest.TxDatabase，
// 并交回事务事件记录。PurgeDeviceSyncObjects 自己开事务，它要断言的正是事务边界本身
// ——「取号与落墓碑在同一个 BEGIN…COMMIT 里」「失败时整批回滚」——那是 TxLog 这份
// 时序才说得清的事。
func setupSyncTxTest(t *testing.T) (context.Context, *hubtest.TxLog, *syncMocks, *syncSvc) {
	t.Helper()
	_, m, svc := setupSyncTest(t)
	ctx, txLog := hubtest.TxDatabase(t)
	return ctx, txLog, m, svc
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

// expectFindMany 装好 Push 的整批读回：rows 里被请求到的按同步标识归档，其余同步标识
// 库里没有。只交回被请求的那些，服务漏传了哪个同步标识，断言里就会现形。
func expectFindMany(m *syncMocks, rows ...*sync_entity.SyncObject) *gomock.Call {
	return m.object.EXPECT().FindMany(gomock.Any(), testUserID, gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, syncIDs []string) (map[string]*sync_entity.SyncObject, error) {
			out := map[string]*sync_entity.SyncObject{}
			for _, syncID := range syncIDs {
				for _, row := range rows {
					if row.SyncID == syncID {
						out[syncID] = row
					}
				}
			}
			return out, nil
		})
}

// expectFindLiveByNaturalKeys 装好 Push 的自然键批量查重，语义同 expectFindMany。
func expectFindLiveByNaturalKeys(m *syncMocks, rows ...*sync_entity.SyncObject) *gomock.Call {
	return m.object.EXPECT().FindLiveByNaturalKeys(gomock.Any(), testUserID, gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, keys []sync_repo.NaturalKey) (map[sync_repo.NaturalKey]*sync_entity.SyncObject, error) {
			out := map[sync_repo.NaturalKey]*sync_entity.SyncObject{}
			for _, key := range keys {
				for _, row := range rows {
					if key == (sync_repo.NaturalKey{Kind: row.Kind, ScopeSyncID: row.ScopeSyncID,
						AgentredFingerprint: row.AgentredFingerprint}) {
						out[key] = row
					}
				}
			}
			return out, nil
		})
}

// captureCreateBatch 记下 Push 最后一次整批插入的新对象（按插入顺序）。
func captureCreateBatch(m *syncMocks, saved *[]*sync_entity.SyncObject) *gomock.Call {
	return m.object.EXPECT().CreateBatch(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, objs []*sync_entity.SyncObject) error {
			for _, obj := range objs {
				cp := *obj
				*saved = append(*saved, &cp)
			}
			return nil
		})
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
		expectFindMany(m, &sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 7, OriginFingerprint: "fp-9",
		})
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
		assert.Zero(t, out.Results[0].OverwrittenOriginFingerprint)
		assert.Len(t, saved, 1)
		assert.Equal(t, int64(8), saved[0].Version)
		assert.Equal(t, pushingFingerprint, saved[0].OriginFingerprint)
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
		expectFindMany(m, &sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 7, OriginFingerprint: "fp-9",
		})
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-p1", 5)}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusConflict, out.Results[0].Status)
		assert.Equal(t, int64(7), out.Results[0].OverwrittenVersion)
		assert.Equal(t, "fp-9", out.Results[0].OverwrittenOriginFingerprint)
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
		expectFindMany(m, &sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 7, OriginFingerprint: "fp-9",
		})
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-p1", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusConflict, out.Results[0].Status)
		assert.Equal(t, int64(7), out.Results[0].OverwrittenVersion)
		assert.Equal(t, "fp-9", out.Results[0].OverwrittenOriginFingerprint)
	})
}

func TestPush_GivenBrandNewSyncID_ThenAcceptedWithoutConflict(t *testing.T) {
	convey.Convey("server 从未见过的同步标识", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		expectFindMany(m)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(1), nil)
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved)

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
		expectFindMany(m, &sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 9, OriginFingerprint: "fp-9", DeletedAt: testNow - 1000,
		})
		// 不该落库：Save 没有 EXPECT，调用即失败。
		//
		// 版本号则会被取走一个。这一批的号在**事务之前**一次取完（那是为了不让
		// sync_account_seqs 的行锁横跨整批），而「撞墓碑」要读过库才判得出来，
		// 那时号已经在手上了。于是序列上留下一个空号——版本号是单调游标，下行按
		// 「version > cursor」取，空号对任何一端都不可观察。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(10), nil)

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
		expectFindMany(m, &sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 9, OriginFingerprint: "fp-9", DeletedAt: testNow - 1000,
		})
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(10), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		item := projectItem("sync-p1", 9)
		item.DeletedAt = testNow
		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
		assert.Equal(t, testNow, saved[0].DeletedAt)
	})
}

// 决策 20 让墓碑携带**发起端记下的**删除时刻，但同一列同时是 ReclaimExpired 的唯一
// 回收判据（deleted_at < now - 30d）。桌面端的墙钟因此不能直接决定 server 的保留期：
// 一台落后 30 天的机器（或任何写 deleted_at:1 的客户端）推来的墓碑会在下一轮回收里
// 立刻被删掉，而还没拉到它的离线端把活行推回来时，R6 的复活守卫已经无行可查——整个
// 账号的删除被撤销。反向偏差（时刻在未来）则让墓碑永不过期。
// 落库的时刻必须被夹回 [now-30d, now]。
func TestPush_GivenTombstoneInstantOutsideRetentionWindow_ThenClampedToServerClock(t *testing.T) {
	convey.Convey("上行带来的删除时刻越界", t, func() {
		for _, tc := range []struct {
			name      string
			deletedAt int64
			want      int64
		}{
			{"墙钟落后到窗口之外", 1, testNow - TombstoneWindow.Milliseconds()},
			{"墙钟快到未来", testNow + 90*24*3600*1000, testNow},
			{"窗口之内的时刻原样保留", testNow - 1000, testNow - 1000},
		} {
			convey.Convey(tc.name, func() {
				ctx, m, svc := setupSyncTest(t)
				onlineDevice(m)
				expectTx(m)
				expectFindMany(m)
				m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(10), nil)
				var saved []*sync_entity.SyncObject
				captureCreateBatch(m, &saved)

				item := projectItem("sync-p1", 0)
				item.DeletedAt = tc.deletedAt
				out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})

				assert.NoError(t, err)
				assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
				assert.Equal(t, tc.want, saved[0].DeletedAt)
			})
		}
	})
}

// R4b：两端在互不知情的情况下为同一（项目, agentred 指纹）各建了一行路径记录，
// 由 server 在上行时合并成一行——落败的那份落墓碑，胜者沿用自己的同步标识。
func TestPush_GivenSameProjectFingerprintFromBothEnds_ThenMergedIntoOneRow(t *testing.T) {
	convey.Convey("同一 (账号, 项目, 指纹) 上两个同步标识", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		expectFindMany(m)
		expectFindLiveByNaturalKeys(m, &sync_entity.SyncObject{
			ID: 55, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "loc-A",
			ScopeSyncID: "proj-1", AgentredFingerprint: "fp-a", Version: 4, OriginFingerprint: "fp-9",
		})
		gomock.InOrder(
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil),
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(9), nil),
		)
		// 墓碑要先落，否则自然键上的唯一约束会挡住胜者入库。
		tombstone := m.object.EXPECT().Tombstone(gomock.Any(), int64(55), int64(8), testNow).Return(int64(1), nil)
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved).After(tombstone)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", BaseVersion: 0, UpdatedAt: testNow,
			ScopeSyncID: "proj-1", AgentredFingerprint: "fp-a", Payload: []byte(`{"path":"/srv/a"}`),
		}}})

		assert.NoError(t, err)
		// 只剩一行：胜者用自己的同步标识落库，落败的那份被打成墓碑。
		assert.Len(t, saved, 1)
		assert.Equal(t, "loc-B", saved[0].SyncID)
		assert.Equal(t, int64(9), saved[0].Version)
		assert.Equal(t, "loc-A", out.Results[0].MergedSyncID)
		assert.Equal(t, int64(4), out.Results[0].MergedVersion)
		assert.Equal(t, "fp-9", out.Results[0].MergedOriginFingerprint)
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
		expectFindMany(m)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(3), nil)
		expectFindLiveByNaturalKeys(m, &sync_entity.SyncObject{
			ID: 55, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "loc-A",
			ScopeSyncID: "proj-1", AgentredFingerprint: "fp-a", Version: 10, OriginFingerprint: "fp-9",
		})
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", UpdatedAt: testNow,
			ScopeSyncID: "proj-1", AgentredFingerprint: "fp-a", Payload: []byte(`{"path":"/srv/a"}`),
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
		expectFindMany(m)
		expectFindLiveByNaturalKeys(m)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", UpdatedAt: testNow,
			ScopeSyncID: "proj-1", AgentredFingerprint: "fp-a", Payload: []byte(`{"path":"/srv/a"}`),
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
		expectFindMany(m, &sync_entity.SyncObject{
			ID: 55, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", Version: 4,
		})
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		_, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", BaseVersion: 4, DeletedAt: testNow,
			ScopeSyncID: "proj-1", AgentredFingerprint: "fp-a",
		}}})

		assert.NoError(t, err)
		assert.Equal(t, testNow, saved[0].DeletedAt)
	})
}

// 墓碑没有自然键可言：桌面端的 buildPushItem 删除分支不读本地行（行可能已经软删），
// 因此路径记录的墓碑上行**不带** project_sync_id。把「缺自然键」的守卫套到它头上，
// 这条墓碑就会被单独拒掉——删一个带路径记录的项目，那条删除永远传不到别的设备（R6）。
func TestPush_GivenDeletedLocationWithoutProjectSyncID_ThenAccepted(t *testing.T) {
	convey.Convey("路径记录的墓碑不带项目同步标识", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		expectFindMany(m, &sync_entity.SyncObject{
			ID: 55, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", Version: 4,
		})
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		// 桌面端 sync_svc.buildPushItem 的删除分支产出的正是这个形状。
		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{{
			Kind: sync_entity.KindProjectLocation, SyncID: "loc-B", BaseVersion: 4, DeletedAt: testNow,
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
		expectFindMany(m)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(1), nil)
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved)

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
		expectFindMany(m, &sync_entity.SyncObject{
			ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-p1",
			Version: 7, OriginFingerprint: "fp-9", SyncUpdatedAt: testNow + (10 * 365 * 24 * time.Hour).Milliseconds(),
		})
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
			gomock.InOrder(
				m.object.EXPECT().FindMany(gomock.Any(), testUserID, []string{"sync-p1"}).
					Return(map[string]*sync_entity.SyncObject{}, nil),
				m.object.EXPECT().FindMany(gomock.Any(), testUserID, []string{"sync-p1"}).DoAndReturn(
					func(_ context.Context, _ int64, _ []string) (map[string]*sync_entity.SyncObject, error) {
						return map[string]*sync_entity.SyncObject{"sync-p1": saved[0]}, nil
					}),
			)
			gomock.InOrder(
				m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(1), nil),
				m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(2), nil),
			)
			// 先到的那次是新建（整批插入），后到的那次覆盖已有行（带版本条件的 UPDATE）。
			gomock.InOrder(captureCreateBatch(m, &saved), captureSave(m, &saved))

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
			expectFindMany(m)
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(1), nil)
			var saved []*sync_entity.SyncObject
			captureCreateBatch(m, &saved)

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
		item.Kind = "unknown_kind"
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
		expectFindMany(m)
		// 整批一次取走 2 个,返回其中最大的那个 → 依次发放 4、5(与逐条取号时同值)。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(5), nil)
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-a", 0), projectItem("sync-b", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, int64(4), out.Results[0].Version)
		assert.Equal(t, int64(5), out.Results[1].Version)
	})
}

// 设备上行是「谁发信号」三处之一：落库之后要把账号级实时通道推进到这一版，另一台
// 桌面端才不必等 30 秒轮询（规格「账号级实时通道」）。
func TestPush_GivenAcceptedItem_ThenBroadcastsAccountVersion(t *testing.T) {
	convey.Convey("上行成功后广播账号版本", t, func() {
		ctx, m, svc := setupSyncTest(t)
		stub := registerAccountChanStub(t)
		onlineDevice(m)
		expectTx(m)
		expectFindMany(m)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-p1", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, int64(8), out.Results[0].Version)
		assert.Equal(t, []accountChanCall{{accountID: testUserID, version: 8}}, stub.recordedCalls())
	})
}

// 一批里多条各自烧了版本号时，只广播这一批里最新的那个版本——信号只携带版本号，
// 待发的信号可以合并成最新的一条（规格「合并」），没必要一条一条发。
func TestPush_GivenMultipleAcceptedItems_ThenBroadcastsOnlyTheHighestVersion(t *testing.T) {
	convey.Convey("一次上行多条只广播最高版本", t, func() {
		ctx, m, svc := setupSyncTest(t)
		stub := registerAccountChanStub(t)
		onlineDevice(m)
		expectTx(m)
		expectFindMany(m)
		// 整批一次取走 2 个,返回其中最大的那个 → 依次发放 4、5(与逐条取号时同值)。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(5), nil)
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved)

		_, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-a", 0), projectItem("sync-b", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, []accountChanCall{{accountID: testUserID, version: 5}}, stub.recordedCalls())
	})
}

// 整批都在校验阶段被拒（rejectReason）时没有任何一条烧版本号——不该发一条空信号，
// 让在线的桌面端为了什么都没变的一次上行多拉一页。
func TestPush_GivenAllItemsRejectedByValidation_ThenNoBroadcast(t *testing.T) {
	convey.Convey("整批校验不通过时不广播", t, func() {
		ctx, m, svc := setupSyncTest(t)
		stub := registerAccountChanStub(t)
		onlineDevice(m)
		expectTx(m)
		item := projectItem("sync-x", 0)
		item.Kind = "unknown_kind"

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: []PushItem{item}})

		assert.NoError(t, err)
		assert.Equal(t, PushRejectReasonKind, out.Results[0].Reason)
		assert.Empty(t, stub.recordedCalls())
	})
}

// 广播失败只记录、不回滚已经落库的写入——写入的权威性在数据库，不在通道
// （规格「失败处理」）。Push 本身必须照常成功返回。
func TestPush_GivenAccountChannelBroadcastFails_ThenPushStillSucceeds(t *testing.T) {
	convey.Convey("广播失败不影响已经落库的写入", t, func() {
		ctx, m, svc := setupSyncTest(t)
		stub := registerAccountChanStub(t)
		stub.err = errors.New("redis unreachable")
		onlineDevice(m)
		expectTx(m)
		expectFindMany(m)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-p1", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
		assert.Len(t, saved, 1, "写入照常落库，不因广播失败回滚")
	})
}

// R3 下行：按版本游标增量，墓碑也在其中（R6 的删除靠它到达各端）。
func TestPull_GivenCursor_ThenReturnsIncrementInVersionOrder(t *testing.T) {
	convey.Convey("按游标下行", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.object.EXPECT().ListSince(gomock.Any(), testUserID, int64(12), DefaultPullLimit).Return(
			[]*sync_entity.SyncObject{
				{Kind: sync_entity.KindProject, SyncID: "p1", Payload: `{"name":"a"}`, Version: 13, OriginFingerprint: "fp-9"},
				{Kind: sync_entity.KindAgent, SyncID: "a1", Version: 14, OriginFingerprint: "fp-9", DeletedAt: testNow},
			}, nil)

		out, err := svc.Pull(ctx, PullInput{UserID: testUserID, DeviceID: testDeviceID, Cursor: 12})

		assert.NoError(t, err)
		assert.Len(t, out.Items, 2)
		assert.Equal(t, int64(14), out.NextCursor)
		assert.False(t, out.HasMore)
		assert.Zero(t, out.Items[0].DeletedAt)
		assert.Equal(t, testNow, out.Items[1].DeletedAt)
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
		// 空页要先分清成因：游标没有超出序列的头，这才是「消费干净」。
		m.state.EXPECT().CurrentVersion(gomock.Any(), testUserID).Return(int64(12), nil)
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

// 服务端库被重建（或用户换了一套自建服务端）之后，账号的版本序列从头开始，而设备
// 手上的游标还停在上一套历史的某个大数上。ListSince 是 `version > cursor`，于是每
// 一轮下行都返回空页——空页在这里被当成「这台设备已经把增量消费干净」并刷新
// last_sync_at，R6a 的超窗口判定读的正是它，30500 因此永不发出：设备没有任何理由
// 重同步，界面上也没有任何错误可循，两台机器从此互相看不见。
//
// 「游标超出本账号序列的头」在语义上就是「我不认识你说的那段历史」，必须明确说
// 出来，而不是回空页 + 刷新窗口。
func TestPull_GivenCursorBeyondAccountSequence_ThenCursorUnknown(t *testing.T) {
	convey.Convey("游标超出账号序列的头", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.object.EXPECT().ListSince(gomock.Any(), testUserID, int64(500), DefaultPullLimit).Return(nil, nil)
		m.state.EXPECT().CurrentVersion(gomock.Any(), testUserID).Return(int64(3), nil)
		// TouchDeviceState 刻意没有 EXPECT：窗口一旦被刷新，R6a 就永远不会触发。

		out, err := svc.Pull(ctx, PullInput{UserID: testUserID, DeviceID: testDeviceID, Cursor: 500})

		assert.Nil(t, out)
		assert.Equal(t, code.SyncCursorUnknown, errCode(t, err))
	})
}

// 反向守卫：游标正好站在序列头上就是「已消费干净」，窗口照常刷新——sync.go 里那段
// 注释说的原本意图（防止卡住的设备拿陈旧基版本把已回收的删除推回来）必须保住。
func TestPull_GivenCursorAtSequenceHead_ThenWindowStillRefreshes(t *testing.T) {
	convey.Convey("游标正好站在序列头上", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.object.EXPECT().ListSince(gomock.Any(), testUserID, int64(12), DefaultPullLimit).Return(nil, nil)
		m.state.EXPECT().CurrentVersion(gomock.Any(), testUserID).Return(int64(12), nil)
		m.state.EXPECT().TouchDeviceState(gomock.Any(), testUserID, testDeviceID, testNow).Return(nil)

		out, err := svc.Pull(ctx, PullInput{UserID: testUserID, DeviceID: testDeviceID, Cursor: 12})

		assert.NoError(t, err)
		assert.Empty(t, out.Items)
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
		assert.Equal(t, content, saved.Content)
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

const testFingerprint = "sha256:aaaa"

// deviceScopedFixture 是一张混着各种 kind 的账号级快照，其中 CLI 覆盖与项目路径
// 属于要离开账号的那台机器。project / agent / backend 这几行**故意**也带上同一个
// 指纹：真实账号级 backend 不以指纹为身份，写成这样是为了让「只碰覆盖与路径记录」
// 这条边界由 kind 本身而不是由数据的巧合来保证。
func deviceScopedFixture() []*sync_entity.SyncObject {
	return []*sync_entity.SyncObject{
		{ID: 1, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "p1", AgentredFingerprint: testFingerprint},
		{ID: 2, UserID: testUserID, Kind: sync_entity.KindAgent, SyncID: "a1", AgentredFingerprint: testFingerprint},
		{ID: 3, UserID: testUserID, Kind: sync_entity.KindAgentBackend, SyncID: "b1", AgentredFingerprint: testFingerprint, Version: 10},
		{ID: 4, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "l1", AgentredFingerprint: testFingerprint, Version: 11},
		{ID: 5, UserID: testUserID, Kind: sync_entity.KindAgentBackend, SyncID: "b2", AgentredFingerprint: "sha256:bbbb", Version: 12},
		{ID: 6, UserID: testUserID, Kind: sync_entity.KindAgentBackend, SyncID: "b3", Version: 13},
		{ID: 7, UserID: testUserID, Kind: sync_entity.KindAgentBackendCLI, SyncID: "cli-1", ScopeSyncID: "b1", AgentredFingerprint: testFingerprint, Version: 14},
	}
}

// expectListLiveByFingerprint 让 mock 按仓储的真实语义过滤 fixture，这样服务传下去的
// kinds / fingerprint 说错了，测试就会在断言里现形。
func expectListLiveByFingerprint(m *syncMocks, rows []*sync_entity.SyncObject) {
	m.object.EXPECT().ListLiveByFingerprint(gomock.Any(), testUserID, gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, userID int64, fingerprint string, kinds []string) ([]*sync_entity.SyncObject, error) {
			wanted := map[string]bool{}
			for _, k := range kinds {
				wanted[k] = true
			}
			var out []*sync_entity.SyncObject
			for _, row := range rows {
				if row.UserID == userID && row.AgentredFingerprint == fingerprint &&
					wanted[row.Kind] && !row.IsDeleted() {
					out = append(out, row)
				}
			}
			return out, nil
		},
	)
}

// execTargetRow 造一条存活的执行目标行。载荷里的 `backend_sync_id` 是它引用的那一档
// backend——键名与桌面端 sync_svc/adapter_org.go 的 `json:"backend_sync_id"` 同源，
// 服务端 workspace_svc 的展示路径也按这个键解析。
func execTargetRow(id int64, syncID, agentSyncID, backendSyncID string) *sync_entity.SyncObject {
	return &sync_entity.SyncObject{
		ID: id, UserID: testUserID, Kind: sync_entity.KindAgentExecTarget, SyncID: syncID,
		Payload: fmt.Sprintf(`{"agent_sync_id":%q,"backend_sync_id":%q,"sort_order":1}`,
			agentSyncID, backendSyncID),
	}
}

// expectListByKinds 让 mock 按仓储的真实语义过滤 fixture：墓碑不返回、kind 不在
// 清单里的不返回。服务传下去的 kinds 说错了，断言里就会现形。
func expectListByKinds(m *syncMocks, rows []*sync_entity.SyncObject) {
	m.object.EXPECT().ListByKinds(gomock.Any(), testUserID, gomock.Any()).DoAndReturn(
		func(_ context.Context, userID int64, kinds []string) ([]*sync_entity.SyncObject, error) {
			wanted := map[string]bool{}
			for _, k := range kinds {
				wanted[k] = true
			}
			var out []*sync_entity.SyncObject
			for _, row := range rows {
				if row.UserID == userID && wanted[row.Kind] && !row.IsDeleted() {
					out = append(out, row)
				}
			}
			return out, nil
		},
	).AnyTimes()
}

// 一台设备离开账号（控制台解除授权，或机器上 agentred logout）时，账号级同步数据里
// **只属于这台设备**的两类行跟着消失：该指纹的 CLI 覆盖、它上面的项目路径。账号级
// backend 身份与 llm_provider 必须继续存活。
//
// 必须是墓碑，不能是硬删：这些对象每台桌面端都有一份副本，硬删的话它们永远学不到，
// 那个 backend 会作为「永久不可用的一档」一直挂在执行目标列表里；更糟的是任一台桌面端
// 一旦编辑它，就会被当成新对象重新推上来复活，直接违反 R6。
func TestPurgeDeviceSyncObjects_GivenFingerprint_ThenTombstonesOnlyThatDevicesCLIOverlaysAndLocations(t *testing.T) {
	convey.Convey("设备离开账号时，该指纹的 CLI 覆盖与项目路径落墓碑", t, func() {
		ctx, _, m, svc := setupSyncTxTest(t)
		expectListLiveByFingerprint(m, deviceScopedFixture())
		expectListByKinds(m, deviceScopedFixture())

		// 两行落墓碑一次取走两个号：[101, 102]。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(102), nil)

		type stone struct{ id, version int64 }
		var stones []stone
		m.object.EXPECT().Tombstone(gomock.Any(), gomock.Any(), gomock.Any(), testNow).DoAndReturn(
			func(_ context.Context, id, version, _ int64) (int64, error) {
				stones = append(stones, stone{id, version})
				return 1, nil
			},
		).Times(2)

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, testFingerprint))

		// 只有路径记录(4) 与 CLI 覆盖(7) 被落墓碑：project(1) / agent(2) / 账号级
		// backend(3) 一行不许动，另一台机器的 backend(5) 与本机档 backend(6) 同样不许动。
		assert.Equal(t, []stone{{4, 101}, {7, 102}}, stones)
	})
}

// 落墓碑同样要广播——设备被撤销后，另一台桌面端不该还要等 30 秒轮询
// 才知道该设备的 CLI 覆盖与项目路径已删除。
func TestPurgeDeviceSyncObjects_GivenFingerprint_ThenBroadcastsHighestVersion(t *testing.T) {
	convey.Convey("落墓碑后广播这一次操作烧到的最高版本", t, func() {
		ctx, _, m, svc := setupSyncTxTest(t)
		stub := registerAccountChanStub(t)
		expectListLiveByFingerprint(m, deviceScopedFixture())
		expectListByKinds(m, deviceScopedFixture())

		// 两行落墓碑一次取走两个号：[101, 102]。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(102), nil)
		m.object.EXPECT().Tombstone(gomock.Any(), gomock.Any(), gomock.Any(), testNow).Return(int64(1), nil).Times(2)

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, testFingerprint))

		assert.Equal(t, []accountChanCall{{accountID: testUserID, version: 102}}, stub.recordedCalls())
	})
}

// 空指纹是「当前这台桌面端」这个**相对**引用（决策 14），不指代任何一台具体机器。
// 拿它当过滤条件会把账号下每一个本机 CLI 覆盖一次全部落墓碑 —— 这是这条清理里唯一
// 一种能把好数据成片删掉的失效方式，因此在服务层直接短路，一次查询都不发。
func TestPurgeDeviceSyncObjects_GivenEmptyFingerprint_ThenTouchesNothing(t *testing.T) {
	convey.Convey("指纹为空时一行都不碰", t, func() {
		ctx, m, svc := setupSyncTest(t)
		_ = m // 没有任何 EXPECT：任何一次仓储调用都会让 gomock 判失败

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, ""))
	})
}

// 这台机器上没有任何东西时不取版本号：空转一次也不该在账号序列上留下缺口
// （序列同时是下行游标，白白跳号会让每一台桌面端多拉一个空页）。
func TestPurgeDeviceSyncObjects_GivenNothingScopedToTheDevice_ThenNoVersionIsBurned(t *testing.T) {
	convey.Convey("没有属于这台设备的行时不分配版本号", t, func() {
		ctx, _, m, svc := setupSyncTxTest(t)
		expectListLiveByFingerprint(m, deviceScopedFixture())

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, "sha256:never-seen"))
	})
}

// accountIdentityFixture 在设备局部行之外放入部门与执行目标。它们都与被撤销设备
// 同账号，因此撤销时不论载荷引用谁都绝不能被连带墓碑。
func accountIdentityFixture() []*sync_entity.SyncObject {
	return append(deviceScopedFixture(),
		&sync_entity.SyncObject{ID: 7, UserID: testUserID, Kind: sync_entity.KindDepartment,
			SyncID: "d1", AgentredFingerprint: testFingerprint},
		execTargetRow(8, "t1", "a1", "b1"),
		execTargetRow(9, "t2", "a1", "b2"),
		execTargetRow(10, "t3", "a1", "b3"),
	)
}

// backend 身份和执行目标都是账号级对象。即使它们的载荷提到撤销设备上的旧 backend，
// 设备撤销仍只能删除该设备的 CLI 覆盖与项目路径，不能级联到账号身份。
func TestPurgeDeviceSyncObjects_GivenAccountBackendAndExecTarget_ThenLeavesThemAlive(t *testing.T) {
	convey.Convey("账号级 backend 身份与执行目标不随设备撤销而落墓碑", t, func() {
		ctx, _, m, svc := setupSyncTxTest(t)
		expectListLiveByFingerprint(m, accountIdentityFixture())
		// ListByKinds 没有 EXPECT：设备撤销不扫描账号级 backend 或执行目标。

		// 两行落墓碑一次取走两个号：[101, 102]。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(102), nil)

		type stone struct{ id, version int64 }
		var stones []stone
		m.object.EXPECT().Tombstone(gomock.Any(), gomock.Any(), gomock.Any(), testNow).DoAndReturn(
			func(_ context.Context, id, version, _ int64) (int64, error) {
				stones = append(stones, stone{id, version})
				return 1, nil
			},
		).Times(2)

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, testFingerprint))

		// 后端身份 b1 与其执行目标 t1 都属于账号，撤销设备不得动它们；只有路径和
		// 该设备的 CLI 覆盖落墓碑。
		assert.Equal(t, []stone{{4, 101}, {7, 102}}, stones)
	})
}

// 落墓碑是「谁发信号」三处之一：广播必须取这批设备局部对象烧到的最高版本。
func TestPurgeDeviceSyncObjects_GivenAccountBackendsAndExecTargets_ThenBroadcastsDeviceScopedHighestVersion(t *testing.T) {
	convey.Convey("只为设备局部对象的墓碑广播最高版本", t, func() {
		ctx, _, m, svc := setupSyncTxTest(t)
		stub := registerAccountChanStub(t)
		expectListLiveByFingerprint(m, accountIdentityFixture())
		// ListByKinds 没有 EXPECT：广播只覆盖本次设备局部对象的版本。

		// 两行落墓碑一次取走两个号：[101, 102]。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(102), nil)
		m.object.EXPECT().Tombstone(gomock.Any(), gomock.Any(), gomock.Any(), testNow).Return(int64(1), nil).Times(2)

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, testFingerprint))

		assert.Equal(t, []accountChanCall{{accountID: testUserID, version: 102}}, stub.recordedCalls())
	})
}

// 空指纹短路时不该广播——没碰任何数据，没有版本号可言。
func TestPurgeDeviceSyncObjects_GivenEmptyFingerprint_ThenNoBroadcast(t *testing.T) {
	convey.Convey("指纹为空时不广播", t, func() {
		ctx, m, svc := setupSyncTest(t)
		stub := registerAccountChanStub(t)
		_ = m

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, ""))
		assert.Empty(t, stub.recordedCalls())
	})
}

// 这台设备名下没有账号级对象时不烧版本号，也就没有信号可发。
func TestPurgeDeviceSyncObjects_GivenNothingScopedToTheDevice_ThenNoBroadcast(t *testing.T) {
	convey.Convey("没有属于这台设备的行时不广播", t, func() {
		ctx, _, m, svc := setupSyncTxTest(t)
		stub := registerAccountChanStub(t)
		expectListLiveByFingerprint(m, deviceScopedFixture())

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, "sha256:never-seen"))
		assert.Empty(t, stub.recordedCalls())
	})
}

// 广播失败只记录、不回滚已经落库的墓碑——写入的权威性在数据库，不在通道。
func TestPurgeDeviceSyncObjects_GivenBroadcastFails_ThenPurgeStillSucceeds(t *testing.T) {
	convey.Convey("广播失败不影响已经落库的墓碑", t, func() {
		ctx, _, m, svc := setupSyncTxTest(t)
		stub := registerAccountChanStub(t)
		stub.err = errors.New("redis unreachable")
		expectListLiveByFingerprint(m, deviceScopedFixture())
		expectListByKinds(m, deviceScopedFixture())

		// 两行落墓碑一次取走两个号：[101, 102]。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(102), nil)
		m.object.EXPECT().Tombstone(gomock.Any(), gomock.Any(), gomock.Any(), testNow).Return(int64(1), nil).Times(2)

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, testFingerprint))
	})
}

// 设备撤销绝不能按执行目标中的 backend_sync_id 扫描或删除账号级对象。否则一个本机
// CLI 覆盖的墓碑会把整个账号的执行目标列表误删。
func TestPurgeDeviceSyncObjects_GivenExecTargetsReferencingLiveBackends_ThenNoneAreSweptAlong(t *testing.T) {
	convey.Convey("执行目标引用的是别的、仍然活着的 backend 时不许被带走", t, func() {
		ctx, _, m, svc := setupSyncTxTest(t)
		rows := append(deviceScopedFixture(),
			execTargetRow(9, "t2", "a1", "b2"),
			execTargetRow(10, "t3", "a1", "b3"),
			&sync_entity.SyncObject{ID: 11, UserID: testUserID, Kind: sync_entity.KindAgentExecTarget,
				SyncID: "t4", Payload: `{"agent_sync_id":"a1"`},
		)
		expectListLiveByFingerprint(m, rows)
		expectListByKinds(m, rows)

		// 两行落墓碑一次取走两个号：[101, 102]。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(102), nil)

		type stone struct{ id, version int64 }
		var stones []stone
		m.object.EXPECT().Tombstone(gomock.Any(), gomock.Any(), gomock.Any(), testNow).DoAndReturn(
			func(_ context.Context, id, version, _ int64) (int64, error) {
				stones = append(stones, stone{id, version})
				return 1, nil
			},
		).Times(2)

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, testFingerprint))

		assert.Equal(t, []stone{{4, 101}, {7, 102}}, stones)
	})
}

// 设备撤销只处理路径与 CLI 覆盖：它不扫描账号级执行目标，避免把本机退出变成
// 全账号对象的读取与连带删除。
func TestPurgeDeviceSyncObjects_GivenOnlyLocationsScoped_ThenNoExecTargetLookupHappens(t *testing.T) {
	convey.Convey("只有项目路径落墓碑时不查执行目标", t, func() {
		ctx, _, m, svc := setupSyncTxTest(t)
		rows := []*sync_entity.SyncObject{
			{ID: 4, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "l1",
				AgentredFingerprint: testFingerprint, Version: 11},
			execTargetRow(8, "t1", "a1", "b1"),
		}
		expectListLiveByFingerprint(m, rows)
		// ListByKinds 没有 EXPECT：一次都不该调。

		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(101), nil)
		m.object.EXPECT().Tombstone(gomock.Any(), int64(4), int64(101), testNow).Return(int64(1), nil)

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, testFingerprint))
	})
}

// 要求 2：撤销一台设备时，所有墓碑在**一个**事务里落库，版本号一次取完、连续递增，
// 账号广播在提交之后发出。
//
// 逐行「取一个号、落一块墓碑」而不开事务时，每次取号的行锁在落墓碑之前就放掉了：并发
// 的一次 Push 可以在两块墓碑之间取到更大的号并先提交，设备把游标推过去，这块墓碑随后
// 提交的较小版本对它永远不再投递——被撤销机器的路径就留在别的桌面端上。取号收进落墓碑
// 的事务里，「取号顺序 == 提交顺序」才成立；一次取 N 个则把 N 次取号（每次一个嵌套事务
// 加两条语句）压成一次。
func TestPurgeDeviceSyncObjects_GivenThreeScopedRows_ThenOneAllocationAndAllTombstonesInOneTransaction(t *testing.T) {
	convey.Convey("三行落墓碑：一次取三个号、同一个事务、提交后广播最高版本", t, func() {
		ctx, txLog, m, svc := setupSyncTxTest(t)
		stub := registerAccountChanStub(t)
		rows := append(deviceScopedFixture(), &sync_entity.SyncObject{
			ID: 8, UserID: testUserID, Kind: sync_entity.KindProjectLocation, SyncID: "l2",
			AgentredFingerprint: testFingerprint, Version: 15,
		})
		expectListLiveByFingerprint(m, rows)

		var steps []string
		record := func(ctx context.Context, step string) {
			steps = append(steps, fmt.Sprintf("%s inTx=%t %v", step, hubtest.InTransaction(ctx), txLog.Events()))
		}
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(3)).DoAndReturn(
			func(ctx context.Context, _, _ int64) (int64, error) {
				record(ctx, "NextVersion")
				return 102, nil
			})
		type stone struct{ id, version int64 }
		var stones []stone
		m.object.EXPECT().Tombstone(gomock.Any(), gomock.Any(), gomock.Any(), testNow).DoAndReturn(
			func(ctx context.Context, id, version, _ int64) (int64, error) {
				record(ctx, "Tombstone")
				stones = append(stones, stone{id, version})
				return 1, nil
			}).Times(3)
		stub.onBroadcast = func() { steps = append(steps, fmt.Sprintf("Broadcast %v", txLog.Events())) }

		assert.NoError(t, svc.PurgeDeviceSyncObjects(ctx, testUserID, testFingerprint))

		// 三个号是 [100, 102]，按行序发放。
		assert.Equal(t, []stone{{4, 100}, {7, 101}, {8, 102}}, stones)
		assert.Equal(t, []string{
			"NextVersion inTx=true [BEGIN]",
			"Tombstone inTx=true [BEGIN]",
			"Tombstone inTx=true [BEGIN]",
			"Tombstone inTx=true [BEGIN]",
			"Broadcast [BEGIN COMMIT]",
		}, steps)
		assert.Equal(t, []accountChanCall{{accountID: testUserID, version: 102}}, stub.recordedCalls())
	})
}

// 要求 2 的另一半：任一步失败都不留下部分墓碑——已经落下的那几块随事务一起回滚，
// 错误如实上抛，也不广播（没有提交就没有可拉的变更）。
func TestPurgeDeviceSyncObjects_GivenTombstoneFails_ThenWholeBatchRollsBackWithoutBroadcast(t *testing.T) {
	convey.Convey("第二块墓碑落库失败时整批回滚、不广播", t, func() {
		ctx, txLog, m, svc := setupSyncTxTest(t)
		stub := registerAccountChanStub(t)
		expectListLiveByFingerprint(m, deviceScopedFixture())
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(102), nil)
		gomock.InOrder(
			m.object.EXPECT().Tombstone(gomock.Any(), int64(4), int64(101), testNow).Return(int64(1), nil),
			m.object.EXPECT().Tombstone(gomock.Any(), int64(7), int64(102), testNow).Return(int64(0), assert.AnError),
		)

		err := svc.PurgeDeviceSyncObjects(ctx, testUserID, testFingerprint)

		assert.ErrorIs(t, err, assert.AnError)
		assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxRollback}, txLog.Events())
		assert.Empty(t, stub.recordedCalls())
	})
}

// ── Agent 落墓碑时，浏览器为它排的那份顺序跟着消失 ──────────────────────────

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

// 一次 Push 只能从账号序列取一次版本号。
//
// 从前是每条 item 各取一次，而 NextVersion 自己是一个嵌套事务(SAVEPOINT)加两条
// 语句(INSERT … ON DUPLICATE KEY UPDATE … LAST_INSERT_ID 再 SELECT LAST_INSERT_ID)。
// api/sync 允许一批 500 条，于是一次 Push 在**同一个外层事务里**要发上千次往返。
//
// NextVersion(ctx, userID, n) 的批量参数本来就是为这件事准备的(它返回这一批里最大
// 的那个版本号),只是从没被用过。整批只取一次,往返于是只剩一次。
//
// 取号本身仍在外层事务里,那一条不能省(见
// TestPush_ThenVersionsAreAllocatedInsideTheCommittingTransaction):行锁持到提交是
// 「版本号顺序 == 提交顺序」的全部依据。省掉的是往返次数,不是锁。
func TestPush_GivenManyItems_ThenTakesTheWholeVersionBlockAtOnce(t *testing.T) {
	convey.Convey("一批多条只取一次版本号", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().FindMany(gomock.Any(), testUserID, []string{"sync-p1", "sync-p2", "sync-p3"}).
			Return(map[string]*sync_entity.SyncObject{}, nil)
		// 一次取走 3 个,返回的是这一批里最大的那个 → 本批依次拿到 8、9、10。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(3)).Return(int64(10), nil)
		var saved []*sync_entity.SyncObject
		captureCreateBatch(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{
				projectItem("sync-p1", 0),
				projectItem("sync-p2", 0),
				projectItem("sync-p3", 0),
			}})

		assert.NoError(t, err)
		assert.Len(t, out.Results, 3)
		assert.Equal(t, []int64{8, 9, 10},
			[]int64{out.Results[0].Version, out.Results[1].Version, out.Results[2].Version},
			"块里的版本号必须按 item 顺序递增发放")
		assert.Len(t, saved, 3)
		assert.NoError(t, m.sql.ExpectationsWereMet())
	})
}

// 版本号必须在**提交这批写入的那个事务里**取。
//
// sync_account_seqs 上那一行的行锁持到事务提交，因此只要取号发生在事务内，「谁先
// 取到号」与「谁先提交」就是同一个顺序。下行只认这一个顺序：ListSince 按
// version > cursor 取，Pull 把游标推到本页见过的最高版本。取号挪到事务之前，两件事
// 各自成序，于是有这个交错：
//
//	副本 A 取到 v100，开始一个 500 条的长事务；
//	副本 B 取到 v101，先提交；
//	设备拉到 v101，游标存 101；
//	A 随后提交 v100 —— 这一行对这台设备永远不会再被投递。
//
// 这一层测不出那个交错本身：仓储是 mock，行锁与并发提交都不在场。能测、也必须测的
// 是让交错不可能发生的那个机制——取号与写入同在一个事务里。
func TestPush_ThenVersionsAreAllocatedInsideTheCommittingTransaction(t *testing.T) {
	convey.Convey("取版本号取在提交这批写入的事务里", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		expectFindMany(m)

		var allocatedInTx []bool
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).DoAndReturn(
			func(ctx context.Context, _, _ int64) (int64, error) {
				allocatedInTx = append(allocatedInTx, hubtest.InTransaction(ctx))
				return 5, nil
			})
		var savedInTx []bool
		m.object.EXPECT().CreateBatch(gomock.Any(), gomock.Any()).DoAndReturn(
			func(ctx context.Context, objs []*sync_entity.SyncObject) error {
				for range objs {
					savedInTx = append(savedInTx, hubtest.InTransaction(ctx))
				}
				return nil
			})

		_, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-a", 0), projectItem("sync-b", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, []bool{true}, allocatedInTx,
			"版本号取在事务外，取号顺序就不再是提交顺序，先取到号的那次提交晚了就漏投")
		assert.Equal(t, []bool{true, true}, savedInTx)
		assert.NoError(t, m.sql.ExpectationsWereMet())
	})
}

// ── Push 的库内结果：同一组断言在逐条读写与批量读写两种实现下都必须成立 ─────────

// memObjectRepo 是 sync_objects 在服务层测试里的内存替身。它按库的真实语义裁决
// 带版本条件的覆盖、墓碑与**两条**唯一键（uk_sync_objects_identity、
// uk_sync_objects_natural），所以下面这几条用例断言的是「这一次 Push 之后库里是什么、
// 应答里是什么」，而不是「仓储被怎样调用」——Push 的读写方式换掉之后它们照样要绿。
type memObjectRepo struct {
	// 没被 Push 用到的方法一调就 nil panic：这里只替身写路径。
	sync_repo.SyncObjectRepo

	rows []*sync_entity.SyncObject
	// hidden 里的行读不到、改不动，只参与唯一键裁决：用来造出「不变量坏掉」的局面
	// ——库里明明有，Push 却没读到。
	hidden []*sync_entity.SyncObject
	nextID int64

	identityErr *mysqldriver.MySQLError
	naturalErr  *mysqldriver.MySQLError
}

func newMemObjectRepo(rows ...*sync_entity.SyncObject) *memObjectRepo {
	r := &memObjectRepo{
		nextID: 100,
		identityErr: &mysqldriver.MySQLError{Number: 1062,
			Message: "Duplicate entry for key 'sync_objects.uk_sync_objects_identity'"},
		naturalErr: &mysqldriver.MySQLError{Number: 1062,
			Message: "Duplicate entry for key 'sync_objects.uk_sync_objects_natural'"},
	}
	for _, row := range rows {
		cp := *row
		r.rows = append(r.rows, &cp)
	}
	return r
}

func isNaturalKind(kind string) bool {
	return kind == sync_entity.KindProjectLocation || kind == sync_entity.KindAgentBackendCLI
}

func (r *memObjectRepo) visible(userID int64, syncID string) *sync_entity.SyncObject {
	for _, row := range r.rows {
		if row.UserID == userID && row.SyncID == syncID {
			return row
		}
	}
	return nil
}

func (r *memObjectRepo) liveByKey(userID int64, kind, scope, fingerprint string) *sync_entity.SyncObject {
	for _, row := range r.rows {
		if row.UserID == userID && row.Kind == kind && row.ScopeSyncID == scope &&
			row.AgentredFingerprint == fingerprint && !row.IsDeleted() {
			cp := *row
			return &cp
		}
	}
	return nil
}

// checkNatural 是 uk_sync_objects_natural：存活、带自然键的 kind 在同一
// （账号, scope, 指纹, kind）上只允许一行。
func (r *memObjectRepo) checkNatural(obj, self *sync_entity.SyncObject) error {
	if !isNaturalKind(obj.Kind) || obj.IsDeleted() {
		return nil
	}
	for _, set := range [][]*sync_entity.SyncObject{r.rows, r.hidden} {
		for _, row := range set {
			if row != self && row.UserID == obj.UserID && row.Kind == obj.Kind &&
				row.ScopeSyncID == obj.ScopeSyncID && row.AgentredFingerprint == obj.AgentredFingerprint &&
				!row.IsDeleted() {
				return r.naturalErr
			}
		}
	}
	return nil
}

func (r *memObjectRepo) insert(obj *sync_entity.SyncObject) error {
	for _, set := range [][]*sync_entity.SyncObject{r.rows, r.hidden} {
		for _, row := range set {
			if row.UserID == obj.UserID && row.SyncID == obj.SyncID {
				return r.identityErr
			}
		}
	}
	if err := r.checkNatural(obj, nil); err != nil {
		return err
	}
	r.nextID++
	obj.ID = r.nextID
	cp := *obj
	r.rows = append(r.rows, &cp)
	return nil
}

func (r *memObjectRepo) Find(_ context.Context, userID int64, syncID string) (*sync_entity.SyncObject, error) {
	row := r.visible(userID, syncID)
	if row == nil {
		return nil, nil
	}
	cp := *row
	return &cp, nil
}

func (r *memObjectRepo) FindLocationByNaturalKey(
	_ context.Context, userID int64, projectSyncID, fingerprint string,
) (*sync_entity.SyncObject, error) {
	return r.liveByKey(userID, sync_entity.KindProjectLocation, projectSyncID, fingerprint), nil
}

// Save 与 sync_repo.Save 同义：带版本条件的 UPDATE，没命中才普通 INSERT。
func (r *memObjectRepo) Save(_ context.Context, obj *sync_entity.SyncObject) error {
	if row := r.visible(obj.UserID, obj.SyncID); row != nil && row.Version < obj.Version {
		if err := r.checkNatural(obj, row); err != nil {
			return err
		}
		id, createtime := row.ID, row.Createtime
		*row = *obj
		row.ID, row.Createtime = id, createtime
		return nil
	}
	return r.insert(obj)
}

func (r *memObjectRepo) Tombstone(_ context.Context, id, version, nowMs int64) (int64, error) {
	for _, row := range r.rows {
		if row.ID == id && !row.IsDeleted() {
			row.DeletedAt, row.Version, row.Updatetime = nowMs, version, nowMs
			return 1, nil
		}
	}
	return 0, nil
}

func (r *memObjectRepo) FindMany(
	_ context.Context, userID int64, syncIDs []string,
) (map[string]*sync_entity.SyncObject, error) {
	out := map[string]*sync_entity.SyncObject{}
	for _, syncID := range syncIDs {
		if row := r.visible(userID, syncID); row != nil {
			cp := *row
			out[syncID] = &cp
		}
	}
	return out, nil
}

func (r *memObjectRepo) FindLiveByNaturalKeys(
	_ context.Context, userID int64, keys []sync_repo.NaturalKey,
) (map[sync_repo.NaturalKey]*sync_entity.SyncObject, error) {
	out := map[sync_repo.NaturalKey]*sync_entity.SyncObject{}
	for _, key := range keys {
		if row := r.liveByKey(userID, key.Kind, key.ScopeSyncID, key.AgentredFingerprint); row != nil {
			out[key] = row
		}
	}
	return out, nil
}

// CreateBatch 与 sync_repo.CreateBatch 同义：逐行普通 INSERT，撞键即停。
func (r *memObjectRepo) CreateBatch(_ context.Context, objs []*sync_entity.SyncObject) error {
	for _, obj := range objs {
		if err := r.insert(obj); err != nil {
			return err
		}
	}
	return nil
}

func (r *memObjectRepo) snapshot() []sync_entity.SyncObject {
	out := make([]sync_entity.SyncObject, 0, len(r.rows))
	for _, row := range r.rows {
		out = append(out, *row)
	}
	return out
}

// setupPushStoreTest 在 setupSyncTxTest 之上把 sync_objects 换成 memObjectRepo。
func setupPushStoreTest(t *testing.T, rows ...*sync_entity.SyncObject) (
	context.Context, *hubtest.TxLog, *syncMocks, *syncSvc, *memObjectRepo,
) {
	t.Helper()
	ctx, txLog, m, svc := setupSyncTxTest(t)
	store := newMemObjectRepo(rows...)
	sync_repo.RegisterSyncObject(store)
	onlineDevice(m)
	return ctx, txLog, m, svc, store
}

func locationItem(kind, syncID string, base int64) PushItem {
	return PushItem{
		Kind: kind, SyncID: syncID, BaseVersion: base, UpdatedAt: testNow,
		ScopeSyncID: "scope-1", AgentredFingerprint: "fp-a",
		Payload: []byte(fmt.Sprintf(`{"from":%q}`, syncID)),
	}
}

// 同一批里同一个同步标识出现两次：第二条面对的是第一条刚落下的那一版，基版本对不上
// 就是冲突——与分两次 Push 推上来完全同形。库里最后是第二条的内容与版本，一行。
func TestPush_GivenSameSyncIDTwiceInOneBatch_ThenSecondIsConflictAgainstTheFirst(t *testing.T) {
	convey.Convey("同批同 sync_id", t, func() {
		convey.Convey("server 从未见过这个同步标识", func() {
			ctx, txLog, m, svc, store := setupPushStoreTest(t)
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(5), nil)
			first, second := projectItem("sync-dup", 0), projectItem("sync-dup", 0)
			first.Payload, second.Payload = []byte(`{"name":"first"}`), []byte(`{"name":"second"}`)

			out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
				Items: []PushItem{first, second}})

			assert.NoError(t, err)
			assert.Equal(t, []PushItemResult{
				{SyncID: "sync-dup", Kind: sync_entity.KindProject, Status: PushStatusAccepted, Version: 4},
				{SyncID: "sync-dup", Kind: sync_entity.KindProject, Status: PushStatusConflict, Version: 5,
					OverwrittenVersion: 4, OverwrittenOriginFingerprint: pushingFingerprint,
					OverwrittenPayload: `{"name":"first"}`},
			}, out.Results)
			assert.Equal(t, []sync_entity.SyncObject{{
				ID: 101, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-dup",
				Payload: `{"name":"second"}`, Version: 5, SyncUpdatedAt: testNow,
				OriginFingerprint: pushingFingerprint, Createtime: testNow, Updatetime: testNow,
			}}, store.snapshot())
			assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxCommit}, txLog.Events())
		})

		convey.Convey("库里已有这一行", func() {
			ctx, _, m, svc, store := setupPushStoreTest(t, &sync_entity.SyncObject{
				ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-dup",
				Payload: `{"name":"stored"}`, Version: 3, OriginFingerprint: "fp-9", Createtime: 111, Updatetime: 111,
			})
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(5), nil)
			first, second := projectItem("sync-dup", 3), projectItem("sync-dup", 3)
			first.Payload, second.Payload = []byte(`{"name":"first"}`), []byte(`{"name":"second"}`)

			out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
				Items: []PushItem{first, second}})

			assert.NoError(t, err)
			assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
			assert.Equal(t, int64(4), out.Results[0].Version)
			assert.Equal(t, PushStatusConflict, out.Results[1].Status)
			assert.Equal(t, int64(5), out.Results[1].Version)
			assert.Equal(t, int64(4), out.Results[1].OverwrittenVersion)
			assert.Equal(t, `{"name":"first"}`, out.Results[1].OverwrittenPayload)
			assert.Equal(t, []sync_entity.SyncObject{{
				ID: 11, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-dup",
				Payload: `{"name":"second"}`, Version: 5, SyncUpdatedAt: testNow,
				OriginFingerprint: pushingFingerprint, Createtime: 111, Updatetime: testNow,
			}}, store.snapshot())
		})
	})
}

// R4b 合并在库里的结果：自然键上原来那行落墓碑（拿较小的号），本次上行以更大的号存活。
// 两种带自然键的 kind 同一套规则。
func TestPush_GivenNaturalKeyTakenByStoredRow_ThenStoredRowTombstonedAndIncomingLives(t *testing.T) {
	for _, kind := range []string{sync_entity.KindProjectLocation, sync_entity.KindAgentBackendCLI} {
		convey.Convey("自然键被库里另一行占着: "+kind, t, func() {
			ctx, _, m, svc, store := setupPushStoreTest(t, &sync_entity.SyncObject{
				ID: 55, UserID: testUserID, Kind: kind, SyncID: "old", ScopeSyncID: "scope-1",
				AgentredFingerprint: "fp-a", Payload: `{"from":"old"}`, Version: 4, OriginFingerprint: "fp-9",
			})
			gomock.InOrder(
				m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil),
				m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(9), nil),
			)

			out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
				Items: []PushItem{locationItem(kind, "new", 0)}})

			assert.NoError(t, err)
			assert.Equal(t, []PushItemResult{{
				SyncID: "new", Kind: kind, Status: PushStatusAccepted, Version: 9,
				MergedSyncID: "old", MergedVersion: 4, MergedOriginFingerprint: "fp-9",
			}}, out.Results)
			assert.Equal(t, []sync_entity.SyncObject{
				{ID: 55, UserID: testUserID, Kind: kind, SyncID: "old", ScopeSyncID: "scope-1",
					AgentredFingerprint: "fp-a", Payload: `{"from":"old"}`, Version: 8, OriginFingerprint: "fp-9",
					DeletedAt: testNow, Updatetime: testNow},
				{ID: 101, UserID: testUserID, Kind: kind, SyncID: "new", ScopeSyncID: "scope-1",
					AgentredFingerprint: "fp-a", Payload: `{"from":"new"}`, Version: 9, SyncUpdatedAt: testNow,
					OriginFingerprint: pushingFingerprint, Createtime: testNow, Updatetime: testNow},
			}, store.snapshot())
		})
	}
}

// 同一批里两条新行落在同一个自然键上：后一条合并掉的是前一条**刚落下**的那行。
// 前一条最终是一块墓碑——内容是它自己的，版本是后一条先取到的那个较小的号——后一条
// 以补领的更大号存活。
func TestPush_GivenTwoNewRowsOnOneNaturalKeyInOneBatch_ThenFirstIsTombstonedBySecond(t *testing.T) {
	convey.Convey("同批两条新行撞同一自然键", t, func() {
		ctx, txLog, m, svc, store := setupPushStoreTest(t)
		gomock.InOrder(
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(2), nil),
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(3), nil),
		)
		kind := sync_entity.KindProjectLocation

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{locationItem(kind, "loc-B", 0), locationItem(kind, "loc-C", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, []PushItemResult{
			{SyncID: "loc-B", Kind: kind, Status: PushStatusAccepted, Version: 1},
			{SyncID: "loc-C", Kind: kind, Status: PushStatusAccepted, Version: 3,
				MergedSyncID: "loc-B", MergedVersion: 1, MergedOriginFingerprint: pushingFingerprint},
		}, out.Results)
		assert.Equal(t, []sync_entity.SyncObject{
			{ID: 101, UserID: testUserID, Kind: kind, SyncID: "loc-B", ScopeSyncID: "scope-1",
				AgentredFingerprint: "fp-a", Payload: `{"from":"loc-B"}`, Version: 2, SyncUpdatedAt: testNow,
				OriginFingerprint: pushingFingerprint, DeletedAt: testNow, Createtime: testNow, Updatetime: testNow},
			{ID: 102, UserID: testUserID, Kind: kind, SyncID: "loc-C", ScopeSyncID: "scope-1",
				AgentredFingerprint: "fp-a", Payload: `{"from":"loc-C"}`, Version: 3, SyncUpdatedAt: testNow,
				OriginFingerprint: pushingFingerprint, Createtime: testNow, Updatetime: testNow},
		}, store.snapshot())
		assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxCommit}, txLog.Events())
	})
}

// 同一批里前一条把库里那行合并成墓碑，后一条又拿着那行的旧副本推非删除：R6 的复活
// 守卫看到的必须是这一批里刚落下的墓碑，照拒，并回报墓碑的版本。
func TestPush_GivenRowTombstonedEarlierInTheBatch_ThenLaterRevivalIsRejected(t *testing.T) {
	convey.Convey("同批先合并成墓碑、后复活", t, func() {
		kind := sync_entity.KindProjectLocation
		ctx, _, m, svc, store := setupPushStoreTest(t, &sync_entity.SyncObject{
			ID: 55, UserID: testUserID, Kind: kind, SyncID: "loc-A", ScopeSyncID: "scope-1",
			AgentredFingerprint: "fp-a", Payload: `{"from":"loc-A"}`, Version: 4, OriginFingerprint: "fp-9",
		})
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(11), nil)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{locationItem(kind, "loc-B", 0), locationItem(kind, "loc-A", 4)}})

		assert.NoError(t, err)
		assert.Equal(t, []PushItemResult{
			{SyncID: "loc-B", Kind: kind, Status: PushStatusAccepted, Version: 11,
				MergedSyncID: "loc-A", MergedVersion: 4, MergedOriginFingerprint: "fp-9"},
			{SyncID: "loc-A", Kind: kind, Status: PushStatusRejected, Reason: PushRejectReasonDeleted, Version: 10},
		}, out.Results)
		assert.Equal(t, []sync_entity.SyncObject{
			{ID: 55, UserID: testUserID, Kind: kind, SyncID: "loc-A", ScopeSyncID: "scope-1",
				AgentredFingerprint: "fp-a", Payload: `{"from":"loc-A"}`, Version: 10, OriginFingerprint: "fp-9",
				DeletedAt: testNow, Updatetime: testNow},
			{ID: 101, UserID: testUserID, Kind: kind, SyncID: "loc-B", ScopeSyncID: "scope-1",
				AgentredFingerprint: "fp-a", Payload: `{"from":"loc-B"}`, Version: 11, SyncUpdatedAt: testNow,
				OriginFingerprint: pushingFingerprint, Createtime: testNow, Updatetime: testNow},
		}, store.snapshot())
	})
}

// 落库撞上唯一键（库里有、Push 却没读到——不变量坏了）时，整批以那个数据库错误原样
// 失败：事务回滚、不广播。吞掉它等于给设备回一个库里不存在的版本号。
func TestPush_GivenInsertHitsUniqueKey_ThenWholePushFailsWithThatError(t *testing.T) {
	convey.Convey("落库撞唯一键", t, func() {
		kind := sync_entity.KindProjectLocation
		for _, tc := range []struct {
			name   string
			hidden *sync_entity.SyncObject
			item   PushItem
			want   func(*memObjectRepo) error
		}{
			{"撞身份键",
				&sync_entity.SyncObject{ID: 9, UserID: testUserID, Kind: sync_entity.KindProject, SyncID: "sync-ghost", Version: 3},
				projectItem("sync-ghost", 0),
				func(r *memObjectRepo) error { return r.identityErr }},
			{"撞自然键",
				&sync_entity.SyncObject{ID: 9, UserID: testUserID, Kind: kind, SyncID: "loc-ghost",
					ScopeSyncID: "scope-1", AgentredFingerprint: "fp-a", Version: 3},
				locationItem(kind, "loc-B", 0),
				func(r *memObjectRepo) error { return r.naturalErr }},
		} {
			convey.Convey(tc.name, func() {
				ctx, txLog, m, svc, store := setupPushStoreTest(t)
				stub := registerAccountChanStub(t)
				store.hidden = append(store.hidden, tc.hidden)
				m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(5), nil)

				out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
					Items: []PushItem{projectItem("sync-ok", 0), tc.item}})

				assert.Nil(t, out)
				assert.ErrorIs(t, err, tc.want(store))
				assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxRollback}, txLog.Events())
				assert.Empty(t, stub.recordedCalls())
			})
		}
	})
}

// 要求 7：一次 Push 在持锁事务里的往返次数不随 item 数线性增长。取号之后，已有行一条
// `sync_id IN` 读回、自然键一条批量查重、新对象一条多行 INSERT——整批满载（api/sync
// 允许 500 条）时也是这几条。逐条的 Find / FindLocationByNaturalKey / Save 没有
// EXPECT，调用一次 gomock 就判失败。
func TestPush_GivenFullBatchOfNewItems_ThenReadsAndInsertsInConstantBatchedStatementsInsideTheLock(t *testing.T) {
	convey.Convey("满载一批新对象：读与新建各一次批量语句，都在取号的事务里", t, func() {
		ctx, txLog, m, svc := setupSyncTxTest(t)
		onlineDevice(m)
		const n = 500
		items := make([]PushItem, 0, n)
		for i := 0; i < n; i++ {
			if i%2 == 0 {
				items = append(items, projectItem(fmt.Sprintf("p-%d", i), 0))
				continue
			}
			items = append(items, PushItem{
				Kind: sync_entity.KindProjectLocation, SyncID: fmt.Sprintf("loc-%d", i), UpdatedAt: testNow,
				ScopeSyncID: fmt.Sprintf("proj-%d", i), AgentredFingerprint: "fp-a", Payload: []byte(`{}`),
			})
		}

		var steps []string
		record := func(ctx context.Context, step string) {
			steps = append(steps, fmt.Sprintf("%s inTx=%t %v", step, hubtest.InTransaction(ctx), txLog.Events()))
		}
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(n)).DoAndReturn(
			func(ctx context.Context, _, _ int64) (int64, error) {
				record(ctx, "NextVersion")
				return n, nil
			})
		m.object.EXPECT().FindMany(gomock.Any(), testUserID, gomock.Len(n)).DoAndReturn(
			func(ctx context.Context, _ int64, _ []string) (map[string]*sync_entity.SyncObject, error) {
				record(ctx, "FindMany")
				return map[string]*sync_entity.SyncObject{}, nil
			})
		m.object.EXPECT().FindLiveByNaturalKeys(gomock.Any(), testUserID, gomock.Len(n/2)).DoAndReturn(
			func(ctx context.Context, _ int64, _ []sync_repo.NaturalKey) (map[sync_repo.NaturalKey]*sync_entity.SyncObject, error) {
				record(ctx, "FindLiveByNaturalKeys")
				return map[sync_repo.NaturalKey]*sync_entity.SyncObject{}, nil
			})
		var inserted []int64
		m.object.EXPECT().CreateBatch(gomock.Any(), gomock.Len(n)).DoAndReturn(
			func(ctx context.Context, objs []*sync_entity.SyncObject) error {
				record(ctx, "CreateBatch")
				for _, obj := range objs {
					inserted = append(inserted, obj.Version)
				}
				return nil
			})

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID, Items: items})

		assert.NoError(t, err)
		assert.Equal(t, []string{
			"NextVersion inTx=true [BEGIN]",
			"FindMany inTx=true [BEGIN]",
			"FindLiveByNaturalKeys inTx=true [BEGIN]",
			"CreateBatch inTx=true [BEGIN]",
		}, steps)
		assert.Equal(t, []string{hubtest.TxBegin, hubtest.TxCommit}, txLog.Events())
		// 版本号照旧按 item 顺序发放 [1, n]，插入顺序也是 item 顺序。
		want := make([]int64, n)
		for i := range want {
			want[i] = int64(i + 1)
			assert.Equal(t, PushStatusAccepted, out.Results[i].Status)
			assert.Equal(t, want[i], out.Results[i].Version)
		}
		assert.Equal(t, want, inserted)
	})
}

// 同一批里先删掉自然键上那行、再在同一个键上新建：删除之后键已空出来，新建的那条不合并
// 任何东西，也不多取版本号——与分两次 Push 推上来同形。
func TestPush_GivenDeleteThenRecreateOnOneNaturalKeyInOneBatch_ThenNoMerge(t *testing.T) {
	convey.Convey("同批先删后建同一自然键", t, func() {
		kind := sync_entity.KindProjectLocation
		ctx, _, m, svc, store := setupPushStoreTest(t, &sync_entity.SyncObject{
			ID: 55, UserID: testUserID, Kind: kind, SyncID: "loc-A", ScopeSyncID: "scope-1",
			AgentredFingerprint: "fp-a", Payload: `{"from":"loc-A"}`, Version: 4, OriginFingerprint: "fp-9",
		})
		// 只有整批这一次取号：新建那条若误判成合并，会多补领一个号，gomock 当场判失败。
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(2)).Return(int64(6), nil)
		deletion := locationItem(kind, "loc-A", 4)
		deletion.DeletedAt = testNow

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{deletion, locationItem(kind, "loc-C", 0)}})

		assert.NoError(t, err)
		assert.Equal(t, []PushItemResult{
			{SyncID: "loc-A", Kind: kind, Status: PushStatusAccepted, Version: 5},
			{SyncID: "loc-C", Kind: kind, Status: PushStatusAccepted, Version: 6},
		}, out.Results)
		assert.Equal(t, []sync_entity.SyncObject{
			{ID: 55, UserID: testUserID, Kind: kind, SyncID: "loc-A", ScopeSyncID: "scope-1",
				AgentredFingerprint: "fp-a", Payload: `{"from":"loc-A"}`, Version: 5, SyncUpdatedAt: testNow,
				OriginFingerprint: pushingFingerprint, DeletedAt: testNow, Updatetime: testNow},
			{ID: 101, UserID: testUserID, Kind: kind, SyncID: "loc-C", ScopeSyncID: "scope-1",
				AgentredFingerprint: "fp-a", Payload: `{"from":"loc-C"}`, Version: 6, SyncUpdatedAt: testNow,
				OriginFingerprint: pushingFingerprint, Createtime: testNow, Updatetime: testNow},
		}, store.snapshot())
	})
}
