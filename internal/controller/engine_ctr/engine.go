// Package engine_ctr 把已鉴权调用方的账号与设备身份接到引擎设置服务。
package engine_ctr

import (
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/engine"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/engine_svc"
)

type Engine struct{}

func New() *Engine { return &Engine{} }
func (e *Engine) ListProviders(c *gin.Context, _ *api.ListProvidersRequest) (*api.ListProvidersResponse, error) {
	items, err := engine_svc.Default().ListProviders(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, err
	}
	out := make([]api.Provider, 0, len(items))
	for _, p := range items {
		out = append(out, provider(p))
	}
	return &api.ListProvidersResponse{Providers: out}, nil
}
func (e *Engine) CreateProvider(c *gin.Context, req *api.CreateProviderRequest) (*api.Provider, error) {
	item, err := engine_svc.Default().CreateProvider(c.Request.Context(), providerInput(ginctx.UserID(c), "", req.Name, req.Type, req.BaseURL, req.APIKey, req.DefaultModelKey, req.Models, req.Enabled))
	if err != nil {
		return nil, err
	}
	out := provider(*item)
	return &out, nil
}
func (e *Engine) UpdateProvider(c *gin.Context, req *api.UpdateProviderRequest) (*api.Provider, error) {
	item, err := engine_svc.Default().UpdateProvider(c.Request.Context(), providerInput(ginctx.UserID(c), req.ProviderKey, req.Name, req.Type, req.BaseURL, req.APIKey, req.DefaultModelKey, req.Models, req.Enabled))
	if err != nil {
		return nil, err
	}
	out := provider(*item)
	return &out, nil
}
func (e *Engine) DeleteProvider(c *gin.Context, req *api.DeleteProviderRequest) (*struct{}, error) {
	if err := engine_svc.Default().DeleteProvider(c.Request.Context(), ginctx.UserID(c), req.ProviderKey); err != nil {
		return nil, err
	}
	return &struct{}{}, nil
}
func providerInput(userID int64, key string, name, kind, baseURL, apiKey, defaultModel *string, models *[]api.Model, enabled *bool) engine_svc.ProviderWriteInput {
	out := engine_svc.ProviderWriteInput{UserID: userID, ProviderKey: key, Name: name, Type: kind, BaseURL: baseURL, APIKey: apiKey, DefaultModelKey: defaultModel, Enabled: enabled}
	if models != nil {
		mapped := make([]engine_svc.Model, len(*models))
		for i, m := range *models {
			mapped[i] = engine_svc.Model{ModelKey: m.ModelKey, ModelID: m.ModelID, Name: m.Name, Enabled: m.Enabled, ContextWindow: m.ContextWindow, MaxOutput: m.MaxOutput}
		}
		out.Models = &mapped
	}
	return out
}
func provider(p engine_svc.ProviderView) api.Provider {
	models := make([]api.Model, len(p.Models))
	for i, m := range p.Models {
		models[i] = api.Model{ModelKey: m.ModelKey, ModelID: m.ModelID, Name: m.Name, Enabled: m.Enabled, ContextWindow: m.ContextWindow, MaxOutput: m.MaxOutput}
	}
	return api.Provider{ProviderKey: p.ProviderKey, Name: p.Name, Type: p.Type, BaseURL: p.BaseURL, MaskedTail: p.MaskedTail, DefaultModelKey: p.DefaultModelKey, Enabled: p.Enabled, Models: models}
}
func (e *Engine) ListBackends(c *gin.Context, _ *api.ListBackendsRequest) (*api.ListBackendsResponse, error) {
	items, err := engine_svc.Default().ListBackends(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, err
	}
	out := make([]api.Backend, 0, len(items))
	for _, b := range items {
		out = append(out, backend(b))
	}
	return &api.ListBackendsResponse{Backends: out}, nil
}
func (e *Engine) CreateBackend(c *gin.Context, req *api.CreateBackendRequest) (*api.Backend, error) {
	item, err := engine_svc.Default().CreateBackend(c.Request.Context(), backendInput(ginctx.UserID(c), "", req.Name, req.Type, req.ProviderKey, req.ModelKey, req.ModelRoutes, req.Sandbox, req.Approval, req.ReasoningEffort, req.DefaultPermissionMode, req.DefaultModel, req.OpenClawGatewayURL, req.OpenClawAgentID, req.OpenClawDefaultModel, req.OpenClawSessionMode, req.CLIPath, req.DeviceID))
	if err != nil {
		return nil, err
	}
	out := backend(*item)
	return &out, nil
}
func (e *Engine) UpdateBackend(c *gin.Context, req *api.UpdateBackendRequest) (*api.Backend, error) {
	item, err := engine_svc.Default().UpdateBackend(c.Request.Context(), backendInput(ginctx.UserID(c), req.SyncID, req.Name, req.Type, req.ProviderKey, req.ModelKey, req.ModelRoutes, req.Sandbox, req.Approval, req.ReasoningEffort, req.DefaultPermissionMode, req.DefaultModel, req.OpenClawGatewayURL, req.OpenClawAgentID, req.OpenClawDefaultModel, req.OpenClawSessionMode, req.CLIPath, req.DeviceID))
	if err != nil {
		return nil, err
	}
	out := backend(*item)
	return &out, nil
}
func (e *Engine) DeleteBackend(c *gin.Context, req *api.DeleteBackendRequest) (*struct{}, error) {
	if err := engine_svc.Default().DeleteBackend(c.Request.Context(), ginctx.UserID(c), req.SyncID); err != nil {
		return nil, err
	}
	return &struct{}{}, nil
}
func backendInput(userID int64, id string, name, kind, providerKey, modelKey, modelRoutes, sandbox, approval, reasoning, permission, defaultModel, gateway, agentID, openClawModel, sessionMode, cliPath, deviceID *string) engine_svc.BackendWriteInput {
	return engine_svc.BackendWriteInput{UserID: userID, SyncID: id, Name: name, Type: kind, ProviderKey: providerKey, ModelKey: modelKey, ModelRoutes: modelRoutes, Sandbox: sandbox, Approval: approval, ReasoningEffort: reasoning, DefaultPermissionMode: permission, DefaultModel: defaultModel, OpenClawGatewayURL: gateway, OpenClawAgentID: agentID, OpenClawDefaultModel: openClawModel, OpenClawSessionMode: sessionMode, CLIPath: cliPath, DeviceID: deviceID}
}
func backend(b engine_svc.BackendView) api.Backend {
	cli := make([]api.CLIByDevice, len(b.CLIByDevice))
	for i, c := range b.CLIByDevice {
		cli[i] = api.CLIByDevice{Fingerprint: c.Fingerprint, Status: c.Status}
	}
	return api.Backend{
		SyncID: b.SyncID, Name: b.Name, Type: b.Type, ProviderKey: b.ProviderKey, ModelKey: b.ModelKey,
		ModelRoutes: b.ModelRoutes, Sandbox: b.Sandbox, Approval: b.Approval,
		ReasoningEffort: b.ReasoningEffort, DefaultPermissionMode: b.DefaultPermissionMode,
		DefaultModel: b.DefaultModel, OpenClawGatewayURL: b.OpenClawGatewayURL,
		OpenClawAgentID: b.OpenClawAgentID, OpenClawDefaultModel: b.OpenClawDefaultModel,
		OpenClawSessionMode: b.OpenClawSessionMode, RefCount: b.RefCount, CLIByDevice: cli,
		DeviceID: b.DeviceID,
	}
}
func (e *Engine) ListCLIOverlays(c *gin.Context, _ *api.ListCLIOverlaysRequest) (*api.ListCLIOverlaysResponse, error) {
	items, err := engine_svc.Default().ListCLIOverlays(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, err
	}
	out := make([]api.CLIOverlay, 0, len(items))
	for _, o := range items {
		out = append(out, api.CLIOverlay{BackendSyncID: o.BackendSyncID, Fingerprint: o.Fingerprint, Status: o.Status})
	}
	return &api.ListCLIOverlaysResponse{Overlays: out}, nil
}
func (e *Engine) Snapshot(c *gin.Context, _ *api.SnapshotRequest) (*api.SnapshotResponse, error) {
	ctx := c.Request.Context()
	d, err := device_svc.Default().OwnedDevice(ctx, ginctx.UserID(c), ginctx.DeviceID(c))
	if err != nil {
		return nil, err
	}
	snap, err := engine_svc.Default().Snapshot(ctx, ginctx.UserID(c), d.Fingerprint)
	if err != nil {
		return nil, err
	}
	out := &api.SnapshotResponse{Providers: make([]api.SnapshotProvider, 0, len(snap.Providers)), CLIOverlays: make([]api.SnapshotCLIOverlay, 0, len(snap.CLIOverlays))}
	for _, p := range snap.Providers {
		models := make([]api.Model, len(p.Models))
		for i, m := range p.Models {
			models[i] = api.Model{ModelKey: m.ModelKey, ModelID: m.ModelID, Name: m.Name, Enabled: m.Enabled, ContextWindow: m.ContextWindow, MaxOutput: m.MaxOutput}
		}
		out.Providers = append(out.Providers, api.SnapshotProvider{ProviderKey: p.ProviderKey, Name: p.Name, Type: p.Type, BaseURL: p.BaseURL, APIKey: p.APIKey, DefaultModelKey: p.DefaultModelKey, Models: models})
	}
	for _, o := range snap.CLIOverlays {
		out.CLIOverlays = append(out.CLIOverlays, api.SnapshotCLIOverlay{BackendSyncID: o.BackendSyncID, CLIPath: o.CLIPath})
	}
	return out, nil
}
