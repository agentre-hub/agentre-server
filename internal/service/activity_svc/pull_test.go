package activity_svc

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/model/entity/activity_entity"
	"github.com/agentre-hub/agentre-server/internal/model/entity/user_entity"
)

// stubPeer 是一台机器：记下收到的请求，并可以让这一次 RPC 失败。真实实现是
// mirror_svc 的 machineConn，本层只依赖那个只含一个方法的窄接口。
type stubPeer struct {
	requests []*agentrewire.ActivityRollupRequest
	response *agentrewire.ActivityRollupResponse
	err      error
}

func (p *stubPeer) ActivityRollup(
	_ context.Context, req *agentrewire.ActivityRollupRequest,
) (*agentrewire.ActivityRollupResponse, error) {
	p.requests = append(p.requests, req)
	if p.err != nil {
		return nil, p.err
	}
	return p.response, nil
}

const testFingerprint = "fp-1"

// TestPull_DisabledNeverAsksTheMachine 覆盖开关关着：一个字节都不发。
//
// 这是开关的全部意义 —— 「用户显式同意之后才上报」。少了这一判，关掉开关的账号仍然
// 每个周期被问一次「你今天干了什么」，而那次问答本身就是上报：机器把计数交出来了，
// 只是服务端这一侧碰巧没有落库。
func TestPull_DisabledNeverAsksTheMachine(t *testing.T) {
	f := setup(t)
	peer := &stubPeer{}
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID}, nil)

	require.NoError(t, Activity().Pull(f.ctx, testUserID, peer, testFingerprint))

	assert.Empty(t, peer.requests, "开关关着时不该向机器发出任何请求")
}

// TestPull_AsksFromTheLatestDayItAlreadyHas 覆盖增量：since_day 取这台机器已经收到的
// 最后一天。
//
// 下界**两端都含**（协议注释同）：今天的计数在这一天里还会变，排除掉最后一天等于
// 永久丢掉那一天 —— 而那一天通常是今天。时区取服务端自己的，一个账号下分散在各地的
// 机器因此落在同一套日界上；两套日界会把同一天的活动劈到两格上。
func TestPull_AsksFromTheLatestDayItAlreadyHas(t *testing.T) {
	f := setup(t)
	peer := &stubPeer{response: &agentrewire.ActivityRollupResponse{
		Buckets: []*agentrewire.ActivityDailyBucket{{
			Day: "2026-08-28", AgentSyncId: "a1", BackendType: "claudecode",
			ProviderKey: "anthropic", ModelKey: "claude-sonnet-5", ProjectSyncId: "p1",
			SessionCount: 3,
		}},
	}}
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, testFingerprint).
		Return("2026-08-27", nil)
	stillEnabled(f)

	var got []*activity_entity.DailyBucket
	// 拉成功就记时刻（见 TestPull_RecordsTheSuccessfulPullEvenWithNoBuckets）。
	f.settings.EXPECT().TouchActivityPull(gomock.Any(), testUserID, gomock.Any()).Return(nil)
	f.daily.EXPECT().ReplaceBucketsFrom(gomock.Any(), testUserID, testFingerprint, gomock.Any(), gomock.Any()).
		DoAndReturn(func(
			_ context.Context, _ int64, _, _ string, buckets []*activity_entity.DailyBucket,
		) error {
			got = buckets
			return nil
		})

	require.NoError(t, Activity().Pull(f.ctx, testUserID, peer, testFingerprint))

	require.Len(t, peer.requests, 1)
	assert.Equal(t, "2026-08-27", peer.requests[0].GetSinceDay())
	// 断言这个名字**对端解得开、而且不是 "Local"**，不是拿实现去证实现：
	// time.Local.String() 在 TZ 没设的机器上就是字面量 "Local"，而 "Local" 在对端解成
	// 对端自己的时区 —— 那正是这条通道最要避免的「两套日界」。写成
	// assert.Equal(time.Local.String(), ...) 的话，这条断言永远不可能红。
	sentZone := peer.requests[0].GetTimeZone()
	assert.NotEqual(t, "Local", sentZone)
	_, err := time.LoadLocation(sentZone)
	assert.NoError(t, err, "对端要拿这个名字去 LoadLocation")
	require.Len(t, got, 1)
	assert.Equal(t, "2026-08-28", got[0].Day)
	assert.Equal(t, "a1", got[0].AgentSyncID)
	assert.Equal(t, "claudecode", got[0].BackendType)
	assert.Equal(t, "anthropic", got[0].ProviderKey)
	assert.Equal(t, "claude-sonnet-5", got[0].ModelKey)
	assert.Equal(t, "p1", got[0].ProjectSyncID)
	assert.Equal(t, int32(3), got[0].SessionCount)
	assert.NotZero(t, got[0].Createtime, "落地时间要有值，否则这一行的时间戳永远是 0")
	assert.NotZero(t, got[0].Updatetime)
}

// TestPull_NoLatestDayBackfillsEverything 覆盖回填：这台机器还没有任何一天。
//
// 空的 since_day 就是「把你有的全给我」。这不是另一种模式、也不需要另一条代码路径 ——
// 第一次拉与后续增量拉的区别只是这一个字段的值。
func TestPull_NoLatestDayBackfillsEverything(t *testing.T) {
	f := setup(t)
	peer := &stubPeer{response: &agentrewire.ActivityRollupResponse{}}
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, testFingerprint).Return("", nil)
	stillEnabled(f)
	// 拉成功就记时刻（见 TestPull_RecordsTheSuccessfulPullEvenWithNoBuckets）。
	f.settings.EXPECT().TouchActivityPull(gomock.Any(), testUserID, gomock.Any()).Return(nil)
	f.daily.EXPECT().ReplaceBucketsFrom(gomock.Any(), testUserID, testFingerprint, gomock.Any(), gomock.Any()).
		Return(nil)

	require.NoError(t, Activity().Pull(f.ctx, testUserID, peer, testFingerprint))

	require.Len(t, peer.requests, 1)
	assert.Empty(t, peer.requests[0].GetSinceDay())
}

// TestPull_MachineFailureSurfaces 覆盖机器答不上来：错误往上抛，且一行都不落。
// 把一次失败的拉取当成「这台机器这一天没有活动」会把已有的计数覆盖成 0。
func TestPull_MachineFailureSurfaces(t *testing.T) {
	f := setup(t)
	peer := &stubPeer{err: errors.New("offline")}
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, testFingerprint).Return("", nil)

	assert.Error(t, Activity().Pull(f.ctx, testUserID, peer, testFingerprint))
}

// TestPull_TakesTheNarrowRollupPortOnly 是一条守卫：本包对机器的全部需要就是
// ActivityRollup 这一个方法。
//
// 它挡的是「把滚存并进 mirror_svc.RelaySession」那个顺手的改法 —— 那会让镜像那一侧
// 也够得着滚存，而滚存回包里只有计数、镜像回包里有标题与转录内容，两者刻意不在一个
// 接口上（machineconn.go 的注释）。
func TestPull_TakesTheNarrowRollupPortOnly(t *testing.T) {
	var _ ActivityPeer = (*stubPeer)(nil)
	port := reflect.TypeOf((*ActivityPeer)(nil)).Elem()
	require.Equal(t, 1, port.NumMethod(), "这个端口只能有一个方法")
	assert.Equal(t, "ActivityRollup", port.Method(0).Name)
}

// TestPull_RecordsTheSuccessfulPullEvenWithNoBuckets 覆盖「最近一次上报」的写入时机。
//
// 一台一周没干活的机器每轮都成功上报一个**空结果**。界面上那句「最近一次上报 12 分钟
// 前」问的是「这条管子还通着吗」——只在拉到桶时才记时刻，它就会停在一周前，把一台
// 完全正常的机器显示成一周没上报。
func TestPull_RecordsTheSuccessfulPullEvenWithNoBuckets(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, testFingerprint).Return("2026-08-20", nil)
	stillEnabled(f)
	f.daily.EXPECT().ReplaceBucketsFrom(gomock.Any(), testUserID, testFingerprint, gomock.Any(), gomock.Len(0)).Return(nil)
	f.settings.EXPECT().TouchActivityPull(gomock.Any(), testUserID, gomock.Any()).Return(nil)

	require.NoError(t, Activity().Pull(f.ctx, testUserID, &stubPeer{
		response: &agentrewire.ActivityRollupResponse{},
	}, testFingerprint))
}

// TestPull_DoesNotRecordAFailedPull 覆盖反面:拉失败时不能写「最近一次上报」。
//
// 写了的话,一台连不上的机器会一直显示「刚刚上报」——而这个数字存在的全部理由就是让
// 用户看出管子断了。
func TestPull_DoesNotRecordAFailedPull(t *testing.T) {
	f := setup(t)
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, testFingerprint).Return("", nil)
	// TouchActivityPull 一次都不该被调到。

	err := Activity().Pull(f.ctx, testUserID, &stubPeer{
		err: errors.New("relay down"),
	}, testFingerprint)
	require.Error(t, err)
}

// TestPull_TheStoredFloorStopsAnUnwantedBackfill 守「不回填」这个选择在拉取这一侧
// 真的生效。
//
// since_day 平时取「这台机器已经收到的最后一天」，而一台从没上报过的机器那个值是空
// 串 —— 也就是「把你有的全给我」。用户在开启弹层里取消了回填，落库的下界是当天；
// 少了这一句，第一次拉取照样把这台机器上全部历史搬上来，而没有任何地方会提示他。
func TestPull_TheStoredFloorStopsAnUnwantedBackfill(t *testing.T) {
	f := setup(t)
	peer := &stubPeer{response: &agentrewire.ActivityRollupResponse{}}
	f.settings.EXPECT().Get(gomock.Any(), testUserID).Return(user_entity.Settings{
		UserID: testUserID, ActivityStatsEnabled: true, ActivityBackfillFrom: day(0),
	}, nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, testFingerprint).Return("", nil)
	stillEnabled(f)
	f.daily.EXPECT().ReplaceBucketsFrom(gomock.Any(), testUserID, testFingerprint, gomock.Any(), gomock.Any()).Return(nil)
	f.settings.EXPECT().TouchActivityPull(gomock.Any(), testUserID, gomock.Any()).Return(nil)

	require.NoError(t, Activity().Pull(f.ctx, testUserID, peer, testFingerprint))

	require.Len(t, peer.requests, 1)
	assert.Equal(t, day(0), peer.requests[0].GetSinceDay())
}

// TestPull_ProgressWinsOverAnOlderFloor 守下界只是**下界**，不是起点。
//
// 一台已经上报到前天的机器，下界却停在两周前（开启那天）。从下界重拉是白拉一遍已经
// 有的十几天，而 upsert 幂等，错不了但每一轮都在做。取两者中较晚的那个：日界是
// "2006-01-02"，逐字节比较恰好就是日期序。
func TestPull_ProgressWinsOverAnOlderFloor(t *testing.T) {
	f := setup(t)
	peer := &stubPeer{response: &agentrewire.ActivityRollupResponse{}}
	f.settings.EXPECT().Get(gomock.Any(), testUserID).Return(user_entity.Settings{
		UserID: testUserID, ActivityStatsEnabled: true, ActivityBackfillFrom: day(14),
	}, nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, testFingerprint).Return(day(2), nil)
	stillEnabled(f)
	f.daily.EXPECT().ReplaceBucketsFrom(gomock.Any(), testUserID, testFingerprint, gomock.Any(), gomock.Any()).Return(nil)
	f.settings.EXPECT().TouchActivityPull(gomock.Any(), testUserID, gomock.Any()).Return(nil)

	require.NoError(t, Activity().Pull(f.ctx, testUserID, peer, testFingerprint))

	require.Len(t, peer.requests, 1)
	assert.Equal(t, day(2), peer.requests[0].GetSinceDay())
}

// TestPull_SwitchedOffDuringTheRoundTripWritesNothing 覆盖关闭确认弹层那句承诺的
// 最后一个漏洞。
//
// 拉取是「读开关 → 发 RPC → 落库」，而 RPC 往返以秒计（定时任务给每台机器 30s 预算）。
// 用户在这段时间里点了关闭：关闭那条路在一个事务里落开关并删光这个账号的计数，弹层
// 显示成功；随后这次在途的拉取把桶写了回去。结果是开关关着、数据还在，而且从此没有
// 任何入口会再去删它 —— 开关已经是关的，用户再点一次也只是把一个关着的开关又关一遍。
//
// 所以落库前要在同一个事务里**带锁**复核一次开关。这里让复核读到「关」：一行都不落，
// 上报时刻也不记（那一轮什么都没成），而且**不是错误** —— 用户关掉开关不该让定时任务
// 在日志里留一条失败。
func TestPull_SwitchedOffDuringTheRoundTripWritesNothing(t *testing.T) {
	f := setup(t)
	peer := &stubPeer{response: &agentrewire.ActivityRollupResponse{
		Buckets: []*agentrewire.ActivityDailyBucket{{Day: day(0), SessionCount: 3}},
	}}
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, testFingerprint).Return(day(1), nil)
	f.db.ExpectBegin()
	// 往返途中被关掉了。
	f.settings.EXPECT().ActivityStatsEnabledForUpdate(gomock.Any(), testUserID).Return(false, nil)
	f.db.ExpectCommit()

	require.NoError(t, Activity().Pull(f.ctx, testUserID, peer, testFingerprint))

	// 没写 ReplaceBucketsFrom / TouchActivityPull 的 EXPECT：调到了就是 gomock 当场失败。
	assert.NoError(t, f.db.ExpectationsWereMet())
}

// stillEnabled 铺好落库那一步的事务：Begin、带锁复核读到「还开着」、Commit。
// 每一条会写库的用例都要它 —— 复核是 Pull 落库路径的一部分，不是某个用例的细节。
func stillEnabled(f *fixture) {
	f.db.ExpectBegin()
	f.settings.EXPECT().ActivityStatsEnabledForUpdate(gomock.Any(), testUserID).Return(true, nil)
	f.db.ExpectCommit()
}

// TestPull_ReplacesExactlyTheWindowItAskedFor 把「问的那一段」与「换掉的那一段」钉成
// 同一个值。
//
// 落库是**替换**而不是合并：机器交上来的是它对 [since_day, ∞) 这一整段的完整答案。
// 两个值一旦分家就是数据错误，而且是不会报错的那种 ——
//
//   - 换掉的比问的宽：多删的那几天再也不会被任何一轮重新问起（下界只会往前走），
//     那段历史静默消失；
//   - 换掉的比问的窄：没被换掉的那几天里，维度组合变过的会话留下一行旧桶，那天的
//     总数凭空多一条对话。
func TestPull_ReplacesExactlyTheWindowItAskedFor(t *testing.T) {
	f := setup(t)
	peer := &stubPeer{response: &agentrewire.ActivityRollupResponse{}}
	f.settings.EXPECT().Get(gomock.Any(), testUserID).
		Return(user_entity.Settings{UserID: testUserID, ActivityStatsEnabled: true}, nil)
	f.daily.EXPECT().LatestDay(gomock.Any(), testUserID, testFingerprint).Return(day(3), nil)
	stillEnabled(f)
	f.daily.EXPECT().
		ReplaceBucketsFrom(gomock.Any(), testUserID, testFingerprint, day(3), gomock.Any()).
		Return(nil)
	f.settings.EXPECT().TouchActivityPull(gomock.Any(), testUserID, gomock.Any()).Return(nil)

	require.NoError(t, Activity().Pull(f.ctx, testUserID, peer, testFingerprint))

	require.Len(t, peer.requests, 1)
	assert.Equal(t, day(3), peer.requests[0].GetSinceDay(), "问的与换的必须是同一段")
}
