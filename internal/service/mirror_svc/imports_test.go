package mirror_svc

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	agentrewire "github.com/agentre-hub/agentre/pkg/wire/agentrewire"

	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
)

// ── 导入本地会话:够到那台机器的那条短连接 ───────────────────────────────────

// Given 一台在线的机器,账号想看看它磁盘上有哪些能导的会话;
// When 走一次 WithPeer;Then 请求真的到了那台机器,应答原样交回,连接用完当场收掉。
//
// 一次 WithPeer 一条连接、多个方法共用:预览是 open + turns 两次调用,各自拨一条
// 等于每看一条候选就多握一次手。
func TestImports_WithPeer_OneConnectionServesEveryCallAndIsClosed(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	rig.peer.candidates = []*agentrewire.TranscriptImportCandidate{{
		Backend: "claudecode", ProviderSessionId: "prov-1", Title: "写个爬虫", Locator: "loc-1",
	}}
	a := rig.replica(t, replicaA)
	_, attachesBefore, detachesBefore := a.net.counts()

	var scanned *agentrewire.TranscriptImportScanResponse
	var opened *agentrewire.TranscriptImportOpenResponse
	err := NewImports(a.sup).WithPeer(context.Background(), testUserID, testMachine,
		func(ctx context.Context, peer TranscriptImportPeer) error {
			var callErr error
			scanned, callErr = peer.TranscriptImportScan(ctx, &agentrewire.TranscriptImportScanRequest{})
			if callErr != nil {
				return callErr
			}
			opened, callErr = peer.TranscriptImportOpen(ctx,
				&agentrewire.TranscriptImportOpenRequest{Backend: "claudecode", Locator: "loc-1"})
			return callErr
		})

	require.NoError(t, err)
	require.Len(t, scanned.GetBackends(), 1)
	assert.Equal(t, "prov-1", scanned.GetBackends()[0].GetCandidates()[0].GetProviderSessionId())
	assert.Equal(t, "loc-1", opened.GetMeta().GetProviderSessionId())
	_, attaches, detaches := a.net.counts()
	assert.Equal(t, attachesBefore+1, attaches, "两个调用共用一条连接")
	assert.Equal(t, detachesBefore+1, detaches, "用完当场收掉,不留在请求路径上")
}

// Given 那台机器现在联系不上;When 要够到它;Then 报「机器离线」——
// 调用方据此说「这台机器不在线」,而不是说「这台机器上没有会话」。
func TestImports_MachineOffline_ReportsOffline(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	a := rig.replica(t, replicaA)
	a.net.setOnline(false)

	err := NewImports(a.sup).WithPeer(context.Background(), testUserID, testMachine,
		func(context.Context, TranscriptImportPeer) error { return errors.New("不该走到这里") })

	require.ErrorIs(t, err, ErrMachineOffline)
}

// Given 那台机器上的 agentred 还不认识 transcriptimport 这一族(回 -32601);
// When 扫它;Then 报「不支持」——它必须与「这台机器上没有会话」分开:后者是问出来的
// 空,前者是这台机器答不出,而两句话在界面上给用户的去处完全不同。
func TestImports_MethodNotFound_PreservesProtocolError(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	rig.peer.transcriptImportErr = &relaywire.Error{
		Code: relaywire.CodeMethodNotFound, Message: "Method not found",
	}
	a := rig.replica(t, replicaA)

	err := NewImports(a.sup).WithPeer(context.Background(), testUserID, testMachine,
		func(ctx context.Context, peer TranscriptImportPeer) error {
			_, callErr := peer.TranscriptImportScan(ctx, &agentrewire.TranscriptImportScanRequest{})
			return callErr
		})

	var wireErr *relaywire.Error
	require.ErrorAs(t, err, &wireErr)
	assert.Equal(t, relaywire.CodeMethodNotFound, wireErr.Code)
}

// Given 执行导入这一次真的写到了那台机器上;When 发 execute;
// Then 铸好的会话号与点名的发起端原样过线 —— 这两格决定导出来的会话是谁的、叫什么号。
func TestImports_Execute_CarriesMintedSessionIDAndNamedOrigin(t *testing.T) {
	rig := newResidentRig(t)
	newFakeSaves()
	a := rig.replica(t, replicaA)

	var result *agentrewire.TranscriptImportExecuteResponse
	err := NewImports(a.sup).WithPeer(context.Background(), testUserID, testMachine,
		func(ctx context.Context, peer TranscriptImportPeer) error {
			var callErr error
			result, callErr = peer.TranscriptImportExecute(ctx, &agentrewire.TranscriptImportExecuteRequest{
				Backend: "claudecode", Locator: "loc-1", SessionId: 4242,
				AgentSyncId: "agent-1", PeerFingerprint: testMachine,
			})
			return callErr
		})

	require.NoError(t, err)
	assert.Equal(t, int64(4242), result.GetSessionId())
	executes := rig.peer.callsOf(agentrewire.RpcMethod_RPC_METHOD_TRANSCRIPT_IMPORT_EXECUTE)
	require.Len(t, executes, 1)
	p := executes[0].(*agentrewire.TranscriptImportExecuteRequest)
	assert.Equal(t, int64(4242), p.GetSessionId())
	assert.Equal(t, testMachine, p.GetPeerFingerprint(),
		"点名发起端是账号级能力:不点名的话这条会话会落在 server 那个合成指纹名下")
	assert.Equal(t, "agent-1", p.GetAgentSyncId())
}
