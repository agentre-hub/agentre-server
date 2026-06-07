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

	"agentre-server/internal/api"
	"agentre-server/internal/bootstrap"
	"agentre-server/internal/buildinfo"
	"agentre-server/internal/repository/device_flow_repo"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_token_repo"
	"agentre-server/internal/repository/user_identity_repo"
	"agentre-server/internal/repository/user_repo"
	"agentre-server/internal/task"
	"agentre-server/internal/web"
	"agentre-server/migrations"
)

func main() {
	log.Printf("agentre-server %s (%s) starting", buildinfo.Version, buildinfo.Commit)

	ctx := context.Background()
	cfg, err := configs.NewConfig("agentre-server")
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	serverCfg := bootstrap.LoadServerConfig(ctx, cfg)
	signer := bootstrap.LoadJWTSigner(serverCfg)

	user_repo.RegisterUser(user_repo.NewUser())
	user_identity_repo.RegisterUserIdentity(user_identity_repo.NewUserIdentity())
	device_repo.RegisterDevice(device_repo.NewDevice())
	device_token_repo.RegisterDeviceToken(device_token_repo.NewDeviceToken())
	device_flow_repo.RegisterDeviceFlow(device_flow_repo.NewDeviceFlow())

	deps := &api.RouterDeps{Cfg: serverCfg, Signer: signer}

	err = cago.New(ctx, cfg).
		Registry(component.Core()).
		Registry(component.Database()).
		Registry(component.Redis()).
		Registry(cago.FuncComponent(func(_ context.Context, _ *configs.Config) error {
			bootstrap.RegisterDefaults(serverCfg, signer)
			return nil
		})).
		Registry(cron.Cron()).
		Registry(cago.FuncComponent(func(ctx context.Context, _ *configs.Config) error {
			return migrations.RunMigrations(db.Default())
		})).
		Registry(cago.FuncComponent(task.Task)).
		Registry(cago.FuncComponent(web.MountSPA)).
		RegistryCancel(mux.HTTP(deps.Router)).
		Start()
	if err != nil {
		log.Fatalf("server start: %v", err)
	}
}
