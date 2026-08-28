package mirror_svc

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// ── 巡检:扫出没人跟的机器并认领 ─────────────────────────────────────────────

// Given 账号在一台在线的机器上保存过一条对话,而这条对话**从来没被镜像过**
// (库里连一行摘要都没有:保存那一刻镜像没开起来,或者进程刚重启);
// When 巡检跑一轮;Then 这台机器被认领,那条对话的转录补齐落库。
//
// 这一条正是「巡检的名单必须来自保存名单本身」的理由:拿镜像已有的摘要当种子,
// 恰恰漏掉巡检唯一存在的理由 —— 一条保存了、却还一个字都没镜像下来的对话。
func TestReconcile_SavedButNeverMirrored_MachineIsPickedUp(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves(saved(testUserID, testMachine, "42"))
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(42, "还没镜像过的")}
	rig.peer.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1), journalRow(42, 2)}
	a := rig.replica(t, replicaA)
	require.Empty(t, rig.store.rowSeqs(testMachine, "42"), "起点:库里一行都没有")

	require.NoError(t, NewReconciler(a.sup).Reconcile(context.Background()))

	assert.True(t, a.sup.follows(testUserID, testMachine))
	assert.Equal(t, []int64{1, 2}, rig.store.rowSeqs(testMachine, "42"))
}

// Given 那台机器不在线;When 巡检跑一轮;Then 不连它、也不占租约 ——
// 它回来时任何副本都接得上,而离线不该让巡检报错。
func TestReconcile_OfflineMachine_NotClaimed(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves(saved(testUserID, testMachine, "42"))
	a := rig.replica(t, replicaA)
	a.net.setOnline(false)

	require.NoError(t, NewReconciler(a.sup).Reconcile(context.Background()))

	connects, _, _ := a.net.counts()
	assert.Zero(t, connects, "离线的机器一次连接都不该发起")
	assert.False(t, a.sup.follows(testUserID, testMachine))
	assert.Zero(t, rig.claims(t, testUserID, testMachine), "也不该占着租约")
}

// Given 这台机器已经被另一个副本跟着;When 本副本巡检;
// Then 不重复认领 —— 同一条对话在任何时刻只被镜像一次。
func TestReconcile_MachineHeldByAnotherReplica_LeftAlone(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves(saved(testUserID, testMachine, "42"))
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	b := rig.replica(t, replicaB)
	claimed, err := a.sup.Follow(context.Background(), testUserID, testMachine, savedOn("42"))
	require.NoError(t, err)
	require.True(t, claimed)

	require.NoError(t, NewReconciler(b.sup).Reconcile(context.Background()))

	connects, _, _ := b.net.counts()
	assert.Zero(t, connects, "别人正跟着的机器不该被第二个副本连上")
	assert.False(t, b.sup.follows(testUserID, testMachine))
	assert.True(t, a.sup.follows(testUserID, testMachine), "认领方不受影响")
}

// Given 跟着这台机器的那一位放手了(机器下线过、或租约丢了);
// When 下一轮巡检;Then 它被重新认领 —— 没有这一轮,一台机器一旦掉出去就再也没人跟。
func TestReconcile_FollowerLetGo_MachineIsPickedUpAgain(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves(saved(testUserID, testMachine, "42"))
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(42, "写个爬虫")}
	rig.peer.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1)}
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	require.NoError(t, NewReconciler(a.sup).Reconcile(ctx))
	require.True(t, a.sup.follows(testUserID, testMachine))
	a.sup.Unfollow(ctx, testUserID, testMachine)
	require.False(t, a.sup.follows(testUserID, testMachine))

	require.NoError(t, NewReconciler(a.sup).Reconcile(ctx))

	assert.True(t, a.sup.follows(testUserID, testMachine), "放手过的机器要在下一轮被重新跟上")
	connects, _, _ := a.net.counts()
	assert.Equal(t, 2, connects)
}

// Given 名单里有两台机器,前一台连不上;When 巡检;
// Then 后一台照样被跟上,失败如实上交 —— 一台坏机器不该让整轮巡检停在半路。
func TestReconcile_OneMachineFails_TheRestStillGetFollowed(t *testing.T) {
	rig := newResidentRig(t)
	const broken = "fp-broken-0"
	newFakeSaves(saved(testUserID, broken, "7"), saved(testUserID, testMachine, "42"))
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(42, "写个爬虫")}
	rig.peer.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1)}
	a := rig.replica(t, replicaA)
	a.net.failConnect(broken)

	err := NewReconciler(a.sup).Reconcile(context.Background())

	require.Error(t, err, "连不上的那台要如实上交,别让巡检看起来一切正常")
	assert.True(t, a.sup.follows(testUserID, testMachine), "后面那台照样跟上")
	assert.Equal(t, []int64{1}, rig.store.rowSeqs(testMachine, "42"))
}

// Given 本副本正跟着一台机器,而账号在**另一个副本**上把它承载的最后一条对话删掉了
// (保存名单里没有它了,库里那份也清了);When 本副本下一轮巡检;
// Then 这台机器被放开 —— 租约交还、通道摘掉,它的实时帧再也写不回库里。
//
// 少了这一步,删除在多副本部署里只兑现一半:删除那一侧摘不到别的副本手里的连接
// （forgetSession 只管本副本),而那条连接的重同步是靠保存名单收敛的 —— 机器上最后
// 一条对话被删掉之后,它连名单都不在了,重同步因此永远不会发生,刚删掉的对话会被
// 下一条实时帧原样写回账号里(决策 2 的隐私边界正是破在这里)。
func TestReconcile_MachineNoLongerCarriesAnySavedConversation_IsLetGo(t *testing.T) {
	rig := newResidentRig(t)
	follows := newFakeSaves(saved(testUserID, testMachine, "42"))
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(42, "写个爬虫")}
	rig.peer.journal[42] = []*agentrewire.JournaledNotification{journalRow(42, 1)}
	a := rig.replica(t, replicaA)
	ctx := context.Background()
	require.NoError(t, NewReconciler(a.sup).Reconcile(ctx))
	require.True(t, a.sup.follows(testUserID, testMachine))
	require.Equal(t, []int64{1}, rig.store.rowSeqs(testMachine, "42"))

	// 另一个副本上的删除:名单里撤掉这一条,server 上那份内容当场清干净。
	require.NoError(t, follows.Delete(ctx, testUserID, testMachine, "42"))
	require.NoError(t, rig.store.DeleteFrames(ctx, testUserID, testMachine, "42"))
	require.NoError(t, rig.store.DeleteSummary(ctx, testUserID, testMachine, "42"))

	require.NoError(t, NewReconciler(a.sup).Reconcile(ctx))

	assert.False(t, a.sup.follows(testUserID, testMachine),
		"一条已保存对话都不承载的机器不该继续占着连接")
	assert.Zero(t, rig.claims(t, testUserID, testMachine), "租约要交还,别的副本才接得上")
	_, _, detaches := a.net.counts()
	assert.Equal(t, 1, detaches, "通道要摘干净")

	// 那台机器照旧在推实时帧(它自己那份对话还在跑):删掉的这一条一个字都不该回来。
	a.net.emit(t, notification(42, 2, "又长了一句"))
	assert.Never(t, func() bool {
		return len(rig.store.rowSeqs(testMachine, "42")) > 0 ||
			len(rig.store.summaryOf(testUserID, testMachine, "42")) > 0
	}, 200*time.Millisecond, 10*time.Millisecond, "已经删掉的对话又被实时帧写回了账号里")
}
