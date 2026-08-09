package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// peerState is the simulated desktop's whole world, kept in a JSON file so each
// CLI invocation resumes where the last left off (cursor + replica + rotated
// refresh token). Nothing here is production state — it exists so the Playwright
// side can talk to a stateful peer through one-shot processes.
type peerState struct {
	BaseURL      string `json:"base_url"`
	DeviceID     int64  `json:"device_id"`
	RefreshToken string `json:"refresh_token"`
	// Paired lists the agentred fingerprints this peer has a local pairing row for.
	// R2b judges availability on exactly this — not on holding a pairing token.
	Paired []string `json:"paired"`
	Cursor int64    `json:"cursor"`
	// Objects is the peer's replica, keyed by sync id. Tombstones stay in it
	// (Deleted = true) so "does the peer resurrect a deleted row" is answerable.
	Objects map[string]*peerObject `json:"objects"`

	accessToken string
}

type peerObject struct {
	Kind                string          `json:"kind"`
	SyncID              string          `json:"sync_id"`
	ProjectSyncID       string          `json:"project_sync_id,omitempty"`
	AgentredFingerprint string          `json:"agentred_fingerprint,omitempty"`
	Payload             json.RawMessage `json:"payload"`
	Version             int64           `json:"version"`
	UpdatedAt           int64           `json:"updated_at"`
	SourceDeviceID      int64           `json:"source_device_id"`
	Deleted             bool            `json:"deleted"`
}

func runPeer(args []string) error {
	if len(args) == 0 {
		usage()
		return fmt.Errorf("peer: missing subcommand")
	}
	switch args[0] {
	case "init":
		return peerInit(args[1:])
	case "sync":
		return peerSync(args[1:])
	case "push":
		return peerPush(args[1:])
	case "dump":
		return peerDump(args[1:])
	case "report-local-paths":
		return peerReportLocalPaths(args[1:])
	case "exec-targets":
		return peerExecTargets(args[1:])
	default:
		usage()
		return fmt.Errorf("peer: unknown subcommand %q", args[0])
	}
}

// ── state file ──────────────────────────────────────────────────────────────

func loadState(path string) (*peerState, error) {
	b, err := os.ReadFile(path) //nolint:gosec // path comes from the harness, not user input
	if err != nil {
		return nil, fmt.Errorf("read peer state: %w", err)
	}
	st := &peerState{}
	if err := json.Unmarshal(b, st); err != nil {
		return nil, fmt.Errorf("parse peer state: %w", err)
	}
	if st.Objects == nil {
		st.Objects = map[string]*peerObject{}
	}
	return st, nil
}

func saveState(path string, st *peerState) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func splitList(raw string) []string {
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

// ── HTTP ────────────────────────────────────────────────────────────────────

// authorize trades the seeded refresh token for a real access JWT through the
// real endpoint. Refresh rotates the token, so the new one is persisted right
// away; losing it would strand the peer.
func (st *peerState) authorize(statePath string) error {
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := st.call(http.MethodPost, "/v1/oauth/token/refresh", "",
		map[string]string{"refresh_token": st.RefreshToken}, &out); err != nil {
		return fmt.Errorf("refresh access token: %w", err)
	}
	if out.AccessToken == "" {
		return fmt.Errorf("refresh returned an empty access token")
	}
	st.accessToken = out.AccessToken
	if out.RefreshToken != "" {
		st.RefreshToken = out.RefreshToken
	}
	return saveState(statePath, st)
}

// call does one request and unwraps cago's {code,msg,data} envelope. A non-zero
// code is an error: the peer must never quietly treat a rejection as success.
func (st *peerState) call(method, path, query string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	url := strings.TrimRight(st.BaseURL, "/") + path
	if query != "" {
		url += "?" + query
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if st.accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+st.accessToken)
	}
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var envelope struct {
		Code int             `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("%s %s: status %d, unparsable body %s", method, path, resp.StatusCode, truncate(raw))
	}
	if envelope.Code != 0 {
		return fmt.Errorf("%s %s: code %d (%s)", method, path, envelope.Code, envelope.Msg)
	}
	if out == nil || len(envelope.Data) == 0 {
		return nil
	}
	return json.Unmarshal(envelope.Data, out)
}

func truncate(b []byte) string {
	if len(b) > 300 {
		return string(b[:300]) + "…"
	}
	return string(b)
}

// ── subcommands ─────────────────────────────────────────────────────────────

func peerInit(args []string) error {
	fs := flag.NewFlagSet("peer init", flag.ExitOnError)
	statePath := fs.String("state", "", "path of the peer state file")
	baseURL := fs.String("base-url", "", "server base URL")
	deviceID := fs.Int64("device-id", 0, "this peer's device id")
	refresh := fs.String("refresh-token", "", "seeded refresh token for that device")
	paired := fs.String("paired", "", "comma separated agentred fingerprints this peer has paired")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *statePath == "" || *baseURL == "" || *deviceID == 0 || *refresh == "" {
		return fmt.Errorf("--state, --base-url, --device-id and --refresh-token are required")
	}
	st := &peerState{
		BaseURL: *baseURL, DeviceID: *deviceID, RefreshToken: *refresh,
		Paired: splitList(*paired), Objects: map[string]*peerObject{},
	}
	if err := saveState(*statePath, st); err != nil {
		return err
	}
	if err := st.authorize(*statePath); err != nil {
		return err
	}
	return emit(map[string]any{"device_id": st.DeviceID, "paired": st.Paired})
}

func peerSync(args []string) error {
	fs := flag.NewFlagSet("peer sync", flag.ExitOnError)
	statePath := fs.String("state", "", "path of the peer state file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := loadState(*statePath)
	if err != nil {
		return err
	}
	if err := st.authorize(*statePath); err != nil {
		return err
	}
	applied := 0
	for {
		var page struct {
			Items      []peerObject `json:"items"`
			NextCursor int64        `json:"next_cursor"`
			HasMore    bool         `json:"has_more"`
		}
		if err := st.call(http.MethodGet, "/v1/sync/pull",
			fmt.Sprintf("cursor=%d&limit=200", st.Cursor), nil, &page); err != nil {
			return err
		}
		for i := range page.Items {
			item := page.Items[i]
			st.Objects[item.SyncID] = &item
			applied++
		}
		if page.NextCursor > st.Cursor {
			st.Cursor = page.NextCursor
		}
		if !page.HasMore {
			break
		}
	}
	if err := saveState(*statePath, st); err != nil {
		return err
	}
	return emit(map[string]any{"applied": applied, "cursor": st.Cursor, "objects": len(st.Objects)})
}

func peerPush(args []string) error {
	fs := flag.NewFlagSet("peer push", flag.ExitOnError)
	statePath := fs.String("state", "", "path of the peer state file")
	kind := fs.String("kind", "", "object kind")
	syncID := fs.String("sync-id", "", "sync id (generated when empty)")
	baseVersion := fs.Int64("base-version", -1, "base version; -1 = the version this peer last saw")
	payload := fs.String("payload", "{}", "payload JSON")
	deleted := fs.Bool("deleted", false, "push a tombstone")
	projectSyncID := fs.String("project-sync-id", "", "natural key part for project_location")
	fingerprint := fs.String("fingerprint", "", "agentred fingerprint this row belongs to")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := loadState(*statePath)
	if err != nil {
		return err
	}
	if *kind == "" {
		return fmt.Errorf("--kind is required")
	}
	id := *syncID
	if id == "" {
		id = newSyncID()
	}
	base := *baseVersion
	if base < 0 {
		base = 0
		if known := st.Objects[id]; known != nil {
			base = known.Version
		}
	}
	if err := st.authorize(*statePath); err != nil {
		return err
	}
	item := map[string]any{
		"kind": *kind, "sync_id": id, "base_version": base,
		"updated_at": time.Now().UnixMilli(), "deleted": *deleted,
		"agentred_fingerprint": *fingerprint, "project_sync_id": *projectSyncID,
		"payload": json.RawMessage(*payload),
	}
	var out struct {
		Results []map[string]any `json:"results"`
	}
	if err := st.call(http.MethodPost, "/v1/sync/push", "",
		map[string]any{"items": []any{item}}, &out); err != nil {
		return err
	}
	// Reflect the push into the replica so a follow-up push carries a sane base version.
	if len(out.Results) == 1 {
		version, _ := out.Results[0]["version"].(float64)
		status, _ := out.Results[0]["status"].(string)
		if status != string(pushRejected) {
			st.Objects[id] = &peerObject{
				Kind: *kind, SyncID: id, ProjectSyncID: *projectSyncID,
				AgentredFingerprint: *fingerprint, Payload: json.RawMessage(*payload),
				Version: int64(version), Deleted: *deleted, SourceDeviceID: st.DeviceID,
			}
		}
	}
	if err := saveState(*statePath, st); err != nil {
		return err
	}
	return emit(map[string]any{"sync_id": id, "base_version": base, "results": out.Results})
}

type pushStatus string

const pushRejected pushStatus = "rejected"

func peerDump(args []string) error {
	fs := flag.NewFlagSet("peer dump", flag.ExitOnError)
	statePath := fs.String("state", "", "path of the peer state file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := loadState(*statePath)
	if err != nil {
		return err
	}
	items := make([]*peerObject, 0, len(st.Objects))
	for _, obj := range st.Objects {
		items = append(items, obj)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Version < items[j].Version })
	return emit(map[string]any{"cursor": st.Cursor, "paired": st.Paired, "items": items})
}

func peerReportLocalPaths(args []string) error {
	fs := flag.NewFlagSet("peer report-local-paths", flag.ExitOnError)
	statePath := fs.String("state", "", "path of the peer state file")
	items := fs.String("items", "[]", `JSON array of {"project_sync_id","path"}`)
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := loadState(*statePath)
	if err != nil {
		return err
	}
	var parsed []map[string]string
	if err := json.Unmarshal([]byte(*items), &parsed); err != nil {
		return fmt.Errorf("parse --items: %w", err)
	}
	if err := st.authorize(*statePath); err != nil {
		return err
	}
	if err := st.call(http.MethodPost, "/v1/sync/local-paths", "",
		map[string]any{"items": parsed}, nil); err != nil {
		return err
	}
	return emit(map[string]any{"reported": len(parsed), "device_id": st.DeviceID})
}

func peerExecTargets(args []string) error {
	fs := flag.NewFlagSet("peer exec-targets", flag.ExitOnError)
	statePath := fs.String("state", "", "path of the peer state file")
	agentSyncID := fs.String("agent-sync-id", "", "the Agent whose ordered target list to resolve")
	paired := fs.String("paired", "", "override the peer's paired fingerprints for this call")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := loadState(*statePath)
	if err != nil {
		return err
	}
	// --paired overrides the peer's own pairing set for this call only, so one
	// synced Agent can be resolved under both "paired" and "unpaired" without
	// re-syncing a second peer (R2b's judgment is a property of the receiver).
	pairedSet := st.Paired
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "paired" {
			pairedSet = splitList(*paired)
		}
	})
	res := resolveExecTargets(st.Objects, *agentSyncID, pairedSet)
	return emit(res)
}

func newSyncID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("peer-%d", time.Now().UnixNano())
	}
	return "peer-" + hex.EncodeToString(b)
}
