package ctl_svc

import (
	"context"

	"github.com/agentre-hub/agentre-server/internal/service/engine_svc"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

//go:generate mockgen -source ports.go -destination mock_ctl_svc/mock_ports.go

// OrgWriter 是组织面与项目的写路径（workspace_svc 结构性满足它）。
type OrgWriter interface {
	CreateOrgObject(ctx context.Context, in workspace_svc.OrgWriteInput) (*workspace_svc.OrgWriteResult, error)
	UpdateOrgObject(ctx context.Context, in workspace_svc.OrgWriteInput) (*workspace_svc.OrgWriteResult, error)
	DeleteOrgObject(ctx context.Context, in workspace_svc.OrgWriteInput) (*workspace_svc.OrgWriteResult, error)
	SetExecTargetOrder(ctx context.Context, in workspace_svc.SetExecTargetOrderInput) error
	SetProjectLocation(ctx context.Context, in workspace_svc.SetProjectLocationInput) (*workspace_svc.OrgWriteResult, error)
}

// EngineWriter 是提供方、模型与后端的写路径（engine_svc 结构性满足它）。
type EngineWriter interface {
	CreateProvider(ctx context.Context, in engine_svc.ProviderWriteInput) (*engine_svc.ProviderView, error)
	UpdateProvider(ctx context.Context, in engine_svc.ProviderWriteInput) (*engine_svc.ProviderView, error)
	DeleteProvider(ctx context.Context, userID int64, key string) error
	CreateProviderModel(ctx context.Context, in engine_svc.ModelWriteInput) (*engine_svc.ProviderView, error)
	UpdateProviderModel(ctx context.Context, in engine_svc.ModelWriteInput) (*engine_svc.ProviderView, error)
	DeleteProviderModel(ctx context.Context, userID int64, providerKey, modelKey string) (*engine_svc.ProviderView, error)
	CreateBackend(ctx context.Context, in engine_svc.BackendWriteInput) (*engine_svc.BackendView, error)
	UpdateBackend(ctx context.Context, in engine_svc.BackendWriteInput) (*engine_svc.BackendView, error)
	DeleteBackend(ctx context.Context, userID int64, id string) error
}
