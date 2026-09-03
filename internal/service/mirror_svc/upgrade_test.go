package mirror_svc

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
)

// selfUpdateReply 是这台假 daemon 对下一次 agentred.self_update 的答复。用例设它，
// dispatch 原样交回——受理判定本身归 daemon（规格「远程一键升级」），server 这一侧
// 只负责把调用送到、把应答翻成业务判据。
func (f *fakeRelay) setSelfUpdateReply(reply *agentrewire.AgentredSelfUpdateResponse) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.selfUpdateReply = reply
}

func (f *fakeRelay) AgentredSelfUpdate(
	_ context.Context, request *agentrewire.AgentredSelfUpdateRequest,
) (*agentrewire.AgentredSelfUpdateResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{
		method: agentrewire.RpcMethod_RPC_METHOD_AGENTRED_SELF_UPDATE, request: request,
	})
	if f.selfUpdateReply != nil {
		return f.selfUpdateReply, nil
	}
	return &agentrewire.AgentredSelfUpdateResponse{Accepted: true, TargetVersion: "0.6.0"}, nil
}

// ── 控制台的一键升级：拨一台机器、发一次调用、用完就关 ──────────────────────

// Given 一台空闲的在线机器；When 控制台点了「升级 agentred」；
// Then 调用真的到了那台机器（且没有带 force），受理结果原样交回，连接当场收掉。
func TestSupervisor_UpgradeMachine_AcceptedWithoutForce(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	_, attachesBefore, detachesBefore := a.net.counts()

	result, err := a.sup.UpgradeMachine(context.Background(), testUserID, testMachine, false)

	require.NoError(t, err)
	assert.True(t, result.Accepted)
	assert.Equal(t, "0.6.0", result.TargetVersion)
	assert.Equal(t, UpgradeRejectNone, result.RejectReason)
	calls := rig.peer.callsOf(agentrewire.RpcMethod_RPC_METHOD_AGENTRED_SELF_UPDATE)
	require.Len(t, calls, 1)
	assert.False(t, calls[0].(*agentrewire.AgentredSelfUpdateRequest).GetForce(),
		"没有二次确认过的调用绝不能带 force —— 越过活跃轮次那道闸必须是显式的（决策 8）")
	_, attaches, detaches := a.net.counts()
	assert.Equal(t, attachesBefore+1, attaches)
	assert.Equal(t, detachesBefore+1, detaches, "用完当场收掉，不留在请求路径上")
}

// Given 那台机器上还有对话在跑；When 不带 force 地升级；Then 拒绝原因可断言，
// 而那句人话**逐字**来自 daemon —— 界面与命令行对同一件事只说一句话（决策 22）。
func TestSupervisor_UpgradeMachine_ActiveTurnsKeepsTheDaemonWording(t *testing.T) {
	rig := newResidentRig(t)
	const daemonWording = "this machine has 2 running conversation(s); upgrading would interrupt them"
	rig.peer.setSelfUpdateReply(&agentrewire.AgentredSelfUpdateResponse{
		Accepted:     false,
		RejectReason: agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_ACTIVE_TURNS,
		Message:      daemonWording,
		ActiveTurns:  2,
	})
	a := rig.replica(t, replicaA)

	result, err := a.sup.UpgradeMachine(context.Background(), testUserID, testMachine, false)

	require.NoError(t, err)
	assert.False(t, result.Accepted)
	assert.Equal(t, UpgradeRejectActiveTurns, result.RejectReason)
	assert.Equal(t, daemonWording, result.Message, "不重翻一遍：两端与命令行说同一句话")
	assert.Equal(t, int32(2), result.ActiveTurns)
}

// Given 用户在二次确认里点了「仍然升级」；When 带 force 调一次；
// Then force 真的过线到那台机器 —— 它是请求里的一个显式位，不是重试的副作用。
func TestSupervisor_UpgradeMachine_ForceCrossesTheGateOnTheWire(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)

	_, err := a.sup.UpgradeMachine(context.Background(), testUserID, testMachine, true)

	require.NoError(t, err)
	calls := rig.peer.callsOf(agentrewire.RpcMethod_RPC_METHOD_AGENTRED_SELF_UPDATE)
	require.Len(t, calls, 1)
	assert.True(t, calls[0].(*agentrewire.AgentredSelfUpdateRequest).GetForce())
}

// Given 每一种拒绝原因；When 它从 wire 上回来；Then 各自翻成一个可断言的取值 ——
// 调用方按它分支，而不是去认那句人话的字面。
func TestSupervisor_UpgradeMachine_EachRejectReasonIsDistinguishable(t *testing.T) {
	cases := []struct {
		wire agentrewire.AgentredSelfUpdateRejectReason
		want UpgradeRejectReason
	}{
		{agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_ACTIVE_TURNS, UpgradeRejectActiveTurns},
		{agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_IN_PROGRESS, UpgradeRejectInProgress},
		{agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_NOT_WRITABLE, UpgradeRejectNotWritable},
		{agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_ALREADY_LATEST, UpgradeRejectAlreadyLatest},
		{agentrewire.AgentredSelfUpdateRejectReason_AGENTRED_SELF_UPDATE_REJECT_REASON_DOWNLOAD_FAILED, UpgradeRejectDownloadFailed},
	}
	for _, c := range cases {
		t.Run(c.wire.String(), func(t *testing.T) {
			rig := newResidentRig(t)
			rig.peer.setSelfUpdateReply(&agentrewire.AgentredSelfUpdateResponse{
				Accepted: false, RejectReason: c.wire, Message: "nope",
			})
			a := rig.replica(t, replicaA)

			result, err := a.sup.UpgradeMachine(context.Background(), testUserID, testMachine, false)

			require.NoError(t, err)
			assert.Equal(t, c.want, result.RejectReason)
		})
	}
}

// Given 那台机器现在联系不上；When 要升级它；Then 报「机器离线」——
// 调用方据此说「这台机器不在线」，而不是说「升级被拒绝了」。
func TestSupervisor_UpgradeMachine_MachineOfflineReportsOffline(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	a.net.setOnline(false)

	_, err := a.sup.UpgradeMachine(context.Background(), testUserID, testMachine, false)

	require.ErrorIs(t, err, ErrMachineOffline)
	assert.Equal(t, 0, rig.peer.callCount(), "拨不通就一次调用都不该发出去")
}
