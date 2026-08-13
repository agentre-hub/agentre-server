# E2E 冒烟与本地验证重构

> 状态：已批准
> 负责人：AgentRe Server 工程
> 最后更新：2026-08-13

**目标：** 将当前混杂多套全链路编排的 `e2e/` 收敛为一条可在本地与 CI 一致执行的真实 Go/MySQL/Redis 基础冒烟轨道，同时保留 `serve + drive + scratch` 本地真实环境验证能力。

**硬性不变量：** 自动冒烟必须运行正式 Go server、全部 migration、真实 MySQL 和真实 Redis；不得把前端 API mock、sqlmock、miniredis 或跳过外部依赖描述成 E2E 通过。真实地址、账号、密码、JWT 私钥、session cookie 和 token 不得进入 Git、控制台、报告或测试附件。仓库继续保持零 build tag。

## 问题

1. **当前 E2E 职责混杂且规模失控。** 已跟踪的 `e2e/` 内容约 5,382 行，同时承担 CI 冒烟、runner 自测、真实 server + agentred、Wails 双端、手工 CDP 驱动和 scratch 验证；`e2e/run-e2e-web.mjs` 单文件约 1,202 行，基础门禁与按需全链路难以独立维护。
2. **当前 CI 冒烟没有验证正式 Go 后端。** `Makefile` 的 `test-e2e` 最终运行 `pnpm smoke`，而 `e2e/playwright.config.ts` 启动 Vite，`e2e/fixtures/app.ts` 通过 `page.route()` mock `/v1`；该结果能证明前端，但不能证明正式 server 组装、migration、MySQL 方言、Redis、session middleware、controller/service/repository 与嵌入 SPA 正常。
3. **自动入口和文档契约分裂。** 仓库同时存在 `test-e2e`、`test-e2e-web`、`pnpm smoke`、`pnpm web`、`pnpm dual`、`pnpm serve`、`pnpm drive` 和 `pnpm scratch`；相关描述散布在 `Makefile`、CI、`docs/develop.md`、`docs/testing.md`、`docs/verification.md`、报告模板和 `e2e/README.md`，容易出现命令已删除而文档仍指向旧入口的漂移。
4. **真实环境验证与基础门禁没有清晰边界。** 当前 `web/dual` 编排同时构建 server、agentred、Wails、播种复杂工作区和会话数据；其中多数能力不属于 AgentRe Server 的基础可用性，却显著增加运行时间、前置依赖和失败面。
5. **配置路径不够显式。** 正式入口目前依赖 cago 默认的 `./configs/config.yaml`；E2E 若复制、改写或通过工作目录伪装默认文件，会使实际使用的配置来源难以判断。当前 cago 版本已提供 `configs.WithConfigFile`，应让启动者直接指定 `configs/config.e2e.yaml`。
6. **共享真实数据库需要机械安全边界。** 本地 E2E 将连接专用远程 MySQL/Redis；若没有数据库名校验、run 级隔离、精确清理和敏感信息脱敏，一次错误配置或失败运行可能污染非测试数据，或把连接凭据写入日志和证据。

## 角色与用户故事

1. 作为开发者，我希望运行唯一的 `make e2e` 就能验证正式 Go server、migration、MySQL、Redis、浏览器和基础业务主链，以便本地通过与 CI 通过表达同一件事。
2. 作为 CI 维护者，我希望每个 job 使用临时 MySQL/Redis 完整运行 E2E，而不访问内网或保存长期凭据，以便门禁可重复、可隔离且不会争用共享环境。
3. 作为需要人工验收的开发者，我希望继续使用 `pnpm serve + pnpm drive` 和 `pnpm scratch` 驱动真实环境，以便观察 UI、读取数据库、保留截图与执行记录，而不依赖 agentred 或 Wails。
4. 作为远程 E2E 专库的维护者，我希望每次运行只创建和清理自己的数据，并拒绝危险配置与全库操作，以免测试影响其他运行或非测试数据。
5. 作为后续维护者，我希望所有命令、路径和职责在代码、CI 和文档中同步更新，以免根据过期文档运行已不存在的轨道。

## 设计决策

| # | 决策 | 依据与否决方案 |
|---|---|---|
| 1 | 自动 E2E 只保留根目录唯一入口 `make e2e`；删除 `test-e2e` 和 `test-e2e-web`。 | 用户明确要求 Makefile 只保留 `make e2e`，CI 也必须调用同一入口。否决：保留兼容别名——会继续维持多个权威命令。 |
| 2 | `make e2e` 运行正式 `cmd/server`、全部 migration、真实 MySQL 和真实 Redis；浏览器 `/v1` 请求不使用 Playwright route mock。 | 只有这样才能覆盖正式启动、存储协议和前后端契约。否决：Vite + `page.route()`——只能证明前端；否决：E2E 中使用 sqlmock/miniredis——不满足真实环境要求。 |
| 3 | 本地读取 gitignored 的 `configs/config.e2e.yaml`；CI 在 workspace 中动态生成同名文件并连接 job 内临时 MySQL/Redis。 | 本地可使用远程 E2E 专库而不泄露地址或凭据，CI 无需内网。否决：CI 连接同一本地远程环境——hosted runner 通常不可达，且并发污染风险高。 |
| 4 | 正式 server 支持显式 `--config <path>`，E2E 直接启动 `bin/server --config configs/config.e2e.yaml`；未传时仍使用 `configs/config.yaml`。 | cago 已提供 `configs.WithConfigFile`，无需复制或伪装默认配置。否决：覆盖 `configs/config.yaml`、改工作目录或使用隐式测试环境变量。 |
| 5 | CI 使用临时 MySQL 9.7.2 和 Redis 7 容器，容器及 volume 随 job 销毁。 | 与项目声明版本一致，真实执行 migration/SQL/Redis，又不依赖长期 secret。否决：SQLite、MariaDB、miniredis 或共享远程服务——协议、方言或隔离不等价。 |
| 6 | 基础冒烟覆盖正式启动、未登录鉴权、真实 session 控制台、完整设备授权、桌面/移动溢出和 SPA 404 六类行为。 | 这是用户批准的 A 范围，足以覆盖应用可用性和核心状态机，又不会重新膨胀成全产品回归。否决：主题/语言重复进入 E2E——已有前端门禁；否决：只测 healthz——对业务接线证明不足。 |
| 7 | GitHub OAuth、agentred 和 Wails 不进入基础 E2E；登录前置由 fixture 在真实 MySQL/Redis 中创建隔离用户和 session，设备授权业务动作仍必须经真实 HTTP API。 | OAuth 与跨端系统不是本轮基础可用性目标。否决：为基础门禁启动所有外围系统；也否决：fixture 直接把设备流改成 approved——会绕过被测状态机。 |
| 8 | 保留并收敛 `pnpm serve + pnpm drive` 与 `pnpm scratch`；`drive.mjs`、`lib/drive-target.mjs`、scratch 配置和报告工作流继续存在。 | 用户明确要求保留本地验证。否决：删除 drive/scratch 只留自动测试——会失去真实 UI 与一次性场景的验证入口。 |
| 9 | 删除旧 `web/dual` agentred/Wails 全链路轨道及其专用配置和命令；`serve` 的正式 server 启动、seed、handoff、日志和 cleanup 能力迁移到精简 runner。 | 它们是当前复杂度的主要来源，且不属于本仓基础 E2E。否决：在旧 1,202 行 runner 上继续叠加分支——职责仍混杂。 |
| 10 | 每次运行按唯一 run ID 隔离用户、session、设备流、设备和 token；禁止全库清理，清理后必须查询残留。 | 本地使用共享 E2E 专库，按 run 归属是必要安全边界。否决：`TRUNCATE`、`DROP DATABASE`、`FLUSHDB` 或按时间猜测删除。 |
| 11 | 所有受影响的代码引用、CI 命令和文档在同一轮同步更新，仓库中不得残留指向已删除入口或路径的现行说明。 | 用户明确要求同步修改并完善文档，且 `docs/documentation.md` 要求一个事实一个所有者。否决：只改代码、把文档留给后续——会立即产生错误操作指南。 |

## 自动 E2E 运行契约

当开发者或 CI 从仓库根执行 `make e2e` 时，运行器读取 `configs/config.e2e.yaml`，验证其安全边界，构建前端并将产物嵌入正式 Go server，然后以独占端口和显式配置路径启动该 server。运行器不得启动 Vite 代替正式 server，也不得复用开发者手工运行的 `:5174` 或 `:8443` 实例。

server 必须执行与部署相同的组件注册顺序和全部 migration。只有当进程保持存活且 `/v1/healthz` 在限定时间内返回 `status="ok"`、`db_ping=true`、`redis=true`，测试才可进入 seed 和浏览器阶段。migration、MySQL、Redis 或 server 任一失败都必须使 `make e2e` 失败；不得跳过、降级为 mock 或把依赖不可达报告为绿色。

运行器为每个 Playwright project 创建独立 run ID、用户和浏览器 session。Playwright 固定单 worker，桌面 Chromium 与 Pixel 7 移动 Chromium 串行运行，避免共享真实存储时发生跨 project 竞态。设备授权场景每次重新调用公开 authorize API 获取独立 code，不复用已消费状态。

成功或失败后，运行器都必须停止 server 并清理本轮持久数据。原始测试失败是主失败；若 cleanup 同时失败，结果仍保留原始失败并明确追加残留和清理失败信息。

## 配置与启动契约

正式 server 接受 `--config <path>`。指定路径时只读取该文件；路径不存在、不可读或内容无效时，进程明确失败且错误指出该路径，不得静默回退。未传 `--config` 时继续读取 `configs/config.yaml`，保持开发和部署兼容。

仓库提交 `configs/config.e2e.example.yaml`，它只包含 localhost、占位凭据、E2E 示例数据库名和本地 key 路径说明。`configs/config.e2e.yaml` 必须 gitignored；本地可在其中配置远程 E2E 专用 MySQL/Redis，但真实地址、用户名和密码不得出现在已跟踪文件中。

`configs/config.e2e.yaml` 必须使用 `source: file`。运行器在启动前解析 MySQL DSN，并要求数据库名带明确的 E2E 标识；不满足时拒绝运行。检查结果可以显示脱敏 host/port 和数据库名，但不能显示完整 DSN、数据库用户名/密码或 Redis 密码。

CI 不读取本地配置、不连接本地远程环境，也不要求内网 secret。CI 在 job workspace 生成 `configs/config.e2e.yaml`，其中仅包含该 job 临时 MySQL/Redis 的连接信息和临时 JWT key 路径；job 结束时文件随 workspace 销毁。

## 基础冒烟行为

### 正式启动与真实依赖

在全新或已迁移的 E2E 专库上启动 server 时，全部 migration 必须成功完成，server 保持运行，healthz 必须同时确认 MySQL 与 Redis 可用。任何 DDL、named migration lock、MySQL 方言或 Redis 协议错误都使冒烟失败。

### 未登录鉴权

没有 session cookie 的浏览器访问受保护页面时，真实 `/v1/auth/me` 必须经过 Go 路由和 session/device 鉴权返回统一 401 envelope，前端最终落到带原目标的登录页。登录按钮和共享应用控制可见，页面不得白屏。

### 真实 session 与控制台

fixture 在真实 MySQL 中创建本轮用户，并在真实 Redis 中按生产 session 结构创建本轮 session。浏览器只接收真实 cookie，不替换 `/v1/auth/me` 或其他 API。访问控制台时，真实 session middleware、Redis、user service/repository 和 MySQL 返回本轮用户，页面显示该用户和控制台主区域；agents、devices 和 follows 没有数据时走真实空响应和诚实空态。

fixture 的直接写入只用于建立 OAuth 之后才会存在的认证前置条件，不构成对 OAuth 的验证，也不得代替本轮声称覆盖的业务动作。

### 完整设备授权主链

测试调用真实 `POST /v1/oauth/device/authorize` 创建 pending flow，登录浏览器进入 verification URI，读取真实 pending 信息并点击允许。approve 请求必须经过真实 session、CSRF、controller、service、repository 和 MySQL 条件更新，页面随后进入成功状态。

测试再调用真实 token endpoint，取得真实 access token、refresh token 和 device ID。独立 SQL oracle 必须读取对应 flow、device 和 token 行，证明状态实际持久化；再次消费同一 device code 必须失败，证明一次性状态边界没有退化。fixture 不得直接批准 flow 或制造 token。

### 桌面与移动布局

登录页、控制台主区域和设备授权页在 desktop-chromium 与 mobile-chromium 下均不得产生水平滚动。布局断言使用真实浏览器的 `scrollWidth` 与 `clientWidth`，不以 jsdom 或静态 class 判断代替。

### SPA fallback 与未知路由

从正式嵌入式 Go server 访问未知前端路由时，server 返回构建后的 SPA，React 渲染 404 页面和返回首页入口。访问不存在的 `/assets/*` 时必须保持 HTTP 404，不能错误返回 `index.html`。

## 本地真实验证

`pnpm serve` 使用与 `make e2e` 相同的正式 build、`--config configs/config.e2e.yaml`、migration、healthz、seed 和 cleanup 组件，但不自动运行 committed spec。它保持隔离环境运行，写出仅供本轮使用的 `.drive` handoff，使 `pnpm drive up` 能打开同源、已登录的浏览器。

`pnpm drive` 继续一次执行一个人工动作，并保留现有安全性质：只驱动本轮批准的 origin；`drive sql` 只接受 `SELECT`、`WITH`、`EXPLAIN` 和 `SHOW`；每次操作即时记录到 `e2e/scratch/<scenario>/logs/drive.log`；截图只写入当前 scenario；浏览器默认 headless，并可切换桌面与移动视口。

`pnpm scratch` 继续用于必须重放、并发或时序敏感的本地一次性规格。scratch 默认连接开发者已启动的真实 E2E 环境；其脚本和证据保持 gitignored，不能被 `make e2e` 或 CI 自动收集。

`pnpm serve` 收到正常终止信号时必须删除 handoff、停止 server 并清理本轮数据。异常退出留下的 handoff 不得被后续 drive 误认为有效；下一次启动必须识别失效环境，并只在 E2E 专库安全边界内处理本工具留下的过期孤儿数据。

## 数据隔离与清理

本地配置必须指向专用 E2E 数据库；运行器不得创建、删除或重命名数据库。它可以让正式 server 对该库执行 append-only migration，但不得执行 `DROP DATABASE`、`TRUNCATE`、`FLUSHDB` 或 `FLUSHALL`。

每轮数据必须能由唯一 run ID 追溯到一个隔离用户。清理按外键关系只删除该用户关联的 device token、device flow、同步对象、关注、设备、identity、用户和本轮 Redis session/限流键，不得执行缺少 run/user 条件的批量删除。

清理结束后，运行器独立查询本轮用户、flow、设备、token 和 session 是否残留。发现残留时命令失败，并只报告残留类型和数量，不输出 token、cookie 或个人数据。并发运行不得清除其他 run 的数据。

## 敏感信息与证据

运行期 JWT key、server 日志、seed 交接件、Playwright trace、截图和 cleanup 结果放在 gitignored 的本轮 runtime/证据目录。私钥、完整 DSN、Redis 密码、session cookie、CSRF token、access token 和 refresh token 不得进入控制台、报告、trace 附件名称或 committed fixture。

失败诊断可以报告阶段、进程退出码、脱敏 host/port、数据库名、server 日志尾部和证据目录。写入报告或上传 CI artifact 前必须再次脱敏。公开示例不得包含内网 IP、真实账号或密码。

## CI

CI 的 E2E job 启动 MySQL 9.7.2 和 Redis 7 临时服务，等待两者 ready，生成临时 JWT key 与 `configs/config.e2e.yaml`，然后只执行 `make e2e`。它不得另外展开一份与 Makefile 不同的测试命令。

CI 不连接本地远程环境。无论 `make e2e` 成功或失败，临时容器和 volume 都必须销毁；失败时上传脱敏后的 server 日志和 Playwright 证据。并发 job 使用各自的容器和数据库，不共享持久 volume。

## 旧轨道收缩与兼容性

本轮删除依赖真实 agentred 或 Wails 的 `pnpm web`、`pnpm dual`、`e2e/web/`、`e2e/dual/` 及其专用 Playwright 配置和 runner 分支。基础 E2E 不再声称验证中继会话、agentred 或桌面端协作。

`drive.mjs`、`lib/drive-target.mjs`、`playwright.scratch.config.ts`、`scratch/.gitkeep`、验证报告模板和 `serve/drive/scratch` 工作流必须保留。旧 runner 中只服务于 server 构建、启动、seed、handoff、日志和 cleanup 的能力迁移到精简 runner；agentred、Wails、复杂工作区和会话播种能力不迁移。

删除 `test-e2e` 和 `test-e2e-web` 是有意的命令契约变更，不提供 Makefile 兼容别名。所有现行调用方必须同步改用 `make e2e`。

## 文档与引用同步

本轮实现完成时，以下事实必须在各自所有者中同步更新：

- `docs/develop.md`：唯一 `make e2e` 命令、依赖安装和 CI 一致性；
- `docs/testing.md`：自动 E2E 使用真实 Go/MySQL/Redis，以及它与 repository sqlmock/service mockgen 单元测试的区别；
- `e2e/README.md`：配置、端口、CI、本地 `serve/drive/scratch`、隔离、清理、排障和不覆盖范围；
- `docs/verification.md`：删除 `pnpm dual` 和旧 web 全链路路线，保留并校正 `serve/drive/scratch`；
- `docs/references/verification-report-template.md`：环境和入口示例不再提已删除轨道；
- `.github/workflows/ci.yml`：E2E job 的临时依赖和唯一 `make e2e` 调用；
- 根 `README.md`、`AGENTS.md`、部署文档或其他 tracked 文件：仅在仍引用旧命令、旧路径或错误配置契约时同步修正，并链接到事实所有者而非复制说明。

完成后，已跟踪文件中不得残留把 `test-e2e`、`test-e2e-web`、`pnpm web`、`pnpm dual`、旧 `e2e/web/dual` 路径或旧 runner 描述为现行入口的引用。历史规格可保留其历史事实，不为本轮批量改写。

## 失败与恢复

以下情况必须明确失败：E2E 配置缺失；配置源不是 file；数据库名不满足 E2E 安全标识；MySQL/Redis 不可达；前端或 Go build 失败；migration 失败；server 提前退出；healthz 未达到双依赖可用；seed、Playwright、SQL/Redis oracle 或 cleanup 失败。

任何失败都不得通过跳过测试、弱化断言、改用 mock 或复用其他端口上的进程转绿。失败报告必须指出失败阶段、最短重现入口和脱敏证据位置。未到达的检查只能报告未执行，不能算通过。

## 范围外

- 验证 GitHub OAuth 服务、真实 GitHub 账号或 OAuth App 配置。
- 启动或验证 agentred、中继协议、会话读写和工作区派发。
- 启动或验证 Wails 桌面端、桌面端与浏览器双端协作。
- 验证生产网络、生产凭据、生产数据库或本地远程环境所在机器自身的可用性。
- 将主题切换、语言切换等已有前端单测覆盖的行为重复扩张为基础 E2E 主链。
- 修改既有 migration；本轮只让正式 server 在真实 MySQL 上执行现有 append-only migration。
- 建立通用测试环境平台、容器编排框架或未来依赖扩展点。

## 测试决策

| 接缝 | 验证内容 | 既有依据 |
|---|---|---|
| server 配置参数 | 默认路径、显式 `--config`、缺失/无效文件明确失败且不回退 | cago `configs.WithConfigFile`；当前 `cmd/server/main.go` 默认加载 |
| runner 纯逻辑 | 配置源与 E2E 数据库名安全检查、DSN/Redis 脱敏、启动诊断、失效 handoff、清理结果和信号处理 | 现有 runner config/serve/drive 测试中的可复用接缝 |
| seed/cleanup | 真实 MySQL/Redis 中按 run 创建用户/session；删除语句按 user/run 收窄；危险操作不存在；残留被发现 | 现有 `e2e/webe2e/main.go` 的按用户清理先例 |
| 正式启动 | build 后的 `cmd/server` 使用显式 E2E 配置，真实执行 migration，healthz 确认 DB/Redis | 当前部署启动顺序和 `/v1/healthz` |
| 未登录浏览器 | 真实 Go auth middleware 的 401 envelope 与前端登录跳转 | 当前 smoke 未登录场景，但移除 API mock |
| 已登录控制台 | 真实 Redis session、user repository/MySQL、空 agents/devices/follows 和嵌入 SPA | 当前 controller/middleware 单测与控制台页面测试 |
| 设备授权 | authorize → pending → approve → token，重复消费失败，SQL oracle 读取 flow/device/token | 现有 device service/controller 测试；新增真实存储主链 |
| 响应式浏览器 | desktop/mobile 下登录、控制台和设备授权无水平溢出 | 当前 smoke 双 project 先例 |
| SPA fallback | 未知前端路由渲染 404，不存在 asset 保持 HTTP 404 | `internal/web/embed_test.go` 与当前 smoke 404 场景 |
| CI 临时环境 | 从空 MySQL/Redis job 完整执行唯一 `make e2e`，失败证据可读且容器销毁 | 当前 CI 独立 e2e job |
| 本地人工验证 | `serve + drive + scratch` 连接真实 server/MySQL/Redis，origin/只读 SQL/证据目录约束保持 | 现有 drive 与 verification 工作流 |
| 文档事实检查 | 所有现行命令和路径存在；旧入口只允许出现在历史规格中；相对链接可解析 | `docs/documentation.md` 的 fact-check 规则 |

自动化不能替代人工对复杂 UI 观感或一次性运行态的判断，因此这些继续由 `serve + drive` 或 scratch 规格观察，并按 `docs/verification.md` 记录。GitHub、agentred 与 Wails 明确不自动化于本轮，也不得在完成报告中描述为已验证。

## 未决问题

无。
