package sync_svc

import (
	"testing"

	"github.com/smartystreets/goconvey/convey"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	"agentre-server/internal/model/entity/sync_entity"
)

// ── 单条隔离：一条坏行不再把整批拒掉 ────────────────────────────────────────

// 整批拒是一个永久性的堵：桌面端整批失败时一行都不出队，同一批下一轮再发、再被
// 同一条拒掉，那台机器的上行队列从此不动——连带 R6 的删除也传不出去。
func TestPush_GivenOnePoisonItem_ThenOnlyThatOneIsRejected(t *testing.T) {
	convey.Convey("一批里混进一条坏行", t, func() {
		convey.Convey("对象类型不属于同步组", func() {
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

			bad := projectItem("sync-bad", 0)
			bad.Kind = "llm_provider"
			out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
				Items: []PushItem{projectItem("sync-a", 0), bad, projectItem("sync-b", 0)}})

			assert.NoError(t, err)
			assert.Len(t, out.Results, 3)
			assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
			assert.Equal(t, PushStatusRejected, out.Results[1].Status)
			assert.Equal(t, PushRejectReasonKind, out.Results[1].Reason)
			assert.Equal(t, PushStatusAccepted, out.Results[2].Status)
			assert.Len(t, saved, 2)
		})

		convey.Convey("载荷带了不该过机的东西", func() {
			ctx, m, svc := setupSyncTest(t)
			onlineDevice(m)
			expectTx(m)
			m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-a").Return(nil, nil)
			m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(4), nil)
			var saved []*sync_entity.SyncObject
			captureSave(m, &saved)

			bad := projectItem("sync-bad", 0)
			bad.Payload = []byte(`{"name":"x","agent_backend_id":12}`)
			out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
				Items: []PushItem{projectItem("sync-a", 0), bad}})

			assert.NoError(t, err)
			assert.Equal(t, PushStatusAccepted, out.Results[0].Status)
			assert.Equal(t, PushStatusRejected, out.Results[1].Status)
			assert.Equal(t, PushRejectReasonPayload, out.Results[1].Reason)
			assert.Len(t, saved, 1)
		})

		convey.Convey("同步标识与已有行的类型不符", func() {
			ctx, m, svc := setupSyncTest(t)
			onlineDevice(m)
			expectTx(m)
			m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-a").Return(
				&sync_entity.SyncObject{Kind: sync_entity.KindAgent, SyncID: "sync-a", Version: 3}, nil)

			out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
				Items: []PushItem{projectItem("sync-a", 3)}})

			assert.NoError(t, err)
			assert.Equal(t, PushStatusRejected, out.Results[0].Status)
			assert.Equal(t, PushRejectReasonKind, out.Results[0].Reason)
			assert.Equal(t, int64(3), out.Results[0].Version)
		})
	})
}

// R5 要「追回被覆盖的那一版」，追回的对象只能是**被覆盖掉的正文**。它只在 server
// 手上：上行端手上那一份是覆盖别人的那一份。冲突应答因此把它一并带回去。
func TestPush_GivenConflict_ThenCarriesTheOverwrittenPayload(t *testing.T) {
	convey.Convey("冲突应答带回被覆盖的正文", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-a").Return(&sync_entity.SyncObject{
			Kind: sync_entity.KindProject, SyncID: "sync-a", Version: 7,
			SourceDeviceID: 9, Payload: `{"name":"peer"}`,
		}, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(8), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)

		out, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-a", 3)}})

		assert.NoError(t, err)
		assert.Equal(t, PushStatusConflict, out.Results[0].Status)
		assert.Equal(t, int64(7), out.Results[0].OverwrittenVersion)
		assert.JSONEq(t, `{"name":"peer"}`, out.Results[0].OverwrittenPayload)
	})
}

// ── R6a 的 30 天窗口量的是「游标追平」，不是「最近联系过」 ────────────────────

// 上行不刷新窗口：只会推、从不消费的设备正是 R6a 要拦的那一类。
func TestPush_ThenDoesNotRefreshTheResyncWindow(t *testing.T) {
	convey.Convey("上行不刷新 R6a 的窗口", t, func() {
		ctx, m, svc := setupSyncTest(t)
		onlineDevice(m)
		expectTx(m)
		m.object.EXPECT().Find(gomock.Any(), testUserID, "sync-a").Return(nil, nil)
		m.state.EXPECT().NextVersion(gomock.Any(), testUserID, int64(1)).Return(int64(1), nil)
		var saved []*sync_entity.SyncObject
		captureSave(m, &saved)
		// TouchDeviceState 没有 EXPECT：上行一次也不该调它。

		_, err := svc.Push(ctx, PushInput{UserID: testUserID, DeviceID: testDeviceID,
			Items: []PushItem{projectItem("sync-a", 0)}})

		assert.NoError(t, err)
	})
}

// 下行时这一页还有没消费的增量 → 不刷新窗口。卡在某一行落不了地的设备每 30 秒来
// 一次、每次拿回同一页，last_sync_at 却一直是新的，30 天窗口就永远不触发，那台
// 机器可以拿着任意陈旧的基版本把一个已被回收的删除推回来。
func TestPull_GivenDeviceStillBehind_ThenWindowIsNotRefreshed(t *testing.T) {
	convey.Convey("下行还有没消费完的增量", t, func() {
		ctx, m, svc := setupSyncTest(t)
		m.object.EXPECT().ListSince(gomock.Any(), testUserID, int64(3), DefaultPullLimit).Return(
			[]*sync_entity.SyncObject{{Kind: sync_entity.KindProject, SyncID: "p1", Version: 4}}, nil)
		// TouchDeviceState 没有 EXPECT。

		out, err := svc.Pull(ctx, PullInput{UserID: testUserID, DeviceID: testDeviceID, Cursor: 3})

		assert.NoError(t, err)
		assert.Len(t, out.Items, 1)
	})
}
