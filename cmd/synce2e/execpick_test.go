package main

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func target(syncID, agentSyncID, backendSyncID string, order int) *peerObject {
	payload, _ := json.Marshal(execTargetPayload{
		AgentSyncID: agentSyncID, BackendSyncID: backendSyncID, SortOrder: order,
	})
	return &peerObject{Kind: "agent_exec_target", SyncID: syncID, Payload: payload}
}

func backend(syncID, fingerprint string) *peerObject {
	return &peerObject{Kind: "agent_backend", SyncID: syncID, AgentredFingerprint: fingerprint}
}

// The whole point of the simulated peer is this axis: the SAME synced Agent
// resolves to a different target depending on which agentreds the receiving end
// has paired (R2b / R15).
func TestResolveExecTargets_GivenSameAgent_WhenPairingDiffers_ThenPicksDifferentTarget(t *testing.T) {
	objects := map[string]*peerObject{
		"t0":             target("t0", "agent-1", "backend-remote", 0),
		"t1":             target("t1", "agent-1", "backend-local", 1),
		"backend-remote": backend("backend-remote", "fp-build-box"),
		"backend-local":  backend("backend-local", ""),
	}

	pairedRes := resolveExecTargets(objects, "agent-1", []string{"fp-build-box"})
	require.NotNil(t, pairedRes.Picked)
	require.Equal(t, "t0", pairedRes.Picked.SyncID)
	require.Equal(t, "fp-build-box", pairedRes.Picked.Fingerprint)

	unpairedRes := resolveExecTargets(objects, "agent-1", nil)
	require.NotNil(t, unpairedRes.Picked)
	require.Equal(t, "t1", unpairedRes.Picked.SyncID, "the unpaired agentred target must be skipped, not picked")
	require.False(t, unpairedRes.Targets[0].Available)
	require.Equal(t, reasonUnpaired, unpairedRes.Targets[0].Reason)
}

func TestResolveExecTargets_GivenNoTargetAvailable_ThenPickedIsNil(t *testing.T) {
	objects := map[string]*peerObject{
		"t0":             target("t0", "agent-1", "backend-remote", 0),
		"backend-remote": backend("backend-remote", "fp-build-box"),
	}
	res := resolveExecTargets(objects, "agent-1", []string{"fp-other"})
	require.Nil(t, res.Picked)
	require.Len(t, res.Targets, 1)
	require.Equal(t, reasonUnpaired, res.Targets[0].Reason)
}

func TestResolveExecTargets_GivenTombstonedRows_ThenTheyDoNotCount(t *testing.T) {
	deletedTarget := target("t0", "agent-1", "backend-local", 0)
	deletedTarget.Deleted = true
	deletedBackend := backend("backend-gone", "")
	deletedBackend.Deleted = true
	objects := map[string]*peerObject{
		"t0":            deletedTarget,
		"backend-local": backend("backend-local", ""),
		"t1":            target("t1", "agent-1", "backend-gone", 1),
		"backend-gone":  deletedBackend,
		"t2":            target("t2", "agent-1", "backend-absent", 2),
	}
	res := resolveExecTargets(objects, "agent-1", nil)
	require.Nil(t, res.Picked)
	require.Len(t, res.Targets, 2, "the tombstoned target itself must not appear at all")
	require.Equal(t, reasonBackendDeleted, res.Targets[0].Reason)
	require.Equal(t, reasonBackendMissing, res.Targets[1].Reason)
}
