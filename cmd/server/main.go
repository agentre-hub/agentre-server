package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"

	"github.com/cago-frame/cago"
	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/database/db"
	"github.com/cago-frame/cago/pkg/component"
	"github.com/cago-frame/cago/pkg/opentelemetry/metric"
	"github.com/cago-frame/cago/pkg/opentelemetry/trace"
	"github.com/cago-frame/cago/server/cron"
	"github.com/cago-frame/cago/server/mux"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/buildinfo"
	"github.com/agentre-hub/agentre-server/internal/repository/activity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/agent_session_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_flow_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/device_token_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/sync_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_identity_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/user_repo"
	"github.com/agentre-hub/agentre-server/internal/repository/webauthn_credential_repo"
	"github.com/agentre-hub/agentre-server/internal/service/engine_svc"
	"github.com/agentre-hub/agentre-server/internal/task"
	"github.com/agentre-hub/agentre-server/internal/web"
	"github.com/agentre-hub/agentre-server/migrations"
)

func loadConfig(args []string) (*configs.Config, error) {
	flags := flag.NewFlagSet("agentre-server", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "configuration file path")
	if err := flags.Parse(args); err != nil {
		return nil, err
	}
	if *configPath == "" {
		return configs.NewConfig("agentre-server")
	}
	cfg, err := configs.NewConfig("agentre-server", configs.WithConfigFile(*configPath))
	if err != nil {
		return nil, fmt.Errorf("load config %q: %w", *configPath, err)
	}
	return cfg, nil
}

func main() {
	log.Printf("agentre-server %s (%s) starting", buildinfo.Version, buildinfo.Commit)

	ctx := context.Background()
	cfg, err := loadConfig(os.Args[1:])
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
	agent_session_repo.RegisterSave(agent_session_repo.NewSave())
	agent_session_repo.RegisterSummary(agent_session_repo.NewSummary())
	agent_session_repo.RegisterJournalFrame(agent_session_repo.NewJournalFrame())
	agent_session_repo.RegisterDeleteTodo(agent_session_repo.NewDeleteTodo())
	webauthn_credential_repo.RegisterWebAuthnCredential(webauthn_credential_repo.NewWebAuthnCredential())
	activity_repo.RegisterDaily(activity_repo.NewDaily())
	user_repo.RegisterSettings(user_repo.NewSettings())
	engine_svc.SetDefault(engine_svc.New())

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
		// 连接池必须紧跟在 Database 之后:cago 的 db 组件只认 driver/dsn/prefix/
		// debug/prepareStmt,连接数与连接寿命它一概不设,不补这一步就一直是
		// database/sql 的默认值(空闲上限 2、连接数无上限、连接永不过期)。
		Registry(cago.FuncComponent(func(_ context.Context, _ *configs.Config) error {
			sqlDB, err := db.Default().DB()
			if err != nil {
				return fmt.Errorf("resolve sql db for pool settings: %w", err)
			}
			bootstrap.ApplyDBPool(sqlDB, serverCfg.DBPool)
			return nil
		})).
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
		// 常驻镜像自己不在 Start 里做事（那份常驻在 bootstrap.RegisterDefaults 里
		// 就建好了），它在这里只为拿到 CloseHandle：进程退出时收工，手里每一份
		// 机器租约当场让出，接手的副本不必等一整个 TTL。注册在 mux 之前，于是
		// 关闭时排在它之后——先不再收请求，再停镜像。
		Registry(task.MirrorResident()).
		Registry(cago.FuncComponent(web.MountSPA)).
		RegistryCancel(mux.HTTP(deps.Router)).
		// 中继排空**必须**注册在 mux 之后:cago 按注册逆序关组件,于是它排在 mux
		// 之前关。反过来的话,进程已经卡在 mux 的 Shutdown 里等中继的读循环返回,
		// 而那个循环阻塞在 ReadMessage 上永远不会自己返回 —— 这一步根本轮不到跑。
		// 详见 task.RelayDrain 的注释。
		Registry(task.RelayDrain(deps)).
		Start()
	if err != nil {
		log.Fatalf("server start: %v", err)
	}
}
