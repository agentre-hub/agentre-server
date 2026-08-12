# 多实例 / 分布式部署安全

> Status: Draft
> Owner: agentre-server maintainers
> Last updated: 2026-08-07

**Objective:** 让 agentre-server 在多副本同时运行时行为正确——启动期不会因并发迁移而起不来，定时任务不会每副本各跑一遍，请求路径上不再有依赖「进程内只有我一个」的假设；并把这条约束写进文档，让后续改动有据可依。

**Hard invariant:** 仓库仍然零 build tag；`make lint` / `make test` 仍是唯一门禁且不新增外部依赖（不引入 Docker、不连真 MySQL/Redis 跑单元测试）；依赖方向 `controller → service → repository → entity` 不变，`internal/pkg/*` 仍不导入 service/repository；不改动任何既有迁移。

## Problem

线上 `deploy/helm/values.yaml` 的 `autoscaling.enabled: true` / `minReplicas: 2` 意味着**当前就是多副本运行**。以下九点都是在这个前提下成立的缺陷，不是将来的假设。

1. **每个副本启动都独立跑迁移，而 gormigrate 全程无锁。** `cmd/server/main.go:88` 在每个 Pod 里调用 `migrations.RunMigrations`。gormigrate v2.1.2 的 `migrate()` 没有任何锁，`DefaultOptions.UseTransaction` 是 `false`（`gormigrate.go:84`）。两个副本并发启动会同时判定「这条没跑过」并同时执行同一段 DDL，后到的一个收到 `already exists`，`main.go` 的 `log.Fatalf("server start")` 让 Pod 直接退出并 CrashLoop。目前没有暴露，仅仅因为默认 RollingUpdate 对 2 副本算出 `maxSurge=1`、新 Pod 是逐个起的——靠的是滚动策略的取整结果，不是任何显式设计；首次安装、HPA 一次扩多个副本、或副本数上调都会打破它。

2. **两个定时任务在每个副本上各跑一遍。** cago 的 cron 组件就是进程内的 `robfig/cron`，`Start()` 里只有 `s.cron.Start()`，没有选主也没有锁（`cago@…/server/cron/cron.go:30-39`）。`internal/task/task.go:15-16` 注册的 `*/5` 与 `0 * * * *` 两个清理任务因此按副本数倍增。这两个任务本身是幂等的（`DeleteExpiredBefore` / `DeleteRevokedBefore` 都是 `DELETE … WHERE < cutoff`），所以现状只是多打了 N 倍的 DELETE 和 N 份日志，不产生错误数据——但下一个非幂等任务（发通知、结算、写审计）加进来就会双发，且没有任何东西会提醒作者。

3. **jti 生成有数据竞争，且跨实例熵源偏弱。** `internal/pkg/jwt/jwt.go:38,57` 持有 `*ulid.MonotonicEntropy`，`Sign` 在 `:66` 并发调用它。该类型不是并发安全的——`ulid` 库专门提供 `LockedMonotonicReader`「wraps a MonotonicReader with a sync.Mutex for safe concurrent use」（`ulid.go:587-600`）就是为此，而 `jwt.go:32` 的注释却写着「线程安全」。种子是 `rand.New(rand.NewSource(time.Now().UnixNano()))`，每进程各自播种的 math/rand；多个 Pod 被 HPA 同时拉起时种子高度相关，jti 撞车的概率不再是理论上的 80 位。jti 一旦相同，`jwt_blacklist:<jti>`（`internal/middleware/device_jwt.go:48,52`）就串号——撤销 A 设备的 token 会把 B 设备一并踢下线。

4. **限流的 INCR + EXPIRE 不原子。** `internal/pkg/ratelimit/ratelimit.go:29-35` 先 `INCR`，返回 1 时再单独 `EXPIRE`。进程若在两条命令之间消失，该 key 永久没有 TTL，对应 IP 就永久 429。多副本下 Pod 会被 HPA 随时缩掉，撞上这个窗口的机会比单实例高。该文件 `:3` 的注释把成因记为「miniredis 不支持复杂 EVAL」——**这条注释是错的**：用 `cago/pkg/utils/testutils.Redis()` 起的 miniredis 实测 `INCR` + `PEXPIRE` 的 Lua 脚本，三次调用依次返回 1/2/3，`PTTL` 读回 `1m0s`。当初记下的阻碍不存在。

5. **滚动更新期间 SPA 会白屏，且不会自愈。** `internal/web/embed.go:31-48` 的 `NoRoute` 对任何非 `/v1/` 的未命中路径都回落到 index.html，**`/assets/` 也不例外**。滚动更新时浏览器从新副本拿到新的 index.html，紧接着请求 `/assets/index-<新 hash>.js` 打到旧副本，旧副本没有这个文件，于是返回 **200 + `Content-Type: text/html`** 的 index.html。浏览器报 `Unexpected token '<'`，而且因为状态码是 200，既不会触发浏览器重试也不会被任何监控计成错误。`frontend/dist/assets/` 下确实是 `index-CWoFfTNg.css` / `index-DgcnvGNY.js` 这种带 hash 的文件名，每次构建都变。

6. **`ExchangeToken` 的已消费判断是 TOCTOU。** `internal/service/device_svc/device.go:139` 读出 flow 后判 `IsConsumed()`，直到 `:199` 才在事务里 `MarkConsumed`；而 `device_flow_repo.MarkConsumed` 的 UPDATE 只有 `WHERE device_code=?`，既不带 `consumed_at=0` 条件也不检查 `RowsAffected`。同一个 device_code 的两个并发请求会双双通过 `:139` 的检查，各自 upsert 设备并**各发一套 refresh token**。

7. **`Refresh` 的重放检测同样是 TOCTOU。** `device.go:249` 判 `row.IsRevoked()`，到 `:286` 才 `Revoke(row.ID)`，而 `device_token_repo.Revoke` 的 UPDATE 也只有 `WHERE id=?`、不检查 `RowsAffected`。同一个 refresh token 的两个并发请求都会成功轮换，**重放检测在并发下形同虚设**——这正是轮换机制存在的理由。

8. **`Approve` / `Deny` 忽略 `RowsAffected`。** `device_flow_repo.Approve` 的 WHERE 条件是完整的（`consumed_at=0 AND denied_at=0 AND expires_at > ?`），但只返回 `res.Error`，0 行也算成功。`Deny` 同理。后果是：对一个**已被换取**的 user_code 点「拒绝」，接口返回 200，用户以为拒绝成功，而设备其实已经拿到 token 并在正常工作——一个会误导人的假成功。

9. **仓库里没有任何一处写明多实例约束。** `AGENTS.md`、`docs/architecture.md`、`docs/develop.md` 都没有提到副本数，而 `deploy/README.md` 也没说 chart 默认开着 HPA 意味着什么。上面 1–8 全部是同一类错误的不同实例：作者默认了「进程内只有我一个」。没有文档，下一个人会再犯一次。

## Actors and user stories

1. 作为运维者，我想让 HPA 随便扩缩容、首次安装直接拉起多副本，而不用担心哪个 Pod 会因为迁移撞车起不来。
2. 作为维护者，我想加一个定时任务时默认只在一个副本上执行，而不需要自己想起来这件事。
3. 作为设备用户，我想在服务端滚动更新的过程中刷新页面就能继续用，而不是白屏且刷新无效。
4. 作为设备用户，我想我的一次授权只换出一套凭据、我的 refresh token 被别人重放时能被检测到，无论请求打到哪个副本。
5. 作为在控制台点「拒绝」的人，我想接口告诉我拒绝是否真的生效，而不是在设备已经拿到 token 的情况下还给我一个 200。
6. 作为下一个改这个仓库的人，我想在动手前就知道这里是多副本运行的、哪些假设不成立。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | 8 项修复放同一轮交付 | 用户决定。Rejected: 拆成「基础设施加锁」与「Device Flow 状态机原子化」两轮——后者会改变并发竞败方的可观察错误、按 `docs/testing.md` 需走真 MySQL 的 scratch 验证，风险类别与前者不同，分开评审和回滚的粒度更细。用户已知该取舍并选择一轮完成 |
| 2 | 多实例约束只写文档，不加机械守卫 | 用户决定。 |
| 3 | 迁移用 MySQL named lock 串行化，锁持有在一条专用连接上 | advisory lock 是**会话级**的，而 gorm 从连接池取连接，直接 `gdb.Exec("GET_LOCK")` 可能在 A 连接上加锁、在 B 连接上跑迁移，锁会随 A 归还池中而失去意义。因此从 `sqlDB.Conn(ctx)` 取一条固定连接持锁，迁移本身照常走连接池——advisory lock 不绑定数据，这样是正确的。进程崩溃时连接断开，MySQL 自动释放。Rejected: helm `pre-upgrade` Job 单独跑迁移——能解决问题，但 `helm upgrade` 之外的启动路径（本地 `make dev`、`docker-compose`、手工 `kubectl run`）就不再有保护，问题从代码里搬到了部署方式里 |
| 4 | 用 `GET_LOCK` 轮询而非阻塞的 `GET_LOCK` | 阻塞版没有上界，前面的副本卡住会让后面的副本静默挂起到被探针杀掉，日志里什么都看不到。轮询版有明确的等待预算，超时就返回错误、由 `main.go` 打日志退出，CrashLoop 是可见且自愈的。副作用是可以用 sqlmock 断言「拿不到锁时会重试、拿到后才跑迁移、结束后解锁」这个序列 |
| 5 | 迁移等待预算 120s，同时把 chart 的 `startupProbe.failureThreshold` 从 30 提到 60 | 现值 `periodSeconds: 5 × failureThreshold: 30` = 150s 总预算，而等待锁 120s 之后还要真正跑迁移，很容易在迁移中途被探针杀掉；`UseTransaction: false` 下被杀在中途会留下半应用的迁移。提到 60（300s）让「等锁 + 迁移」有富余。Rejected: 缩短等待预算——迁移本身可能就要几十秒，等待预算小于它没有意义 |
| 6 | 定时任务用 Redis 锁「占用当期」，**不主动解锁**，靠 TTL 自然过期，TTL 取略小于 cron 周期 | cago 的 `pkg/sync` locker 的 `UnlockKey` 是无条件 `DEL`、不校验持有者（`sync/redis.go`），任务一旦跑超 TTL，别的副本已经拿到锁，而先前那个副本的 Unlock 会把**别人的**锁删掉。改成「只 TryLock、不 Unlock」就完全绕开了这个问题：锁的语义正好是「本周期已被某个副本认领」，也正是 cron 需要的语义。TTL 取 `*/5` → 4m、`0 * * * *` → 50m。Rejected: 自己写带 owner token + Lua CAS 删除的锁——正确但等于在仓库里放第二套锁实现，而 cron 场景不需要提前释放；Rejected: 直接用 cago 的 Lock/Unlock 配对——即上述删错锁的缺陷 |
| 7 | 拿不到锁时任务返回 `nil` 而非错误 | 「另一个副本正在跑」是预期内的正常路径，不是故障。返回错误会让 cago 的 crontab 包装器（`crontab.go:37`）在每个没抢到锁的副本上打一条 `cron error`，N-1 份噪音会把真正的失败淹掉 |
| 8 | jti 改用 `crypto/rand.Reader`，去掉 Signer 的 `entropy` 字段 | `ulid.DefaultEntropy()` 看似是现成答案，但它内部同样是 `rand.New(rand.NewSource(time.Now().UnixNano()))`，只是加了把锁（`ulid.go:135-138`）——能消掉数据竞争，消不掉跨实例的种子相关性，也就是 Problem 3 的后半截。`crypto/rand.Reader` 本身并发安全，且 jti 只需要唯一、不需要单调。Rejected: `ulid.DefaultEntropy()`；Rejected: 给现有 entropy 加一把 `sync.Mutex`——同上，只解决一半 |
| 9 | 限流改成单条 Lua 脚本（`INCR` + 首次 `PEXPIRE`），并订正 `ratelimit.go:3` 那条错误注释 | 见 Problem 4 的实测：miniredis 跑得通，注释记录的阻碍不存在。留着错误注释比没有注释更糟——它会劝退下一个想修的人。Rejected: 用 pipeline 把两条命令一次发出——减少往返但不是原子的，进程在收到 INCR 结果前消失，EXPIRE 依然可能不落地；Rejected: 换 cago 的 `pkg/limit.PeriodLimit`——其源码里仍挂着 `// TODO: redis lua脚本保证原子性`，一样不原子 |
| 10 | `/assets/` 下未命中直接 404，不回落 index.html | 精确对准 Problem 5 的实际失败点：Vite 的带 hash 产物只出现在 `frontend/dist/assets/`。Rejected: 「路径含扩展名就 404」——更宽的规则会把 `/device/1.0` 这类合法 SPA 路由误判成静态资源 |
| 11 | 三处写操作改为「WHERE 带状态条件 + 断言 `RowsAffected == 1`」，repository 方法签名改为返回 `(int64, error)` | 把「改了几行」这个事实交给 service 判读，符合 `docs/architecture.md` 的「业务判断在 service，repository 只做数据访问」。Rejected: repository 内部在 0 行时返回哨兵错误——等于把业务语义塞进数据访问层，且每个调用方想要的语义不同（换取 token 是 `invalid_grant`，批准是 `user_code_invalid`） |
| 12 | `Refresh` 竞败方返回 `invalid_grant`，**不**触发 `RevokeChain` | 竞败意味着同一条 refresh token 的两个并发请求中，赢家刚刚完成轮换、链是健康的。把它当重放去 revoke 整条链，会让「客户端网络超时后重试」这种常见情况直接把用户登出。真正的重放——先用 A 换到 B、之后再用 A——依然走 `device.go:249` 的 `row.IsRevoked()` 分支，行为完全不变 |
| 13 | `Deny` 命中 0 行时返回 `user_code_invalid`（400），不再静默 200 | 见 Problem 8：0 行意味着 code 不存在、已被换取、或已拒绝。前两种情况下返回 200 是会误导人的假成功。代价是重复点「拒绝」会拿到 400，可以接受——前端在第一次成功后即离开该页 |
| 14 | 多实例约束写进 `docs/architecture.md`，`AGENTS.md` 只加一行指路 | `docs/documentation.md` 的归属表把「Layering, dependency direction, "how to add an X"」判给 architecture.md，而本约束正是「你可以假设什么」以及「怎么加一个定时任务」。`AGENTS.md` 的非协商项清单明写着 "These are enforced mechanically"，按决策 2 本轮不加守卫，因此不进那份清单，只在「Read this before you touch anything」表里加一行 |

## 交付后的可观察行为

**启动。** 副本并发启动时，只有一个在跑迁移，其余的在 `GET_LOCK` 上轮询等待，拿到锁后发现无事可做，正常继续启动。等待超过 120s 的副本以非零码退出并在日志里说明是等迁移锁超时；k8s 重启它，下一次通常就能拿到锁。任何一个副本在持锁期间崩溃，连接断开，MySQL 立即释放锁，不需要人工介入。

**定时任务。** 每个周期内，两个清理任务在整个副本集里各执行一次。没抢到的副本安静跳过，日志里不产生错误。某个副本在任务中途死掉，锁在 TTL 到期后释放，下一个周期正常继续。

**token 签发。** 并发签发的 access token 拿到互不相同的 jti，`go test -race` 下无竞争报告。

**限流。** 每 IP 每分钟 N 次的判定在整个副本集上是全局的（本来就是，走 Redis）。计数 key 一定带 TTL——不存在「计数留下了、过期没设上」的中间态。

**滚动更新期间的前端。** 请求一个不存在的 `/assets/*` 返回 404，而不是 200 的 HTML。浏览器因此报出真实的资源缺失，用户刷新即可拿到新副本的 index.html 并正常加载。SPA 的路由回落（`/device`、`/login` 等无扩展名路径 → index.html）行为不变。

**Device Flow 并发。** 同一个 device_code 的两个并发换取请求，只有一个拿到 token，另一个收到 `invalid_grant`（HTTP 400）且不留下任何设备或 token 记录。同一条 refresh token 的两个并发请求，只有一个完成轮换，另一个收到 `invalid_grant`，且**不**触发整链撤销。批准竞败方收到 `user_code_invalid`。对已被换取或不存在的 user_code 执行拒绝，收到 `user_code_invalid` 而非 200。

**未变的行为。** 单请求路径下的全部成功与失败语义不变——RFC 8628 的 `authorization_pending` / `slow_down` / `expired_token` / `access_denied` 判定、poll interval 节流、真正的 refresh token 重放检测（非并发路径）、session 与 CSRF、healthz 的返回内容，都与本轮之前一致。

## Out of scope

- **`UpdateLastPolled` 的 poll interval 节流本身仍是读-改-写。** 同一设备的两个并发轮询会各自读到同一个 `last_polled_at` 而都通过节流。后果只是 `slow_down` 比设计的宽松一点，不产生错误数据，也不构成安全问题。本轮不动。
- **`device_repo.Upsert` 的先查后写。** 同一 `(user_id, fingerprint)` 并发插入会撞上唯一约束报错。它已被本轮修复的 device_code 单次消费保护住了（一个 device_code 只会走到这里一次），单独构造并发需要两个不同的 device_code 指向同一指纹，属于另一个问题。
- **`FindOrCreateFromGithub` 的路径 2/3 并发。** 两个并发 OAuth 回调可能同时判定「email 不存在」并都去建用户，被 `uk_users_email_active` 挡下报错。真实触发需要同一个人同时点两次登录，且失败是干净的报错而非脏数据。
- **Prometheus 抓取口径。** `/metrics` 是每副本的进程内计数，chart 里只有一个 ClusterIP Service，走 Service 抓会在副本间轮询导致指标跳变。这需要 ServiceMonitor 或 Pod 级抓取配置，属于监控接入，不属于本服务的代码。
- **`RunMigrations` 被中途杀死留下半应用迁移。** 这是 gormigrate `UseTransaction: false` 的既有性质，本轮的锁只保证不并发，不改变单次执行的原子性。
- 不改动任何既有迁移文件，不新增迁移。
- 不引入机械守卫测试（决策 2）。

## Testing decisions

沿用 `docs/testing.md` 的分层，不新增测试入口、不连真基础设施：

| 修复项 | 测试位置与手段 | RED 时应看到 |
|---|---|---|
| 迁移锁 | `migrations/` 包内，用 `testutils.Database` 的 sqlmock 断言语句序列 | 现状根本不发出 `GET_LOCK`，期望落空 |
| cron 锁 | `internal/task/` 包内，miniredis（`cago/pkg/utils/testutils.Redis()`）+ 注入的假任务，断言两次「同周期」调用只有一次真正执行 | 现状两次都执行 |
| jti | `internal/pkg/jwt/`，N 个 goroutine 并发 `Sign`，断言 jti 全不相同 | `make test-backend` 已经是 `go test -race ./...`，现状直接报 data race |
| 限流原子性 | `internal/pkg/ratelimit/`，用 go-redis hook 记录实际下发的命令，断言 `PTTL > 0` 且从未出现独立的 `expire`/`pexpire` 顶层命令 | 现状会记录到独立的 `expire` |
| assets 404 | `internal/web/`，httptest 请求 `/assets/does-not-exist.js` | 现状返回 200 + `text/html` |
| 三处 RowsAffected | repository 层 sqlmock 断言 WHERE 条件与返回的行数；service 层 mockgen 让 mock 返回 0 行，断言得到对应的 OAuth 错误且事务未提交 | 现状 repository 方法签名里根本没有行数 |

**真并发只能靠人工验证。** sqlmock 与 mockgen 都无法证明两个真实事务竞争时数据库层面的行为，`docs/testing.md` 也明确禁止在单元测试里起真 MySQL。因此迁移锁与三处 TOCTOU 需要按 `docs/verification.md` 的 scratch 流程，连自有 MySQL 手工验证：并发启动两个进程看迁移是否串行、用同一个 device_code / refresh token 并发打两个请求看是否只有一个成功。证据是数据库里的行数与两个响应体，不是截图。

## Links

- 前一轮部署 spec：[`2026-08-07-gitea-k3s-deploy.md`](2026-08-07-gitea-k3s-deploy.md)（本轮要改其中的 `startupProbe.failureThreshold`）
- [`../testing.md`](../testing.md) · [`../verification.md`](../verification.md) · [`../architecture.md`](../architecture.md) · [`../../deploy/README.md`](../../deploy/README.md)
