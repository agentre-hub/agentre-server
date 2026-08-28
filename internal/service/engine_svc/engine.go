// Package engine_svc 管理账号级 LLM 供应商、后端身份与每设备 CLI 覆盖。
package engine_svc

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"strings"
	"time"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/oklog/ulid/v2"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
)

const ServerOriginFingerprint = ""

type Model struct {
	ModelKey      string `json:"model_key"`
	ModelID       string `json:"model_id"`
	Name          string `json:"name"`
	Enabled       bool   `json:"enabled"`
	ContextWindow *int64 `json:"context_window,omitempty"`
	MaxOutput     *int64 `json:"max_output,omitempty"`
}

type ProviderView struct {
	ProviderKey     string  `json:"provider_key"`
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	BaseURL         string  `json:"base_url"`
	MaskedTail      string  `json:"masked_tail"`
	DefaultModelKey string  `json:"default_model_key"`
	Enabled         bool    `json:"enabled"`
	Models          []Model `json:"models"`
}

type ProviderSnapshot struct {
	ProviderKey     string  `json:"provider_key"`
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	BaseURL         string  `json:"base_url"`
	APIKey          string  `json:"api_key"`
	DefaultModelKey string  `json:"default_model_key"`
	Models          []Model `json:"models"`
}

type ProviderWriteInput struct {
	UserID          int64
	ProviderKey     string
	Name            *string
	Type            *string
	BaseURL         *string
	APIKey          *string
	DefaultModelKey *string
	Models          *[]Model
	Enabled         *bool
}

type BackendWriteInput struct {
	UserID                int64
	SyncID                string
	Name                  *string
	Type                  *string
	ProviderKey           *string
	ModelKey              *string
	ModelRoutes           *string
	Sandbox               *string
	Approval              *string
	ReasoningEffort       *string
	DefaultPermissionMode *string
	DefaultModel          *string
	OpenClawGatewayURL    *string
	OpenClawAgentID       *string
	OpenClawDefaultModel  *string
	OpenClawSessionMode   *string
	CLIPath               *string
	// DeviceID 是这个后端的运行设备指纹（决策 5：必填）。它落在既有列
	// sync_objects.agentred_fingerprint 上，不是 agent_backend 载荷里的一个键。
	DeviceID *string
}

type CLIByDevice struct {
	Fingerprint string `json:"fingerprint"`
	Status      string `json:"status"`
}

type BackendView struct {
	SyncID                string        `json:"sync_id"`
	Name                  string        `json:"name"`
	Type                  string        `json:"type"`
	ProviderKey           string        `json:"provider_key"`
	ModelKey              string        `json:"model_key"`
	ModelRoutes           string        `json:"model_routes"`
	Sandbox               string        `json:"sandbox"`
	Approval              string        `json:"approval"`
	ReasoningEffort       string        `json:"reasoning_effort"`
	DefaultPermissionMode string        `json:"default_permission_mode"`
	DefaultModel          string        `json:"default_model"`
	OpenClawGatewayURL    string        `json:"openclaw_gateway_url"`
	OpenClawAgentID       string        `json:"openclaw_agent_id"`
	OpenClawDefaultModel  string        `json:"openclaw_default_model"`
	OpenClawSessionMode   string        `json:"openclaw_session_mode"`
	RefCount              int           `json:"ref_count"`
	CLIByDevice           []CLIByDevice `json:"cli_by_device"`
	// DeviceID 读自 sync_objects.agentred_fingerprint；存量行没有登记设备时如实为空。
	DeviceID string `json:"device_id"`
}

type CLIOverlayView struct {
	BackendSyncID string `json:"backend_sync_id"`
	Fingerprint   string `json:"fingerprint"`
	Status        string `json:"status"`
}

type CLIOverlaySnapshot struct {
	BackendSyncID string `json:"backend_sync_id"`
	CLIPath       string `json:"cli_path"`
}

type SnapshotView struct {
	Providers   []ProviderSnapshot   `json:"providers"`
	CLIOverlays []CLIOverlaySnapshot `json:"cli_overlays"`
}

type EngineSvc interface {
	ListProviders(context.Context, int64) ([]ProviderView, error)
	CreateProvider(context.Context, ProviderWriteInput) (*ProviderView, error)
	UpdateProvider(context.Context, ProviderWriteInput) (*ProviderView, error)
	DeleteProvider(context.Context, int64, string) error
	ListBackends(context.Context, int64) ([]BackendView, error)
	CreateBackend(context.Context, BackendWriteInput) (*BackendView, error)
	UpdateBackend(context.Context, BackendWriteInput) (*BackendView, error)
	DeleteBackend(context.Context, int64, string) error
	ListCLIOverlays(context.Context, int64) ([]CLIOverlayView, error)
	Snapshot(context.Context, int64, string) (*SnapshotView, error)
}

type engineSvc struct{ now func() int64 }

func New() EngineSvc { return &engineSvc{now: func() int64 { return time.Now().UnixMilli() }} }

var defaultSvc EngineSvc = New()

func Default() EngineSvc     { return defaultSvc }
func SetDefault(s EngineSvc) { defaultSvc = s }

type providerPayload struct {
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	BaseURL         string  `json:"base_url"`
	APIKey          string  `json:"api_key"`
	DefaultModelKey string  `json:"default_model_key"`
	Models          []Model `json:"models"`
	Enabled         bool    `json:"enabled"`
}

type backendPayload struct {
	Name                  string `json:"name"`
	Type                  string `json:"type"`
	ProviderKey           string `json:"provider_key"`
	ModelKey              string `json:"model_key"`
	ModelRoutes           string `json:"model_routes,omitempty"`
	Sandbox               string `json:"sandbox,omitempty"`
	Approval              string `json:"approval,omitempty"`
	EnvJSON               string `json:"env_json,omitempty"`
	ReasoningEffort       string `json:"reasoning_effort,omitempty"`
	DefaultPermissionMode string `json:"default_permission_mode,omitempty"`
	DefaultModel          string `json:"default_model,omitempty"`
	OpenClawGatewayURL    string `json:"openclaw_gateway_url,omitempty"`
	OpenClawAgentID       string `json:"openclaw_agent_id,omitempty"`
	OpenClawDefaultModel  string `json:"openclaw_default_model,omitempty"`
	OpenClawSessionMode   string `json:"openclaw_session_mode,omitempty"`
}

type cliOverlayPayload struct {
	CLIPath string `json:"cli_path"`
}

func (s *engineSvc) ListProviders(ctx context.Context, userID int64) ([]ProviderView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{sync_entity.KindLLMProvider})
	if err != nil {
		return nil, err
	}
	out := make([]ProviderView, 0, len(rows))
	for _, row := range rows {
		if p, ok := decodeProvider(row); ok {
			out = append(out, browserProvider(row.SyncID, p))
		}
	}
	return out, nil
}

func (s *engineSvc) CreateProvider(ctx context.Context, in ProviderWriteInput) (*ProviderView, error) {
	p := providerPayload{}
	applyProvider(&p, in, true)
	if !validProvider(p) || strings.TrimSpace(p.APIKey) == "" {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	return s.saveProvider(ctx, in.UserID, newSyncID(s.now()), nil, p)
}
func (s *engineSvc) UpdateProvider(ctx context.Context, in ProviderWriteInput) (*ProviderView, error) {
	row, err := findLive(ctx, in.UserID, in.ProviderKey, sync_entity.KindLLMProvider)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, i18n.NewNotFoundError(ctx, code.EngineProviderNotFound)
	}
	p, ok := decodeProvider(row)
	if !ok {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	applyProvider(&p, in, false)
	if !validProvider(p) {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	return s.saveProvider(ctx, in.UserID, row.SyncID, row, p)
}
func (s *engineSvc) saveProvider(ctx context.Context, userID int64, key string, row *sync_entity.SyncObject, p providerPayload) (*ProviderView, error) {
	payload, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	version, err := sync_repo.SyncState().NextVersion(ctx, userID, 1)
	if err != nil {
		return nil, err
	}
	now := s.now()
	if row == nil {
		row = &sync_entity.SyncObject{UserID: userID, Kind: sync_entity.KindLLMProvider, SyncID: key, Createtime: now}
	}
	row.Payload, row.Version, row.SyncUpdatedAt, row.OriginFingerprint, row.Updatetime = string(payload), version, now, ServerOriginFingerprint, now
	if err := sync_repo.SyncObject().Save(ctx, row); err != nil {
		return nil, err
	}
	accountchan_svc.BroadcastBestEffort(ctx, userID, version)
	out := browserProvider(key, p)
	return &out, nil
}
func (s *engineSvc) DeleteProvider(ctx context.Context, userID int64, key string) error {
	return s.delete(ctx, userID, key, sync_entity.KindLLMProvider, code.EngineProviderNotFound)
}

func (s *engineSvc) ListBackends(ctx context.Context, userID int64) ([]BackendView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{sync_entity.KindAgentBackend, sync_entity.KindAgentBackendCLI, sync_entity.KindAgentExecTarget})
	if err != nil {
		return nil, err
	}
	refs := map[string]int{}
	overlays := map[string][]CLIByDevice{}
	out := make([]BackendView, 0)
	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindAgentExecTarget:
			if id := sync_entity.ExecTargetBackendSyncID(row.Payload); id != "" {
				refs[id]++
			}
		case sync_entity.KindAgentBackendCLI:
			if o, ok := decodeOverlay(row); ok {
				overlays[row.ProjectSyncID] = append(overlays[row.ProjectSyncID], CLIByDevice{Fingerprint: row.AgentredFingerprint, Status: overlayStatus(o.CLIPath)})
			}
		case sync_entity.KindAgentBackend:
			if b, ok := decodeBackend(row); ok {
				view := backendView(row.SyncID, b)
				view.DeviceID = row.AgentredFingerprint
				out = append(out, view)
			}
		}
	}
	for i := range out {
		out[i].RefCount = refs[out[i].SyncID]
		out[i].CLIByDevice = overlays[out[i].SyncID]
		if out[i].CLIByDevice == nil {
			out[i].CLIByDevice = []CLIByDevice{}
		}
	}
	return out, nil
}
func (s *engineSvc) CreateBackend(ctx context.Context, in BackendWriteInput) (*BackendView, error) {
	b := backendPayload{}
	applyBackend(&b, in)
	if err := validateBackendWrite(ctx, b, in); err != nil {
		return nil, err
	}
	return s.saveBackend(ctx, in.UserID, newSyncID(s.now()), nil, b, strings.TrimSpace(*in.DeviceID))
}
func (s *engineSvc) UpdateBackend(ctx context.Context, in BackendWriteInput) (*BackendView, error) {
	row, err := findLive(ctx, in.UserID, in.SyncID, sync_entity.KindAgentBackend)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, i18n.NewNotFoundError(ctx, code.EngineBackendNotFound)
	}
	b, ok := decodeBackend(row)
	if !ok {
		return nil, i18n.NewError(ctx, code.InvalidParameter)
	}
	applyBackend(&b, in)
	if err := validateBackendWrite(ctx, b, in); err != nil {
		return nil, err
	}
	return s.saveBackend(ctx, in.UserID, row.SyncID, row, b, strings.TrimSpace(*in.DeviceID))
}

// saveBackend 把运行设备写进既有列 sync_objects.agentred_fingerprint，而不是塞进
// backendPayload——载荷与身份指纹是两回事，读的一侧（ListBackends/backendView）也
// 是分开取的。
func (s *engineSvc) saveBackend(ctx context.Context, userID int64, id string, row *sync_entity.SyncObject, b backendPayload, fingerprint string) (*BackendView, error) {
	payload, err := json.Marshal(b)
	if err != nil {
		return nil, err
	}
	v, err := sync_repo.SyncState().NextVersion(ctx, userID, 1)
	if err != nil {
		return nil, err
	}
	now := s.now()
	if row == nil {
		row = &sync_entity.SyncObject{UserID: userID, Kind: sync_entity.KindAgentBackend, SyncID: id, Createtime: now}
	}
	row.Payload, row.Version, row.SyncUpdatedAt, row.OriginFingerprint, row.Updatetime = string(payload), v, now, ServerOriginFingerprint, now
	row.AgentredFingerprint = fingerprint
	if err := sync_repo.SyncObject().Save(ctx, row); err != nil {
		return nil, err
	}
	accountchan_svc.BroadcastBestEffort(ctx, userID, v)
	out := backendView(id, b)
	out.DeviceID = fingerprint
	out.CLIByDevice = []CLIByDevice{}
	return &out, nil
}

func backendView(syncID string, b backendPayload) BackendView {
	return BackendView{
		SyncID: syncID, Name: b.Name, Type: b.Type, ProviderKey: b.ProviderKey, ModelKey: b.ModelKey,
		ModelRoutes: b.ModelRoutes, Sandbox: b.Sandbox, Approval: b.Approval,
		ReasoningEffort: b.ReasoningEffort, DefaultPermissionMode: b.DefaultPermissionMode,
		DefaultModel: b.DefaultModel, OpenClawGatewayURL: b.OpenClawGatewayURL,
		OpenClawAgentID: b.OpenClawAgentID, OpenClawDefaultModel: b.OpenClawDefaultModel,
		OpenClawSessionMode: b.OpenClawSessionMode,
	}
}

func (s *engineSvc) DeleteBackend(ctx context.Context, userID int64, id string) error {
	return s.delete(ctx, userID, id, sync_entity.KindAgentBackend, code.EngineBackendNotFound)
}

func (s *engineSvc) ListCLIOverlays(ctx context.Context, userID int64) ([]CLIOverlayView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{sync_entity.KindAgentBackendCLI})
	if err != nil {
		return nil, err
	}
	out := make([]CLIOverlayView, 0, len(rows))
	for _, row := range rows {
		if o, ok := decodeOverlay(row); ok {
			out = append(out, CLIOverlayView{BackendSyncID: row.ProjectSyncID, Fingerprint: row.AgentredFingerprint, Status: overlayStatus(o.CLIPath)})
		}
	}
	return out, nil
}
func (s *engineSvc) Snapshot(ctx context.Context, userID int64, fingerprint string) (*SnapshotView, error) {
	rows, err := sync_repo.SyncObject().ListByKinds(ctx, userID, []string{sync_entity.KindLLMProvider, sync_entity.KindAgentBackendCLI})
	if err != nil {
		return nil, err
	}
	out := &SnapshotView{Providers: []ProviderSnapshot{}, CLIOverlays: []CLIOverlaySnapshot{}}
	for _, row := range rows {
		switch row.Kind {
		case sync_entity.KindLLMProvider:
			if p, ok := decodeProvider(row); ok {
				out.Providers = append(out.Providers, ProviderSnapshot{ProviderKey: row.SyncID, Name: p.Name, Type: p.Type, BaseURL: p.BaseURL, APIKey: p.APIKey, DefaultModelKey: p.DefaultModelKey, Models: p.Models})
			}
		case sync_entity.KindAgentBackendCLI:
			if row.AgentredFingerprint == fingerprint {
				if o, ok := decodeOverlay(row); ok {
					out.CLIOverlays = append(out.CLIOverlays, CLIOverlaySnapshot{BackendSyncID: row.ProjectSyncID, CLIPath: o.CLIPath})
				}
			}
		}
	}
	return out, nil
}

func (s *engineSvc) delete(ctx context.Context, userID int64, id, kind string, notFoundCode int) error {
	row, err := findLive(ctx, userID, id, kind)
	if err != nil {
		return err
	}
	if row == nil {
		return i18n.NewNotFoundError(ctx, notFoundCode)
	}
	v, err := sync_repo.SyncState().NextVersion(ctx, userID, 1)
	if err != nil {
		return err
	}
	now := s.now()
	row.DeletedAt, row.Version, row.SyncUpdatedAt, row.OriginFingerprint, row.Updatetime = now, v, now, ServerOriginFingerprint, now
	if err := sync_repo.SyncObject().Save(ctx, row); err != nil {
		return err
	}
	accountchan_svc.BroadcastBestEffort(ctx, userID, v)
	return nil
}
func findLive(ctx context.Context, userID int64, id, kind string) (*sync_entity.SyncObject, error) {
	row, err := sync_repo.SyncObject().Find(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if row == nil || row.IsDeleted() || row.Kind != kind {
		return nil, nil
	}
	return row, nil
}
func applyProvider(p *providerPayload, in ProviderWriteInput, create bool) {
	if in.Name != nil {
		p.Name = *in.Name
	}
	if in.Type != nil {
		p.Type = *in.Type
	}
	if in.BaseURL != nil {
		p.BaseURL = *in.BaseURL
	}
	if in.APIKey != nil && strings.TrimSpace(*in.APIKey) != "" {
		p.APIKey = *in.APIKey
	}
	if in.DefaultModelKey != nil {
		p.DefaultModelKey = *in.DefaultModelKey
	}
	if in.Models != nil {
		p.Models = *in.Models
	}
	if in.Enabled != nil {
		p.Enabled = *in.Enabled
	} else if create {
		p.Enabled = true
	}
	if p.Models == nil {
		p.Models = []Model{}
	}
}
func validProvider(p providerPayload) bool {
	return strings.TrimSpace(p.Name) != "" && strings.TrimSpace(p.Type) != "" && strings.TrimSpace(p.BaseURL) != ""
}
func applyBackend(b *backendPayload, in BackendWriteInput) {
	if in.Name != nil {
		b.Name = *in.Name
	}
	if in.Type != nil {
		b.Type = *in.Type
	}
	if in.ProviderKey != nil {
		b.ProviderKey = *in.ProviderKey
	}
	if in.ModelKey != nil {
		b.ModelKey = *in.ModelKey
	}
	if in.ModelRoutes != nil {
		b.ModelRoutes = *in.ModelRoutes
	}
	if in.Sandbox != nil {
		b.Sandbox = *in.Sandbox
	}
	if in.Approval != nil {
		b.Approval = *in.Approval
	}
	if in.ReasoningEffort != nil {
		b.ReasoningEffort = *in.ReasoningEffort
	}
	if in.DefaultPermissionMode != nil {
		b.DefaultPermissionMode = *in.DefaultPermissionMode
	}
	if in.DefaultModel != nil {
		b.DefaultModel = *in.DefaultModel
	}
	if in.OpenClawGatewayURL != nil {
		b.OpenClawGatewayURL = *in.OpenClawGatewayURL
	}
	if in.OpenClawAgentID != nil {
		b.OpenClawAgentID = *in.OpenClawAgentID
	}
	if in.OpenClawDefaultModel != nil {
		b.OpenClawDefaultModel = *in.OpenClawDefaultModel
	}
	if in.OpenClawSessionMode != nil {
		b.OpenClawSessionMode = *in.OpenClawSessionMode
	}
}
func validBackend(b backendPayload, in BackendWriteInput) bool {
	return strings.TrimSpace(b.Name) != "" && strings.TrimSpace(b.Type) != "" &&
		in.DeviceID != nil && strings.TrimSpace(*in.DeviceID) != ""
}

func validateBackendWrite(ctx context.Context, b backendPayload, in BackendWriteInput) error {
	if in.CLIPath != nil {
		return i18n.NewError(ctx, code.EngineCLIPathForbidden)
	}
	if b.Type == "builtin" {
		return i18n.NewError(ctx, code.EngineBuiltinForbidden)
	}
	if !validBackend(b, in) {
		return i18n.NewError(ctx, code.InvalidParameter)
	}
	return requireActiveAccountDevice(ctx, in.UserID, strings.TrimSpace(*in.DeviceID))
}

// requireActiveAccountDevice 判「所选设备在编辑期间被撤销」：指纹在这个账号下查不到，
// 或查到了但不是活跃状态（Device.IsActive 对 nil 接收者也安全），都拒同一个专属码，
// 不静默落一个指向撤销设备的取值。它与「没填设备」的 InvalidParameter 分开，好让浏览器
// 把「请选一台设备」和「该设备已不在账号内」分别提示。
func requireActiveAccountDevice(ctx context.Context, userID int64, fingerprint string) error {
	d, err := device_repo.Device().FindByFingerprint(ctx, userID, fingerprint)
	if err != nil {
		return err
	}
	if !d.IsActive() {
		return i18n.NewError(ctx, code.EngineBackendDeviceNotFound)
	}
	return nil
}
func decodeProvider(row *sync_entity.SyncObject) (providerPayload, bool) {
	var p providerPayload
	return p, json.Unmarshal([]byte(row.Payload), &p) == nil
}
func decodeBackend(row *sync_entity.SyncObject) (backendPayload, bool) {
	var b backendPayload
	return b, json.Unmarshal([]byte(row.Payload), &b) == nil
}
func decodeOverlay(row *sync_entity.SyncObject) (cliOverlayPayload, bool) {
	var o cliOverlayPayload
	return o, json.Unmarshal([]byte(row.Payload), &o) == nil
}
func browserProvider(key string, p providerPayload) ProviderView {
	return ProviderView{ProviderKey: key, Name: p.Name, Type: p.Type, BaseURL: p.BaseURL, MaskedTail: maskedTail(p.APIKey), DefaultModelKey: p.DefaultModelKey, Enabled: p.Enabled, Models: p.Models}
}
func maskedTail(key string) string {
	r := []rune(key)
	if len(r) <= 4 {
		return key
	}
	return string(r[len(r)-4:])
}
func overlayStatus(path string) string {
	if path == "" {
		return "path"
	}
	return "recognized"
}
func newSyncID(now int64) string {
	return ulid.MustNew(ulid.Timestamp(time.UnixMilli(now)), rand.Reader).String()
}
