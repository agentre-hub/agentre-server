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
	item, err := engine_svc.Default().CreateProvider(c.Request.Context(), engine_svc.ProviderWriteInput{
		UserID:          ginctx.UserID(c),
		ProviderKey:     "",
		Name:            req.Name,
		Type:            req.Type,
		BaseURL:         req.BaseURL,
		APIKey:          req.APIKey,
		DefaultModelKey: req.DefaultModelKey,
		Models:          providerModels(req.Models),
		Enabled:         req.Enabled,
	})
	if err != nil {
		return nil, err
	}
	out := provider(*item)
	return &out, nil
}
func (e *Engine) UpdateProvider(c *gin.Context, req *api.UpdateProviderRequest) (*api.Provider, error) {
	item, err := engine_svc.Default().UpdateProvider(c.Request.Context(), engine_svc.ProviderWriteInput{
		UserID:          ginctx.UserID(c),
		ProviderKey:     req.ProviderKey,
		Name:            req.Name,
		Type:            req.Type,
		BaseURL:         req.BaseURL,
		APIKey:          req.APIKey,
		DefaultModelKey: req.DefaultModelKey,
		Models:          providerModels(req.Models),
		Enabled:         req.Enabled,
	})
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
func (e *Engine) CreateProviderModel(c *gin.Context, req *api.CreateProviderModelRequest) (*api.Provider, error) {
	item, err := engine_svc.Default().CreateProviderModel(c.Request.Context(), engine_svc.ModelWriteInput{
		UserID: ginctx.UserID(c), ProviderKey: req.ProviderKey, ModelKey: req.ModelKey,
		ModelID: req.ModelID, Name: req.Name, Enabled: req.Enabled,
		ContextWindow: req.ContextWindow, MaxOutput: req.MaxOutput,
	})
	if err != nil {
		return nil, err
	}
	out := provider(*item)
	return &out, nil
}
func (e *Engine) UpdateProviderModel(c *gin.Context, req *api.UpdateProviderModelRequest) (*api.Provider, error) {
	item, err := engine_svc.Default().UpdateProviderModel(c.Request.Context(), engine_svc.ModelWriteInput{
		UserID: ginctx.UserID(c), ProviderKey: req.ProviderKey, ModelKey: req.ModelKey,
		ModelID: req.ModelID, Name: req.Name, Enabled: req.Enabled,
		ContextWindow: req.ContextWindow, MaxOutput: req.MaxOutput,
	})
	if err != nil {
		return nil, err
	}
	out := provider(*item)
	return &out, nil
}
func (e *Engine) DeleteProviderModel(c *gin.Context, req *api.DeleteProviderModelRequest) (*api.Provider, error) {
	item, err := engine_svc.Default().DeleteProviderModel(c.Request.Context(), ginctx.UserID(c), req.ProviderKey, req.ModelKey)
	if err != nil {
		return nil, err
	}
	out := provider(*item)
	return &out, nil
}

// providerModels 把请求里的模型档搬成服务层入参；nil 原样保持 nil（「不改这一列」）。
func providerModels(models *[]api.Model) *[]engine_svc.Model {
	if models == nil {
		return nil
	}
	mapped := make([]engine_svc.Model, len(*models))
	for i, m := range *models {
		mapped[i] = engine_svc.Model{ModelKey: m.ModelKey, ModelID: m.ModelID, Name: m.Name, Enabled: m.Enabled, ContextWindow: m.ContextWindow, MaxOutput: m.MaxOutput}
	}
	return &mapped
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
	item, err := engine_svc.Default().CreateBackend(c.Request.Context(), engine_svc.BackendWriteInput{
		UserID: ginctx.UserID(c), SyncID: "", Name: req.Name, Type: req.Type,
		ProviderKey: req.ProviderKey, ModelKey: req.ModelKey, Config: req.Config,
		ReasoningEffort: req.ReasoningEffort, EnvJSON: req.EnvJSON,
		CLIPath: req.CLIPath, DeviceFingerprint: req.DeviceFingerprint,
	})
	if err != nil {
		return nil, err
	}
	out := backend(*item)
	return &out, nil
}
func (e *Engine) UpdateBackend(c *gin.Context, req *api.UpdateBackendRequest) (*api.Backend, error) {
	item, err := engine_svc.Default().UpdateBackend(c.Request.Context(), engine_svc.BackendWriteInput{
		UserID: ginctx.UserID(c), SyncID: req.SyncID, Name: req.Name, Type: req.Type,
		ProviderKey: req.ProviderKey, ModelKey: req.ModelKey, Config: req.Config,
		ReasoningEffort: req.ReasoningEffort, EnvJSON: req.EnvJSON,
		CLIPath: req.CLIPath, DeviceFingerprint: req.DeviceFingerprint,
	})
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
func backend(b engine_svc.BackendView) api.Backend {
	cli := make([]api.CLIByDevice, len(b.CLIByDevice))
	for i, c := range b.CLIByDevice {
		cli[i] = api.CLIByDevice{Fingerprint: c.Fingerprint, Status: c.Status}
	}
	return api.Backend{
		SyncID: b.SyncID, Name: b.Name, Type: b.Type, ProviderKey: b.ProviderKey, ModelKey: b.ModelKey,
		EnvJSON: b.EnvJSON, ReasoningEffort: b.ReasoningEffort, Config: b.Config,
		RefCount: b.RefCount, CLIByDevice: cli,
		DeviceFingerprint: b.DeviceFingerprint,
	}
}
func (e *Engine) ListCLIOverlays(c *gin.Context, _ *api.ListCLIOverlaysRequest) (*api.ListCLIOverlaysResponse, error) {
	items, err := engine_svc.Default().ListCLIOverlays(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, err
	}
	out := make([]api.CLIOverlay, 0, len(items))
	for _, o := range items {
		out = append(out, api.CLIOverlay{BackendSyncID: o.BackendSyncID, Fingerprint: o.Fingerprint, Status: o.Status, CLIPath: o.CLIPath})
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
