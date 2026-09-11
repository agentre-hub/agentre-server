# 数据访问层性能与事务正确性修复（agentre-server）

> Status: Approved
> Owner: internal/repository、internal/service（sync_svc / engine_svc / device_svc / activity_svc / mirror_svc / user_svc / relay_svc）、internal/controller、internal/task/crontab、配置模板
> Last updated: 2026-09-11

**Objective:** 修复同步版本号的全站串行与顺序缺陷、设备授权与首次登录的正确性缺陷，并消除已核实的逐条读写、N+1、不分批删除与缺失的连接超时，使持锁范围与时长、单事务体积和请求往返次数不再随账号数、批量大小、设备数或帧数增长。

**Hard invariant:** 所有改动对外的 HTTP 响应（状态码、错误码、载荷）、同步语义与会话索引结果保持不变，下文「可观察的要求」里明确写出的变化除外。

## Problem（均已核实）

证据来自 2026-09-11 的两路核实（只读，基线 `dev@434dc97`）；标注「真库」的在 MySQL 9.7.1 容器上实测，原始输出存于 `.dev-kit/artifacts/db-perf-fixes/verify-*-realdb-*.out`。

**正确性**
1. **`sync_repo/state.go:55-72` `NextVersion` 的 `INSERT … ON DUPLICATE KEY UPDATE` 在 `sync_account_seqs` PRIMARY 的 supremum 伪记录上持有 X 锁直到提交**（真库 data_locks）：一个账号的取号事务未提交时，**其他账号**（99 / 101 / 150）的取号全部卡在 `X,INSERT_INTENTION … supremum` 上直到 `ERROR 1205`；改为 `UPDATE … WHERE user_id=?` 时只锁本行 `X,REC_NOT_GAP`，他账号 ~12ms 完成。所有取号写路径（Push、`WithOrgWriteTx`、issue 看板写、engine_svc、Purge）因此全站串行。
2. `sync_svc/sync.go` `PurgeDeviceSyncObjects` 逐行 `NextVersion` + `Tombstone`，无事务：N 行约 7N 次往返、2N 次提交，且版本号顺序不等于提交顺序。
3. `engine_svc/engine.go` 四条写路径（`:221/:321/:371/:449`）在事务外 `NextVersion` 后 `Save`：取号时的行锁在 Save 前已释放，「版本号顺序 == 提交顺序」不成立，设备游标越过后这次写入永远不会下发（`workspace.go:1400-1418` 的不变量）。
4. `docs/architecture.md:283-286` 说身份键冲突被 `dberr` 吞掉，而代码（`object.go:132`）与测试（`sync_test.go:184`）是上抛。
5. `device_svc/device.go:140-156` `Authorize` 撞 `uk_dfc_user_code_pending`（真库 `ERROR 1062`，大小写不敏感）时客户端收到 HTTP 500；生成列无法排除过期行（真库 `ERROR 3763`）。
6. 设备轮询限速先读后写（`device.go:238-243`），多副本并发轮询都能通过，slow_down 失效。
7. `user_svc/user.go:66-102` 首次登录 FindByEmail → Create，并发时撞 `uk_users_email_active`（真库 `ERROR 1062`）或 `uk_user_identities_provider_uid` 返回 500。

**持锁与单事务体积**
8. Push 在持锁事务里每条 item 1 次 Find + UPDATE→INSERT（+自然键查询）：500 条全新 item 约 1506 条语句。
9. `durable_frame.go:108-115` `DeleteFrames` 一条无 LIMIT 的 DELETE（真库：30000 帧锁 36404 行、单事务 34MB binlog；LIMIT 1000 锁 2005 行）。
10. `device_flow_repo/device_flow.go:78-81` `DeleteExpiredBefore` 不分批（真库：命中过半时 `type=ALL` 全表扫；加 LIMIT 走 `range idx_dfc_expires`）。

**N+1 与无谓读取**
11. `agent_session_repo/save.go:84-91` `ListByUser` 带 filesort（真库 4750 行 5.51ms；count 0.61ms），调用方无一依赖顺序：`activity_svc/settings.go:26-34` 读全量只为 `len()`；`mirror_svc` `savedOnMachine` 每台机器读一次全账号名单。
12. `GET /v1/stats/settings` 与设备列表每设备 3 次 Redis（`relay_svc/relay.go:279`、`mirror_svc/protocol_mismatch.go:97`、`mirror_svc/version.go:114`）。逐指纹 `LatestDay` 走覆盖索引反向扫只读 1 行（真库 0.016ms），合并为 `IN … GROUP BY` 反而读 300 行，**不属于问题**。
13. `device_ctr/device.go:186-201,259-270` Revoke / Upgrade 为校验归属拉全部设备 + 3N 次 Redis，而 `device_svc.OwnedDevice`（`device.go:123-132`）已存在。
14. `mirror_svc/mirror.go` `Mirror.Sync` 对每条会话线性扫一遍全账号摘要（O(会话数 × 摘要数)）。
15. `crontab/activity.go:95-117` 逐账号逐机器串行、单机 30s 预算；卡住约 18 台即超出 9 分钟周期锁，cago cron 无 SkipIfStillRunning，下一轮会与之重叠。
16. 6 份 DSN 模板无 `timeout` / `readTimeout` / `writeTimeout`（go-sql-driver 默认不超时）；常驻镜像循环跑在 `context.WithoutCancel` 上（`resident.go:427`），库调用没有截止。

**Schema、索引与文档**
17. 6 个实体共 28 处 `type:` 标签与 DDL 不一致（含 `sync_avatars.Content` 标 text、DDL mediumtext），`schema_test.go:107-118` 不校验类型；`default:` 标签有运行时语义（gorm create 回调把零值替换为默认值）。
18. `agent_session_delete_todos` 按 `device_fingerprint` 查询无索引，每 60s 全表扫 + 临时表（真库 20000 行 9.44ms → 加索引 3.22ms、无临时表）。
19. `device_tokens` `ListRevokedJTIByUser` 全表扫 + hash join（真库 29 万行 83.6ms → 加 `(device_id, createtime)` 0.47ms；INPLACE/LOCK=NONE 1.37s）；`user_settings` `ListEnabledUserIDs` 全表扫（真库 10 万行 22.7ms → 覆盖索引 1.56ms）。
20. `docs/develop.md` 迁移小节未写在线 DDL 约束。真库：STORED 生成列在 `ALGORITHM=INPLACE` / `INSTANT` 报 `ERROR 1845`，`COPY, LOCK=NONE` 报 `ERROR 1846`，不写算法则整表复制（20 万行 4.5s）；VIRTUAL 列 `INSTANT` 与其上的索引 `INPLACE, LOCK=NONE` 均成功。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | `NextVersion` 先 `UPDATE sync_account_seqs SET version_seq = version_seq + ?, updatetime = ? WHERE user_id = ?`，受影响 0 行（账号首次取号）才走 `INSERT … ON DUPLICATE KEY UPDATE`，再 `SELECT version_seq`；签名不变 | 真库 data_locks 证明 UPSERT 锁 supremum 串行化全站、普通 UPDATE 只锁本行。同账号仍由本行 X 锁串行，「取号顺序 == 提交顺序」不变。纳入本轮待用户确认（核实新发现） |
| 2 | engine_svc 四条写路径与 `PurgeDeviceSyncObjects` 包进事务（与 `WithOrgWriteTx` 同形），广播在提交后；Purge 一次取 N 个版本号 | 用户决定。正确性缺陷 |
| 3 | Push 批量化：锁内一次 `sync_id IN` 预读、自然键批量预读、新对象按块普通 INSERT（不加 ON DUP），已有行仍逐行带版本条件 UPDATE；本批内维护覆盖视图，同批同 sync_id 第二条仍判冲突 | 用户决定，排在决策 1、2 之后。Rejected: `ON DUPLICATE KEY UPDATE`——会吞掉今天上抛的身份键冲突，且 sync_objects 有两个唯一键 |
| 4 | `architecture.md` 那段按代码实际行为（上抛）改写 | 代码与测试是既定契约 |
| 5 | `Authorize` 仅对 `uk_dfc_user_code_pending` 的 1062 重试（每轮重新生成码），最多 5 次，其余唯一键冲突照常上抛 | Rejected: 改 `pending_flag` 表达式——真库 `ERROR 3763` |
| 6 | 轮询限速改为条件 UPDATE：`last_polled_at <= now - interval` 才更新，受影响 0 行即 slow_down；不引入 Redis | 用户决定 |
| 7 | 分批删除统一 1000 行一批 | 与 `sync_repo`、`device_token_repo` 既有常量一致 |
| 8 | 删除 `save_test.go` 钉住的 `ListByUser` 顺序承诺并去掉 ORDER BY；新增 `CountByUser`、按机器取 conversation id 的窄方法 | 用户决定 |
| 9 | 设备在线态（relay 在线、协议不匹配、daemon build）以一次 Redis pipeline 批量读取，供设备列表与 stats 设置页共用；**逐指纹 `LatestDay` 不合并** | 真库：逐指纹覆盖索引读 1 行，合并读 300 行 |
| 10 | Revoke / Upgrade 改用 `OwnedDevice`，非本账号 / 已撤销**维持 403** | 用户决定，不改 API 形状 |
| 11 | 实体删除 `type:` 与 `not null` 标签，**保留 `default:`**；守卫全部实体不得声明 `type:` | 用户决定 |
| 12 | `device_tokens` 加 `(device_id, createtime)`、`user_settings` 加 `(activity_stats_enabled, user_id)`、`agent_session_delete_todos` 加 `(user_id, device_fingerprint)`；不加 `user_id` 列 | 用户决定；三者真库均证实改善 |
| 13 | 纯索引迁移不写先红单测，证据为「真库前后 EXPLAIN 留档 + 迁移链跑通」 | 用户决定（豁免 AGENTS.md TDD 第 1 条，仅限纯 DDL 索引迁移） |
| 14 | DSN 模板统一 `timeout=5s&readTimeout=60s&writeTimeout=60s`；常驻镜像循环每次迭代的库调用带 `Config.CallTimeout` 截止 | 用户决定 |
| 15 | activity 拉取并发度 8，整轮预算 8 分钟（早于 9 分钟周期锁），设备按账号批量查 | 用户决定 |
| 16 | `Mirror.Sync` 游标查找改为按 conversation id 建 map | 纯重构，既有 mirror 测试守行为 |
| 17 | 首次登录撞 email / identity 唯一键时，从查找路径重查**一次** | 核实员推荐 |
| 18 | 新迁移追加到 `migrationList()` 末尾，ID 取 `20260911xxxx`，每个迁移只做一件事，DDL 显式写 `ALGORITHM=INPLACE, LOCK=NONE` | AGENTS.md 第 7 条；决策 19 |
| 19 | `develop.md` 迁移小节写明：新增生成列优先 VIRTUAL（INSTANT）+ 二级索引（INPLACE, LOCK=NONE），STORED 会整表复制并阻塞写；补丁迁移 DDL 一律显式写 `ALGORITHM` / `LOCK`，使不支持时直接报错 | 真库报错原文 |

## 可观察的要求

**正确性**
1. 一个账号的取号事务未提交时，其他账号的取号不被阻塞；同一账号的取号仍串行。
2. `PurgeDeviceSyncObjects` 撤销一台设备时，所有墓碑在一个事务内落库、版本号连续递增；任一步失败时不留下部分墓碑。
3. engine_svc 的四条写路径中，取号与写入在同一事务内提交；账号广播在提交之后发出。
4. Authorize 生成的 user_code 与待授权码冲突时，请求成功并返回一个新码；连续冲突 5 次返回错误；其他唯一键冲突不重试。
5. 同一 device_code 在限速间隔内的并发或重复轮询中，至多一次通过限速，其余返回 slow_down。
6. 两个并发的同邮箱（或同 GitHub identity）首次登录都成功，库中只有一个账号。

**持锁与体积**
7. 一次 Push 在持锁事务内的往返次数不随 item 数线性增长（读与新建各为常数次批量语句）；同批同 sync_id 的第二条仍返回冲突；其余推送结果与今天一致。
8. 删除一条对话的镜像帧、清理过期 device flow 码，均按每批至多 1000 行分批执行直到删完。

**请求放大**
9. 设置页取「已保存对话数」为一次计数查询；镜像按机器取已保存对话不读取全账号名单。
10. 设备列表与 stats 设置页的设备在线态为一次 Redis 批量读取，与设备数无关。
11. Revoke / Upgrade 设备不再读取设备列表；非本账号或已撤销设备返回 403。
12. `Mirror.Sync` 查找每条会话游标为常数时间。
13. activity 定时拉取最多 8 台机器并发、整轮在 8 分钟预算内返回，预算耗尽后不再拨号剩余机器；设备清单按一批账号一次查询。
14. 所有随仓库发布的 DSN 模板带三个超时参数；常驻镜像循环交给数据库操作的 ctx 带截止。

**Schema 与文档**
15. 实体上不再声明 `type:`；`schema_test.go` 在任一实体声明 `type:` 时失败。
16. 迁移后 `agent_session_delete_todos`、`device_tokens`、`user_settings` 的对应查询走新索引（真库 EXPLAIN 留档）。
17. `docs/develop.md` 迁移小节包含决策 19 的规则。

## Non-goals

- 保留策略 / 过期清理周期（activity 日表清理、device token 清理窗口、device flow 清理周期、镜像帧保留）。
- 会话索引读路径（B2 分组查询、B14 关注计数、B15 标题搜索、B16 分组统计）——真库 5000 行账号上均在 0.03–18ms，本轮只留档。
- `LatestDay` 合并查询、`device_tokens.user_id` 列、看板服务端分页、`sync_avatars` kind 常量、`webauthn_handle` 死条件、`device_tokens.ip` 可空性、repo 方法补 user_id 参数。

## Testing decisions

| Seam | What it verifies |
| --- | --- |
| repo sqlmock | `NextVersion` 先 UPDATE、0 行时 INSERT…ODKU；分批 DELETE 的 LIMIT 与终止；条件 UPDATE 的 WHERE；`FindMany` / `CreateBatch` / `CountByUser` / `ListActiveByUsers` 的 SQL 与错误路径 |
| 真库（`opsctl` local-docker） | 决策 1 的锁范围：他账号取号不等待（留档，sqlmock 表达不了锁） |
| service mockgen + `hubtest.TxDatabase` | 事务事件序列 `[BEGIN COMMIT]` 且取号与写入同事务；Purge 一次取 N 号；批量方法 `Times(1)`、逐条方法 `Times(0)`；撞键重试次数与边界 |
| controller 测试 | Revoke / Upgrade 不调用设备列表；归属失败 403 |
| crontab 测试 | 并发栅栏（k 个同时在途才放行）；整轮预算到期后不再拨号 |
| `bootstrap/shipped_config_test.go` | 解析每个 DSN 模板三个超时 > 0 |
| `schema_test.go` / 实体守卫 | 实体不得声明 `type:` |
| 迁移 | 迁移链跑通；真库前后 EXPLAIN 留档于 `.dev-kit/artifacts/db-perf-fixes/`（决策 13） |

## Out of scope

- 桌面端与 agentred 的同名修复归 `agentre` 的 `docs/specs/2026-09-11-db-perf-fixes.md`，两仓独立提交。

## Open questions

<!-- 空 -->
