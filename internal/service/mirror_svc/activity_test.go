package mirror_svc

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// ActivityRollup 是假机器在滚存这条通道上的答话：只有天与计数。它刻意不带标题、
// 路径与转录内容——这条通道回包里能有的全部东西就是这些，测试里也不该多出一格。
func (f *fakeRelay) ActivityRollup(
	_ context.Context, request *agentrewire.ActivityRollupRequest,
) (*agentrewire.ActivityRollupResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{
		method: agentrewire.RpcMethod_RPC_METHOD_ACTIVITY_ROLLUP, request: request,
	})
	return &agentrewire.ActivityRollupResponse{Buckets: []*agentrewire.ActivityDailyBucket{
		{Day: "2026-08-28", SessionCount: 3},
	}}, nil
}

// ── 活跃统计：拨一台机器、用完就关 ──────────────────────────────────────────

// Given 一台在线的机器；When 走一次 WithMachine 问它要日滚存；
// Then 请求真的到了那台机器，应答原样交回，连接用完当场收掉。
func TestSupervisor_WithMachine_DialsAsksAndClosesTheConnection(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	_, attachesBefore, detachesBefore := a.net.counts()

	var got *agentrewire.ActivityRollupResponse
	err := a.sup.WithMachine(context.Background(), testUserID, testMachine,
		func(peer ActivityRollupClient) error {
			var callErr error
			got, callErr = peer.ActivityRollup(context.Background(),
				&agentrewire.ActivityRollupRequest{SinceDay: "2026-08-20", TimeZone: "Asia/Shanghai"})
			return callErr
		})

	require.NoError(t, err)
	require.Len(t, got.GetBuckets(), 1)
	assert.Equal(t, int32(3), got.GetBuckets()[0].GetSessionCount())
	rollups := rig.peer.callsOf(agentrewire.RpcMethod_RPC_METHOD_ACTIVITY_ROLLUP)
	require.Len(t, rollups, 1)
	sent := rollups[0].(*agentrewire.ActivityRollupRequest)
	assert.Equal(t, "2026-08-20", sent.GetSinceDay())
	assert.Equal(t, "Asia/Shanghai", sent.GetTimeZone())
	_, attaches, detaches := a.net.counts()
	assert.Equal(t, attachesBefore+1, attaches)
	assert.Equal(t, detachesBefore+1, detaches, "用完当场收掉，不留在周期任务的路径上")
}

// Given 一台在线的机器；When 走一次 WithMachine；Then 既不占常驻镜像的租约，
// 也不让本副本从此跟着它——滚存与镜像的隐私边界不同，一次拉取不该顺手把这台机器
// 的转录也接过来。
func TestSupervisor_WithMachine_TakesNoResidentLease(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)

	require.NoError(t, a.sup.WithMachine(context.Background(), testUserID, testMachine,
		func(ActivityRollupClient) error { return nil }))

	assert.Zero(t, rig.claims(t, testUserID, testMachine), "滚存不该占住镜像那份租约")
	assert.False(t, a.sup.follows(testUserID, testMachine))
}

// Given 那台机器现在联系不上；When 要够到它；Then 报「机器离线」，fn 一次都不跑——
// 调用方据此跳过这台机器，而不是把它记成一次失败。
func TestSupervisor_WithMachine_MachineOffline_ReportsOfflineAndSkipsFn(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	a.net.setOnline(false)
	_, attachesBefore, detachesBefore := a.net.counts()

	ran := false
	err := a.sup.WithMachine(context.Background(), testUserID, testMachine,
		func(ActivityRollupClient) error {
			ran = true
			return nil
		})

	require.ErrorIs(t, err, ErrMachineOffline)
	assert.False(t, ran, "拨不通就没有对端可交给 fn")
	_, attaches, detaches := a.net.counts()
	assert.Equal(t, attachesBefore, attaches)
	assert.Equal(t, detachesBefore, detaches, "没建起来的连接不该留下一次摘除")
}

// Given 机器在线但这一次拉取失败了；When 走一次 WithMachine；
// Then 错误原样上交，**连接照样收干净**——失败路径上漏掉一条连接，等于每个周期
// 都在那台机器上多挂一条没人管的通道。
func TestSupervisor_WithMachine_FnFails_StillClosesTheConnection(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	_, attachesBefore, detachesBefore := a.net.counts()

	wanted := errors.New("拉取失败")
	err := a.sup.WithMachine(context.Background(), testUserID, testMachine,
		func(ActivityRollupClient) error { return wanted })

	require.ErrorIs(t, err, wanted)
	_, attaches, detaches := a.net.counts()
	assert.Equal(t, attachesBefore+1, attaches)
	assert.Equal(t, detachesBefore+1, detaches)
}
