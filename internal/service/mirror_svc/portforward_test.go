package mirror_svc

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"
	"github.com/agentre-hub/agentre/pkg/wire/wirecall"
)

// ── 端口转发的拨号面：拨一条专用连接，交给连接池管 ────────────────────────

// Given 一台在线的机器；When 端口转发要一条通往它的连接；
// Then 交回来的是一条**已经握过手**的连接，而且它不像那四个短连接消费者那样用完
// 就收——连接的寿命归调用方（连接池）管。
func TestSupervisor_DialPortForward_HandsOutALiveHandshakenConnection(t *testing.T) {
	rig := newResidentRig(t)
	rig.peer.sessions = []*agentrewire.SessionSummary{machineSession(conv42, "写个爬虫")}
	a := rig.replica(t, replicaA)
	_, attachesBefore, detachesBefore := a.net.counts()

	conn, release, err := a.sup.DialPortForward(context.Background(), testUserID, testMachine, time.Minute)

	require.NoError(t, err)
	require.NotNil(t, conn)
	// 没握手的通道上 daemon 一个方法都不受理，所以这一次调用成了就等于握手成了。
	_, err = wirecall.SessionList(context.Background(), wirecall.On(conn), &agentrewire.SessionListRequest{})
	require.NoError(t, err)

	_, attaches, detaches := a.net.counts()
	assert.Equal(t, attachesBefore+1, attaches)
	assert.Equal(t, detachesBefore, detaches, "拨完不当场收：这条连接的寿命归连接池管")

	release()
	_, _, detachesAfter := a.net.counts()
	assert.Equal(t, detachesBefore+1, detachesAfter, "归还就摘掉中继订阅")
	select {
	case <-conn.Done():
	case <-time.After(time.Second):
		t.Fatal("归还之后这条连接该是关掉的")
	}
	release() // 幂等
}

// Given 一次端口转发的拨号带着自己的预算；When 连接建起来；
// Then 那个预算落在**连接**上（决策 9），不是会话 RPC 那个 15 秒。
func TestSupervisor_DialPortForward_UsesTheCallerBudgetNotTheSessionOne(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	const budget = 3 * time.Minute

	conn, release, err := a.sup.DialPortForward(context.Background(), testUserID, testMachine, budget)

	require.NoError(t, err)
	defer release()
	require.NotNil(t, conn)
	assert.Equal(t, budget, a.net.lastForwardBudget().Round(time.Second),
		"转发另给一个预算：那 15 秒是为会话 RPC 选的，没有依据适用于这里")
	assert.NotEqual(t, defaultCallTimeout, a.net.lastForwardBudget().Round(time.Second))
}

// Given 那台机器现在联系不上；When 端口转发要一条连接；Then 报「机器离线」——
// 控制台据此答「设备离线」那一张失败页，而不是一句泛泛的转发失败。
func TestSupervisor_DialPortForward_MachineOfflineReportsOffline(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	a.net.setOnline(false)

	_, _, err := a.sup.DialPortForward(context.Background(), testUserID, testMachine, time.Minute)

	require.ErrorIs(t, err, ErrMachineOffline)
}

// Given 对端判定协议版本不合；When 端口转发要一条连接；Then 那个判定原样上交，
// 不折成一句「够不着」——两者的下一步完全不同（一个等它回来，一个要升级）。
func TestSupervisor_DialPortForward_ProtocolMismatchIsSurfaced(t *testing.T) {
	rig := newResidentRig(t)
	a := rig.replica(t, replicaA)
	a.net.rejectHandshakeForProtocolVersion()

	_, _, err := a.sup.DialPortForward(context.Background(), testUserID, testMachine, time.Minute)

	require.ErrorIs(t, err, ErrProtocolVersionMismatch)
}
