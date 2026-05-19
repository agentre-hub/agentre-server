package main

import (
	"context"
	"log"

	"github.com/cago-frame/cago"
	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/database/db"
	_ "github.com/cago-frame/cago/database/db/postgres"
	"github.com/cago-frame/cago/pkg/component"
	"github.com/cago-frame/cago/server/cron"
	"github.com/cago-frame/cago/server/mux"

	"agentre-hub/internal/api"
	"agentre-hub/internal/bootstrap"
	"agentre-hub/internal/buildinfo"
	"agentre-hub/internal/repository/device_flow_repo"
	"agentre-hub/internal/repository/device_repo"
	"agentre-hub/internal/repository/device_token_repo"
	"agentre-hub/internal/repository/user_identity_repo"
	"agentre-hub/internal/repository/user_repo"
	"agentre-hub/internal/task"
	"agentre-hub/internal/web"
	"agentre-hub/migrations"
)

func main() {
	log.Printf("agentre-hub %s (%s) starting", buildinfo.Version, buildinfo.Commit)

	ctx := context.Background()
	cfg, err := configs.NewConfig("agentre-hub")
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	hubCfg := bootstrap.LoadHubConfig(ctx, cfg)
	signer := bootstrap.LoadJWTSigner(hubCfg)

	user_repo.RegisterUser(user_repo.NewUser())
	user_identity_repo.RegisterUserIdentity(user_identity_repo.NewUserIdentity())
	device_repo.RegisterDevice(device_repo.NewDevice())
	device_token_repo.RegisterDeviceToken(device_token_repo.NewDeviceToken())
	device_flow_repo.RegisterDeviceFlow(device_flow_repo.NewDeviceFlow())

	bootstrap.RegisterDefaults(hubCfg, signer)

	deps := &api.RouterDeps{Cfg: hubCfg, Signer: signer}

	err = cago.New(ctx, cfg).
		Registry(component.Core()).
		Registry(component.Database()).
		Registry(component.Redis()).
		Registry(cron.Cron()).
		Registry(cago.FuncComponent(func(ctx context.Context, _ *configs.Config) error {
			return migrations.RunMigrations(db.Default())
		})).
		Registry(cago.FuncComponent(task.Task)).
		Registry(cago.FuncComponent(web.MountSPA)).
		RegistryCancel(mux.HTTP(deps.Router)).
		Start()
	if err != nil {
		log.Fatalf("hub start: %v", err)
	}
}
