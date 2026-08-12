# 移除设备能力概念（授权即完整权限）

> Status: Draft
> Owner: agentre-server maintainers
> Last updated: 2026-08-08

**Objective:** 把「设备能力」（`capabilities` / `caps`）从 agentre-server 的数据模型、接口、访问令牌与界面里整体移除，并在桌面端仓库删掉它的生产者；授权一台设备即授予该账号的完整权限，授权确认屏如实这样说。

**Hard invariant:** 设备流的其余可观察行为一律不变——授权、轮询换令牌、刷新、撤销、设备列表在去掉能力字段之外与本轮之前逐字节一致；带着旧字段的客户端与已签发的旧令牌都不因本轮失败。零 build tag、字面色禁令、`i18next/no-literal-string`、locale 键对等这些既有门禁全部维持。

## Problem

1. **能力从来没有兑现成任何一次权限判断。** `internal/pkg/jwt/jwt.go:20` 与 `:28` 的 `Caps` claim 只在 `internal/service/device_svc/device.go:207`（首次换令牌）与 `:314`（刷新）被**写入**，全仓没有任何一处读它——`grep -rn "Caps" --include='*.go'` 除这两处、`jwt.go` 自身与 `jwt_test.go` 外零命中。`devices.capabilities` 与 `device_flow_codes.client_capabilities` 同样只被解码成展示用的 map（`device.go:369-376` 的 pending 应答、`:471-488` 的设备列表）。设备一旦授权拿到的就是账号的完整权限，界面却告诉用户它只获得了三项能力。

2. **确认屏承诺的三项能力是客户端自报的常量。** 桌面端硬编码 `{"compute": true, "client": true, "file_browse": true}`（`agentre/internal/service/server_svc/login.go:127`），agentred 硬编码 `{"compute": true}`（`agentre/cmd/agentred/login.go:129`）。服务端不校验、不裁剪、不据此限制任何东西。用户读到的「这台设备将获得能力：执行编码 agent 任务 · 作为客户端接入 · 浏览项目文件」（`frontend/src/components/DeviceApproval.tsx:191`）是一句设备自己说的话。

3. **风险文案挂在这个自报字段上，失效方向是漏警告。** `DeviceApproval.tsx:137` 用 `capabilities?.compute === true` 决定是否讲「可执行任意代码与命令」。`internal/api/device/device.go:23` 的 `Capabilities` 没有任何 binding 约束，一个不发 `compute` 键的客户端在协议上完全合法——它会拿到中性文案，而实际权限与发了的那台一模一样。

4. **设计稿承诺的能力比后端存在的还多。** `设计稿/agentre-server.pen` 画板 41/44 右栏有一整块「能力卡」（节点 `eAqxN` / `ShTHY` 同列），列出 `compute` / `session.remote_start` / `session.autonomous` / `fs.browse` 四项，并写着「授权时由设备申报，撤销即失效」；画板 43 审计里有「指纹 a91f2c… · 请求 compute」与批注「能力变更只看得到当前值，还没有历史」。后三个键与「能力变更」这件事，后端一行代码都不存在。[`2026-08-07-auth-flow-redesign.md`](2026-08-07-auth-flow-redesign.md) 决策 12 已经因此拒绝把 `session.remote_start` / `fs.browse` / `filesystem.write` 写进词表——那条决策把症状挡在词表外，没有动病根。

5. **一个概念三处形态，都不影响行为。** 同一份能力 map 在服务端存在三种表示：`devices.capabilities` JSON 列、JWT 里的字符串数组（`device_entity.Device.CapabilityList()`）、接口上的 `map[string]bool`（另有 `CapabilityMap()`，只有 `device_entity/device_test.go` 在调用它）。三者互相转换的代码是活的，它们表达的约束是死的。

## Actors and user stories

1. 作为要授权一台设备的用户，我想在批准前读到这次授权的真实后果——它将拿到我账号的完整权限——而不是一份并不成立的能力清单，这样我不会因为「只有三项能力」而放松警惕。
2. 作为在控制台看设备的用户，我不想看到一份没有任何约束力的能力列表，因为我会以为撤掉其中一项就能限制那台机器。
3. 作为后来改这块的开发者，我想让「设备权限」这个概念要么真的存在、要么完全不存在，而不是留一层只写不读的壳让我误判它的语义。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | 整体移除能力概念，不保留任何降级形态 | 用户裁决（2026-08-08）：「先不用考虑机器权限，连上了就是完整的权限」。能力今天零处生效（问题 1、5），保留它等于继续对用户做一个不兑现的承诺。Rejected: 保留字段只在界面隐藏——数据仍然进库、进令牌，下一个人还会以为它有意义 |
| 2 | 授权确认屏改成一句无条件的完整权限说明，不再有中性 / 风险两档 | 决策 1 之下 `capabilities.compute` 不复存在，而分档依据本来就是自报字段（问题 3）。授权的真实后果与设备类型无关，一句话说完更准确。Rejected: 改按 `device_kind` 分档——正是 `auth-flow-redesign` 决策 7 已经否掉的做法，且四种 kind 拿到的权限完全相同 |
| 3 | JWT 的 `caps` claim 一并删除 | 只写不读（问题 1）。留着它会让下一个读令牌的人以为存在能力边界。已签发的旧令牌里多一个字段不影响解析——`jwt.go` 的 `registered` 按字段名反序列化，未知字段被忽略，因此不需要任何兼容分支。Rejected: 保留 claim 但恒为空数组——同样误导，还要为它写一句解释性注释 |
| 4 | 两个 JSON 列用追加迁移 DROP 掉 | 用户裁决（2026-08-08）。列里只有展示用的自报值，删除不影响登录 / 刷新 / 撤销 / 设备列表任一链路。仓库规矩是追加 patch 迁移、不改既有迁移（AGENTS.md 非协商项 6），Rollback 分支按 `migrations/202608030001_device_tokens_access_jti.go` 的形状补回列。Rejected: 留列只断代码引用——库里留一个没人写也没人读的字段，下次读 schema 的人还得重新考古 |
| 5 | 桌面端仓库（`agentre`）同轮清掉生产者 | 用户裁决（2026-08-08）。服务端删字段后 gin 绑定会静默忽略桌面端多发的 `capabilities`，不会出错，但桌面端会一直发一个没人认的字段。两个仓库各自独立提交（工作区规矩：不跨仓混提交）。Rejected: 只动服务端——留一段死代码等下一轮 |
| 6 | 设计稿把能力相关表达整体删除，不换成别的信息 | 与决策 1 一致。右栏已有「撤销这台设备」卡承担「这台设备能干什么、怎么停掉它」，再放一块只写一句「拥有完整权限」的卡是纯装饰。Rejected: 把能力卡换成「完整权限」说明卡——增加一块没有操作、也没有可变信息的卡片 |
| 7 | 不引入任何形式的设备权限模型作为替代 | 用户裁决（2026-08-08）：「先不用考虑机器权限」。真正的权限模型需要服务端在每条链路上执行判断，是一次独立设计，不是把这套自报字段改个形状留下来。Rejected: 保留一个 `trusted` 布尔位备用——本轮没有消费者，会先于它的用途存在 |

## 授权确认屏

**R1 — 风险说明无条件出现，且只有一种。** 进入确认屏时，账号头像旁给出一句说明：批准后这台设备将以你的身份完整接入你的 AgentRe 账户，可执行任意代码与命令，只批准你信任的设备。这句话**不因 `device_kind`、也不因任何客户端自报的字段而变化**；确认屏上不再存在「中性说明」这一档。

**R2 — 确认屏不再出现能力清单或能力摘要。** 眉标、H1 提问、设备信息面板（类别 + `platform · version`）、代码确认块、过期提示条、双按钮与脚注一律保持原样；能力摘要那一行整行消失，不留占位、不留空段落间距。

**R3 — 确认屏其余行为逐字节不变。** 倒计时按截止时刻推进、归零一次性跳过期屏、`aria-live` 只在分钟变化时改口播、拒绝与允许的跳转与错误映射、页面上没有任何 `role="dialog"`、主操作在 DOM 顺序里靠前——这些都不因本轮改变。

## 接口

**R4 — `POST /v1/oauth/device/authorize` 不再有 `capabilities` 字段。** 请求体里仍然携带它的旧客户端**照常授权成功**：该字段被忽略，不落库、不进令牌、不回显。这是本轮对旧桌面端与旧 agentred 的兼容承诺。

**R5 — `GET /v1/oauth/device/pending` 的应答不再有 `capabilities`。** `device_kind` / `platform` / `version` / `expires_in` 与各自的语义不变。

**R6 — `GET /v1/devices` 的每一项不再有 `capabilities`。** `id` / `name` / `kind` / `platform` / `version` / `fingerprint` / `last_seen_at` / `status` / `online` / `is_this_device` 与各自的语义不变，在线态仍取自中继登记且 Redis 抖动时按离线对待。

**R7 — access token 不再签发 `caps` claim。** 已签发、尚在有效期内的旧令牌**照常验签通过**，其中多出来的 `caps` 字段被忽略；吊销窗口与 `Leeway` 的既有语义不变。

## 数据

**R8 — 两列由一条追加到 `migrationList()` 末尾的迁移删除。** `devices.capabilities` 与 `device_flow_codes.client_capabilities` 被 DROP；Rollback 分支按原定义（`JSON NOT NULL DEFAULT '{}'`）补回两列。这条迁移不触碰任何其他列、索引、约束或数据行，也不修改既有的任何一条迁移。

**R9 — 设备 upsert 不再写能力列。** 冲突键仍是 `(user_id, fingerprint)`，赋值列去掉 `capabilities`、其余原样，`createtime` 仍不在赋值列里；事务内读回最终行。

## 桌面端（`agentre` 仓库）

**R10 — 桌面端与 agentred 发起设备流时不再发送能力。** 登录、设备流轮询、刷新、登出与设备列表的可观察行为在此之外不变。

**R11 — 桌面端的账号设备结构不再有能力字段。** 该字段今天**没有任何一处界面消费者**（`frontend/src/components/agentre/remote-devices/` 下除测试夹具外零引用），因此桌面端界面零变化；wails 绑定重新生成后，前端类型与相关测试夹具随之去掉这一项。

## 设计稿（`设计稿/agentre-server.pen`，本地产物，不在 Git 里）

**R12 — 能力在画板上整体消失。**

- **画板 10–13（设备授权确认，桌面/移动 × 浅/深）**：删除「这台设备将获得以下能力」整块（标题 + 两个 `CapabilityRow` 实例）；风险段落换成 R1 的那句无条件说明。
- **画板 41 / 44（桌面 · 设备，浅 / 深）**：删除右栏整块「能力卡」（标题「…· 能力」、副标题「授权时由设备申报，撤销即失效。」与四个能力条目），删除设备行上的能力芯片行；右栏由「撤销这台设备」卡独占，左右两栏的其余内容与对齐关系保持成立。
- **画板 27（移动 · 设备）**：删除设备行上的 `compute` 芯片。
- **画板 43（桌面 · 审计）**：审计条目的副行去掉「· 请求 compute」，删除批注「能力变更只看得到当前值，还没有历史」。
- **画板 40（桌面 · 总览）**：「最近授权与变更」里删除「授予 session.autonomous」那条，「安全与审计」里删除「1 台被授予完全放行」这项统计。两处描述的都是一个从不存在的能力授予动作。
- **画板 01（设计系统）**：删除 `CapabilityRow` 组件实例与组件本身，并把该板上「按钮、输入、设备行、能力项、指标卡」的说明里的「能力项」去掉。

删除后每块画板都不留空框、不留悬空标题，容器高度收拢到实际内容。

## 安全、隐私、兼容性与可访问性

- **本轮不降低任何实际权限边界，因为今天不存在这样的边界**（问题 1）。被移除的是一份从未生效的说明。真正生效的边界——令牌有效期、吊销列表、`Leeway` 窗口、按 `user_id` 的归属校验——一处不动。
- **对用户的净效果是警告变强而不是变弱**：今天只有自报了 `compute` 的设备会看到「可执行任意代码」，本轮之后每台设备都会看到（R1）。问题 3 那条漏警告的路径随之关闭。
- **兼容性双向成立**：旧客户端继续发 `capabilities` 不会失败（R4），旧 access token 继续可用（R7）。两个方向都不需要强制升级，也不需要按版本分支。
- **可访问性**：风险说明仍是与账号头像同列的一段普通正文，不依赖颜色或图标传达，屏幕阅读器读到的就是完整那句话。
- **文案**：zh-CN 与 en 同时改（`locale-parity.test.ts` 以 en 为基准守键集）。移除能力摘要与三个能力词条的键、以及风险文案的两档键；风险文案改为单个键。

## Out of scope

- **真正的设备权限模型**（按设备限制它能做什么）。见决策 7；将来若要做，是一次新设计。
- **审计里的「能力变更」历史**（画板 43 那条批注所指的功能）。它从未存在，随能力概念一并消失，不转成别的待办。
- **`agentre` 桌面端的 `GetSessionCapabilities` / `GetBackendCapabilities`**（`internal/app/chat.go:206`、`:213`）。那是 agent 后端的能力矩阵，与设备授权同名不同概念，一行不动。
- **设备的 `kind` 字段与按 kind 的显示**（桌面端 / 计算节点 / 网页 / 移动端）。它是设备型号，不是权限，保留。
- **`2026-08-07-auth-flow-redesign.md` 的重写**。本轮推翻它的决策 7、决策 12、问题 9 与用户故事 2；按仓库惯例既有规格是那一轮的历史记录，不回填改写，由本规格接管这块事实。

## Testing decisions

| Seam | What it verifies | Prior art |
|---|---|---|
| `device_svc` 单测 | 授权入参不再携带能力；pending 应答与设备列表项不含能力；签发的 claims 不含 caps | `internal/service/device_svc/device_test.go` 现有 sqlmock + mockgen 结构 |
| `device_repo` 单测 | upsert 的赋值列不含 `capabilities`，冲突键与其余赋值列不变（R9） | `internal/repository/device_repo/device_test.go:31` 现有 SQL 断言 |
| `jwt` 单测 | 签发 / 验签往返不含 caps；**一枚带 caps 的旧令牌仍验签通过**（R7 的兼容承诺） | `internal/pkg/jwt/jwt_test.go:24` |
| 迁移单测 | 新迁移排在 `migrationList()` 末尾，Migrate 与 Rollback 各自执行预期 SQL | `migrations/migrations_test.go` 现有 sqlmock 结构 |
| 控制层（muxtest） | authorize 请求体里带着 `capabilities` 时照常成功且被忽略（R4） | `internal/controller/device_ctr/device_test.go` |
| 前端 vitest | 确认屏出现无条件的完整权限说明且与 kind 无关（R1）；页面上不再有任何能力摘要（R2）；倒计时 / 拒绝 / 允许 / 无 dialog 的既有用例原样通过（R3） | `frontend/src/__tests__/device-approval-risk.test.tsx` |
| locale 对等 | 新增与删除的键在两个 locale 一致 | `frontend/src/i18n/__tests__/locale-parity.test.ts` |
| 桌面端 Go 单测（`agentre`） | 桌面端与 agentred 的授权请求体不含 `capabilities`（R10） | `agentre/cmd/agentred/login_test.go:44`、`agentre/internal/service/server_svc/devices_test.go` |

**不能自动化的**：设计稿的改动（`.pen` 不在 Git 里，没有可跑的测试）。由收尾时对画板 10–13、27、41、43、44 与设计系统板逐块截图核对覆盖，按 [`docs/verification.md`](../verification.md) 留证据。

## Open questions

无。

## References

- [`docs/specs/2026-08-07-auth-flow-redesign.md`](2026-08-07-auth-flow-redesign.md) — 前一轮认证流重做；其决策 7、12 被本轮推翻
- `docs/design.md` — 令牌、字阶与页面骨架；其中把「capability summary」当字号与行高例子的两处随本轮更新
- `e2e/fixtures/app.ts` — `mockDevicePending` 的桩数据含 `capabilities`，随 R5 更新
- `设计稿/agentre-server.pen` — web/移动控制台设计稿（**本地产物，不在 Git 里**，位于 `~/Code/设计稿/`）
