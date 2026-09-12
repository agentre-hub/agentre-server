package main

import (
	"encoding/json"
	"sort"
)

// Reason codes for an unavailable execution target. They mirror the desktop's
// own vocabulary closely enough to be read side by side, but this file is a
// simulation of the receiving end, not a second implementation of it: the real
// judgment lives in the desktop's chat_svc / project_location_svc.
const (
	reasonUnpaired       = "unpaired"
	reasonBackendMissing = "backend_missing"
	reasonBackendDeleted = "backend_deleted"
)

type execTargetView struct {
	SyncID        string `json:"sync_id"`
	SortOrder     int    `json:"sort_order"`
	BackendSyncID string `json:"backend_sync_id"`
	// Fingerprint is empty for a target that runs on the receiving desktop itself
	// (the relative reference of 决策 14).
	Fingerprint string `json:"fingerprint"`
	Available   bool   `json:"available"`
	Reason      string `json:"reason,omitempty"`
}

type execTargetResolution struct {
	AgentSyncID string            `json:"agent_sync_id"`
	Paired      []string          `json:"paired"`
	Targets     []*execTargetView `json:"targets"`
	// Picked is the first available target in list order, or nil when the Agent
	// has no runnable machine on this end (R15).
	Picked *execTargetView `json:"picked"`
}

type execTargetPayload struct {
	AgentSyncID   string `json:"agent_sync_id"`
	BackendSyncID string `json:"backend_sync_id"`
	SortOrder     int    `json:"sort_order"`
}

// resolveExecTargets applies R15's "take the first available target in list
// order" to a replica, with R2b's availability rule for agentred-bound targets:
// a target is available only when this end has a pairing row for the backend's
// fingerprint. An empty fingerprint means "this machine", always available here.
func resolveExecTargets(objects map[string]*peerObject, agentSyncID string, paired []string) *execTargetResolution {
	pairedSet := map[string]bool{}
	for _, fp := range paired {
		pairedSet[fp] = true
	}
	out := &execTargetResolution{AgentSyncID: agentSyncID, Paired: paired, Targets: []*execTargetView{}}

	for _, obj := range objects {
		if obj == nil || obj.Kind != "agent_exec_target" || obj.DeletedAt > 0 {
			continue
		}
		var p execTargetPayload
		if err := json.Unmarshal(obj.Payload, &p); err != nil || p.AgentSyncID != agentSyncID {
			continue
		}
		view := &execTargetView{SyncID: obj.SyncID, SortOrder: p.SortOrder, BackendSyncID: p.BackendSyncID}
		backend := objects[p.BackendSyncID]
		switch {
		case backend == nil:
			view.Reason = reasonBackendMissing
		case backend.DeletedAt > 0:
			view.Reason = reasonBackendDeleted
		default:
			view.Fingerprint = backend.AgentredFingerprint
			if view.Fingerprint == "" || pairedSet[view.Fingerprint] {
				view.Available = true
			} else {
				view.Reason = reasonUnpaired
			}
		}
		out.Targets = append(out.Targets, view)
	}

	sort.Slice(out.Targets, func(i, j int) bool {
		if out.Targets[i].SortOrder != out.Targets[j].SortOrder {
			return out.Targets[i].SortOrder < out.Targets[j].SortOrder
		}
		return out.Targets[i].SyncID < out.Targets[j].SyncID
	})
	for _, view := range out.Targets {
		if view.Available {
			out.Picked = view
			break
		}
	}
	return out
}
