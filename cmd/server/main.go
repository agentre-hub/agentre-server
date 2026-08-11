package main

import (
	"context"
	"log"

	"github.com/cago-frame/cago"
	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/database/db"
	_ "github.com/cago-frame/cago/database/db/postgres"
	"github.com/cago-frame/cago/pkg/component"
	"github.com/cago-frame/cago/pkg/opentelemetry/metric"
	"github.com/cago-frame/cago/pkg/opentelemetry/trace"
	"github.com/cago-frame/cago/server/cron"
	"github.com/cago-frame/cago/server/mux"

	"agentre-server/internal/api"
	"agentre-server/internal/bootstrap"
	"agentre-server/internal/buildinfo"
	"agentre-server/internal/repository/device_flow_repo"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/repository/device_token_repo"
	"agentre-server/internal/repository/follow_repo"
	"agentre-server/internal/repository/sync_repo"
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
	sync_repo.RegisterSyncObject(sync_repo.NewSyncObject())
	sync_repo.RegisterSyncState(sync_repo.NewSyncState())
	sync_repo.RegisterSyncAvatar(sync_repo.NewSyncAvatar())
	sync_repo.RegisterSyncLocalPath(sync_repo.NewSyncLocalPath())
	follow_repo.RegisterFollow(follow_repo.NewFollow())

	deps := &api.RouterDeps{Cfg: serverCfg, Signer: signer}

	err = cago.New(ctx, cfg).
		Registry(component.Core()).
		// trace 必须尽早注册：其余组件和 mux 中间件都会先判断 trace.Default()
		// 是否存在再决定要不要接链路。放在 Core 之后、业务组件之前。
		//
		// 只认「显式的合法取值」，其余一律不启用并打日志说明，原因有两个：
		//   1. 配置里没有 trace 段时，trace.Trace 内部的 cfg.Scan 会报
		//      key not found，直接注册会让服务启动即 panic；
		//   2. 更隐蔽的是，cago 在 Scan 失败后会把零值写回配置文件，于是
		//      type 变成 ""——而 trace 的 switch 里 "" 落到 default 分支，也就是
		//      OTLP/gRPC 导出到一个空 endpoint，静默地往虚空重试。
		// trace.Default() 为 nil 时 mux 中间件自己有 nil 判断，会安静跳过。
		Registry(cago.FuncComponent(func(ctx context.Context, c *configs.Config) error {
			var tcfg trace.Config
			if err := c.Scan(ctx, "trace", &tcfg); err != nil {
				log.Printf("tracing disabled: no %q section in config (%v); "+
					"see docs/observability.md#traces", "trace", err)
				return nil
			}
			switch tcfg.Type {
			case "grpc", "http", "empty", "noop":
				return trace.Trace(ctx, c)
			default:
				log.Printf("tracing disabled: trace.type=%q is not one of "+
					"grpc/http/empty/noop; see docs/observability.md#traces", tcfg.Type)
				return nil
			}
		})).
		// metric 会自行挂上 gin 中间件并暴露 GET /metrics（Prometheus 抓取端点）。
		Registry(cago.FuncComponent(metric.Metrics)).
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
