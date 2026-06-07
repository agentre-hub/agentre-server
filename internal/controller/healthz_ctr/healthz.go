package healthz_ctr

import (
	"context"

	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/database/redis"

	api "agentre-server/internal/api/healthz"
)

type Healthz struct{}

func NewHealthz() *Healthz { return &Healthz{} }

func (h *Healthz) Healthz(ctx context.Context, _ *api.HealthzRequest) (*api.HealthzResponse, error) {
	resp := &api.HealthzResponse{Status: "ok"}
	if sqlDB, err := db.Default().DB(); err == nil {
		resp.DBPing = sqlDB.PingContext(ctx) == nil
	}
	resp.Redis = redis.Default().Ping(ctx).Err() == nil
	return resp, nil
}
