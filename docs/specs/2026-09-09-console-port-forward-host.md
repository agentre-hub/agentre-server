# 设备端口转发：控制台这一半

> Status: Approved
> Owner: 服务端 / 控制台前端
> Last updated: 2026-09-09

**Objective:** 用户在浏览器控制台里，从设备卡上点开一条端口映射的地址，就能访问那台设备 `127.0.0.1` 上跑着的服务，包括它的长连接与 WebSocket。

## 上游规格

可观察的行为由 `agentre` 仓已批准的 [`docs/specs/2026-09-06-device-port-forward.md`](https://github.com/agentre-hub/agentre/blob/dev/docs/specs/2026-09-06-device-port-forward.md) 定义（映射存在被访问的设备上、访问地址形如 `/fw/<设备>/<端口>/*`、三道鉴权、流式与 101 升级、四种断开各自的收尾、两张失败页各给「刷新」与「回到设备」、界面不常驻同源风险提示）。**那份规格是可见行为的权威，本规格只定这一侧怎么接**：钉哪个版本、连接从哪来且怎么复用、路由挂在哪一组鉴权下、前缀怎么剥、失败页由谁渲染、小节接在设备卡的哪一层。冲突时以上游规格为准。

桌面端那一半已经落地并推送（`agentre` 仓 `dev`）。宿主侧的转发代理已抽进共享嵌套模块 `github.com/agentre-hub/agentre/pkg/wire/portforwardhost`，**本轮不重写它**。

## Hard invariant

- **上游仓一行不改。** 本轮只 pin 已推送的不可变修订；需要改上游的想法一律记为下一轮。
- **不新增表、不新增迁移。** 映射存在被访问的设备上（上游决策 1），服务端只是转发。
- **不复制共享包已有的东西。** 转发流、信用背压、101 升级归 `portforwardhost`；行的渲染归 `@agentre-hub/agentre-ui` 的 `PortForwardSection`。
- **`/fw/` 不进 `internal/api/workspace` 与 `internal/api/agentsession` 的响应面。** 它是裸字节转发，不声明任何响应结构体，R19 的守卫面因此不碰。

## Problem

1. **控制台看得见设备，却够不着设备上跑着的服务。** 设备卡展开区今天有「能跑的 Agent」「项目」「对话」三节（`frontend/src/pages/Devices.tsx:314-420`），没有任何地方承载「哪个端口」，也没有一条能把 HTTP 送进那台机器的路由——`internal/api/router.go` 下与端口转发相关的路由为零。
2. **服务端今天拿不到一条可复用的设备连接。** 唯一的拨号入口 `Supervisor.dialWithTimeout`（`internal/service/mirror_svc/resident.go:206`）返回**未导出**的 `*machineConn`，包外取不到 `*protorpc.Conn`；四个既有消费者（`activity.go:34`、`imports.go:38`、`upgrade.go:99`、`Sessions.DeleteOnMachine`）全是「每次自己拨、用完就收」，没有池化、租约或引用计数。
3. **本仓的协议版本已经落后于设备。** `internal/pkg/wireversion/wireversion.go:30` 是 `MinSupported = "0.4.0"`，而上游桌面端已抬到 `0.5.0`，握手按精确匹配校验（`internal/service/mirror_svc/machineconn.go:78-84`）。**不升 pin，新版 agentred 会把本仓的镜像连接整条拒掉**——本轮的升 pin 是兼容性必须，不只是功能需要。

## Actors and user stories

1. 作为在远端设备上跑 dev server 的用户，我希望在控制台点一下就能打开它，这样我不必为了看一眼页面切去桌面端。
2. 作为用着热更新开发流的用户，我希望转发下的 WebSocket 也通，这样改一行代码不必手动刷新。
3. 作为撞上失败的用户，我希望页面告诉我是"机器没回来"还是"服务没起起来"，这样我知道该做哪件事。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | **复用共享的 `portforwardhost.Proxy`**，本仓不写第二份转发实现 | AGENTS.md 的硬不变量只批准 `pkg/wire` 这一条跨仓通道，而该包只 import `pkg/wire/*`。更实的理由：桌面端运行期查出的两条缺陷（`Expect: 100-continue` 丢上游应答、ack 被回绝导致大响应静默截断）就住在那份代码里，抄一份等于复制两个刚修好的坑。Rejected: 本仓另写一份 —— 两边必然漂开 |
| 2 | **新造一层「按（账号,设备）复用一条长活连接」的池**，带引用计数与空闲回收 | 用户决定。`Proxy` 本就按 `streamId` 多路复用；一请求一连接会让它空转，且每个资源请求都要签 JWT + 读 Redis + 一次 `auth.account` 往返（`resident.go:206-243`），打开一个 dev server 页面的几十个请求就是几十次握手。Rejected: 沿用既有的「拨了就收」—— 体验上接近「每张图片一次 SSH 登录」 |
| 3 | 池**不用 Redis 租约**，多副本各持一条到同一台设备的连接 | 镜像那条常驻要租约是因为「同一台机器同一时刻只该被一个副本跟」（`resident.go:89-93`）；端口转发没有这条排他性，浏览器打到哪个副本、哪个副本自己拨即可。Rejected: 照抄镜像的租约 —— 引入一条不需要的全局互斥 |
| 4 | **地址里的设备用 `device_id`**，形如 `/fw/12/3000/` | 用户决定。地址是给人看、给人复制的；`device_id` 短、与本仓 REST 的既有习惯一致（`?device_id=`）。代价是服务端要多一步把 id 翻成中继寻址用的指纹。Rejected: 用 `fingerprint` —— 服务端省一步，但地址长且不可读 |
| 5 | `/fw/` 挂 `SessionAuth()` **单独一组，不带 `CSRF()`** | 被转发应用自己的写请求不可能带控制台的 CSRF token，带上这道中间件等于禁掉转发下的一切 POST。这条选择的射程写在「安全」一节。Rejected: 挂进既有的 `SessionAuth+CSRF` 组 —— 转发下的写请求全部 403 |
| 6 | 前缀由 `http.StripPrefix` 在进 `Proxy` **之前**剥掉，代理这一层不再剥 | 共享包取的是 `r.URL.RequestURI()`，跟着 `StripPrefix` 改过的路径走；实测 `/fw/12/3000` 会变成 `/`（而不是空串），被转发应用拿到能用的根路径。**多剥一层会把 `/assets/x.js` 变成 `/x.js`**。Rejected: 在代理里按前缀长度切 —— 同一件事两个地方做，必然漂 |
| 7 | **已被 [2026-09-09-console-forward-failure-pages](2026-09-09-console-forward-failure-pages.md) 决策 3 取代。** **两张失败页由控制台在 `Proxy.ServeHTTP` 外面拦一层改写**，不回上游加钩子 | 用户决定。共享包今天把七种失败答成 `text/plain` + 写死中文且没留 hook（`portforwardhost/proxy.go:531-584`）；拦一层能把它换成完整页，且不开跨仓轮次。四处 `writeFailure` 全部发生在**响应头到达之前**（`proxy.go:282/309/333/482`）——头一旦发出就只会截断、不会再改状态码，所以拦一层看得见全部失败、且不会误伤已经在流的成功响应。代价见决策 8 与决策 13。Rejected: 回上游加渲染钩子 —— 再开一轮跨仓；Rejected: 只做「设备离线」那一张 —— 上游规格明写两种失败必须分开说且各给两个出口 |
| 8 | 失败页在**服务端**渲染 HTML，并为它记一条 i18n 豁免 | 用户此刻在一个转发地址上，不在 SPA 路由里；302 到 `/fw-error?...` 会改掉地址栏、也改掉「刷新」的语义。本仓服务端渲染 HTML 无先例、无 i18n 通路（`cago/pkg/i18n` 只服务 JSON 错误信封），因此与 AGENTS.md「UI copy comes from `t()`」相抵——**本规格显式豁免这两张页，并把文案限定为中文**。Rejected: 前端渲染 —— 那要求先加载 SPA，而这条地址的宿主是被转发应用 |
| 9 | 转发调用**另给一个超时预算**，不沿用会话 RPC 的 15s 默认 | 预算落在**连接**上而不是单次调用上（`resident.go:200-205`），而转发连接上跑的是 `PortForwardAck`/`Write` 这类高频小调用与长下载。照抄一键升级另给预算的做法（`upgrade.go:108`）。Rejected: 沿用 15s —— 那个数是为会话 RPC 选的，没有依据适用于这里 |
| 10 | 形状不对的 `/fw/` 请求必须落到失败页，**不得**回落 SPA 外壳 | SPA 兜底只对 `/v1/` 前缀 404（`internal/web/embed.go:49-52`），`/fw/...` 不是那个前缀。不显式处理的话，尾斜杠差一个或路径段编码不同就会得到 **200 + index.html**，在浏览器里表现为白屏而状态码正常，没有任何东西会红 |
| 11 | 小节接在设备卡展开区，**外框由本仓包**，与「对话」那一节同形 | 共享包只渲染「标题 + 内容」，外框归宿主（包内注释写明）。「对话」那一节是展开区里唯一自带 `border-t border-border pt-3` 的（`Devices.tsx:374`），端口转发照它 |
| 12 | 设备**离线时不出新增入口**，且已列出的行整行保留 | 上游规格「两端的入口」；共享包的能力检测是「回调缺席就不渲染那个控件」，宿主在 `offline` 时不传 `onCreate` 即可 |
| 13 | **已被 [2026-09-09-console-forward-failure-pages](2026-09-09-console-forward-failure-pages.md) 决策 4 取代。** 502 之后**再读一次在线状态**来分「设备离线」与「端口上没有服务」，不匹配上游文案 | 用户决定。共享包把「端口上没有服务」「设备够不着」「上游把请求断了」「转发没完成」四种**全答成 502**（`proxy.go:541-576`），只有 404/403/500 有独立状态码，因此规格原来那句「认状态码不认文案」在 502 这一格上做不到。判据取 `IsDaemonOnline` 的二次读：还在线 → 端口没服务，已离线 → 设备离线。代价写在「失败的呈现」。Rejected: 匹配 `msgNoListener` 那句中文 —— 常量在上游仓且未导出，上游改一个字这里静默失灵而本仓没有任何用例会红；Rejected: 所有 502 一律说成「端口没有服务」 —— 设备在 open 途中死掉就会叫用户去起一个其实起着的服务 |

## 连接与生命周期

**前提**：用户在控制台点开一条映射的地址。**动作**：服务端按 `(账号, 设备)` 取一条连接——已有就复用并加一次引用，没有就拨一条。**结果**：这条连接上挂一个按 `(设备, 端口)` 的 `Proxy`，这台设备这个端口上的所有请求（页面、资源、HMR 长连接）共用它。

- 引用计数归零并静置一段时间后，连接被关掉；再来请求就重拨。
- 连接断了：在飞的请求以截断结束（上游规格「设备离线 / 连接断开」那一条），`Proxy` 随之收场；下一次请求重新拨。
- 设备说这个端口不再允许转发（`onRevoked`）：关掉这个 `Proxy`，在飞的流以 `host_gone` 收场；下一次请求重新开——桌面端那一侧是关掉本机监听，控制台没有监听可关，等价物就是这条。
- 多副本各持各的连接，不互相协调。

## 访问与鉴权

浏览器请求 `/fw/<device_id>/<端口>/<任意路径>`。服务端**按序**校验，任何一项不过就以对应的失败结束，不再往中继上发任何东西：

- 没有有效登录态 → 拒绝。
- 该设备不属于当前账号，或已被吊销 → 拒绝，且**不区分「不存在」与「不属于你」**（本仓既有口径，否则就是跨账号存在性探测器）。
- 设备当前不在线 → **「设备离线」失败页**。

通过之后剥掉 `/fw/<device_id>/<端口>` 前缀，把剩余路径、方法、请求头与请求体交给 `Proxy`。端口有没有被声明**由设备判**——服务端不持有映射表，也不做这个判断。

## 失败的呈现

两种失败各是一张完整的 HTML 页面（用户此刻在浏览器标签里，四周没有控制台的外壳），说清是哪一种、下一步该做什么，并各给「刷新」与「回到设备」两个出口。「回到设备」去 `/devices`。

- **设备离线**：两条来路。open 之前的在线判定不过，直接答这一张；共享包答了 502、而二次在线判定说它已经不在线，也答这一张。
- **端口上没有服务**：共享包答了 502，而二次在线判定说设备还在线。
- 两者的区别必须说出来——一个要等机器回来，另一个要去把服务起起来。
- 502 里另外两种（上游把请求断了、转发没完成）与「端口上没有服务」**共用后一张页**。这是决策 13 明知的代价：规格没有为它们定页，而按状态码分不开它们。
- 404（映射已经不在）、403（映射已停用）、500（升级失败）状态码各自独立，**不改写**，保持共享包的纯文本答复。

## 安全

**这一节是同源风险唯一的记录处（上游决策 13）：界面里不出现它。**

路径前缀让被转发的应用与控制台**同源**。用户在明知取舍的情况下选择了它。按本仓今天的代码，"明知"的内容是这三层：

1. **所有 GET 无条件可达。** `csrfOK` 对 GET/HEAD/OPTIONS 直接放行（`internal/middleware/csrf.go:17-21`），转录正文、组织架构、设备列表、统计总览都在内。
2. **CSRF 在同源下结构性失效。** `GET /v1/auth/me` 的响应体里就带 `csrf_token`（`internal/api/auth/auth.go:37`），它自己是 GET 不需要 token；前端又把它存进 `sessionStorage`（`frontend/src/lib/api.ts:6`），而 sessionStorage 按 origin 隔离。因此**写操作同样在射程内**：吊销设备、远程升级机器、删对话、跑导入、改组织与看板。
3. **`POST /v1/relay/ticket` 把射程扩到整个账号。** 拿到那枚短效票即可自建一条 relay client websocket，对账号名下**任意一台机器**发**任意 wire RPC**——`terminal.*`、`runtime.run`、`workspacefs.readFile`，以及本轮的 `portForward*`。

**所以这个取舍的实际含义是：被转发的那个本机服务里的任意脚本，可以在当前用户账号下的任意一台机器上读文件、开终端、跑 agent。** 前提是「转发的只是自己机器上自己起的服务」。改变部署形态（例如把控制台开放给团队）时必须重新评估。

会话票的实际属性（上游规格那句「HttpOnly + Secure + SameSite=Lax」在本仓需要修正）：

| 属性 | 实际 | 出处 |
|---|---|---|
| HttpOnly | 恒为 true | `internal/pkg/session/cookie.go:25` |
| SameSite | 恒为 Lax | `cookie.go:24` |
| Path | `/`，因此会发给 `/fw/*` | `cookie.go:25` |
| Secure | **条件的**：`PublicURL` 是 `http` 时关闭 | `cookie.go:25` + `internal/bootstrap/cago.go:231-237` |

本仓确实存在 `http://coding.local:8443` 这类 http 部署（`frontend/eslint-rules/secure-context.js:4-5`），那种部署上 Secure 是关的。

其余：访问地址不可分享（只在登录态下有效）；服务端不落库、不记录被转发的内容正文。

## 版本与 pin

三处必须**同一次**改齐，否则 `internal/pkg/wireversion/wireversion_test.go` 的三条守卫会红：

- `go.mod` 的 `github.com/agentre-hub/agentre/pkg/wire` → 已推送修订
- `frontend/package.json` 的 `@agentre-hub/agentre-ui` 与 `@agentre-hub/agentre-wire` 两个 pin → 同一个 40 位 commit，随后 `pnpm install`
- `internal/pkg/wireversion` 的 `MinSupported` → `"0.5.0"`（`Protocol` 由 descriptor 自动跟随）

## 已知约束（来自共享包，本轮不改）

- **ack 节奏与窗口大小隐式耦合**：`ackEvery = windowBytes/4` 取的是 `wirelimits` 的默认值，而 open 传的是 `WindowBytes: 0`（用默认）。**本轮不得传一个非默认窗口**——传了 ack 节奏就会算错、设备侧停读，且没有任何用例会判红。
- **共享包里的失败文案是硬编码中文、无 i18n 出口**。决策 7 的改写层因此也只出中文，与决策 8 的豁免同一条。
- **升 pin 会一并带进 `agentre-ui` 的转录改动**（`auto-trigger-banner`、`markdown-text` 与新增的 `remark-disable-gfm-url-autolinks`、`transcript/dto.ts`、`transcript-row-view.tsx`、`chat.json` 既有文案）。它们进的是本仓控制台的转录渲染面，与端口转发无关，但**升 pin 是兼容性必须、不能只挑一部分**。因此「修因这些改动而红的既有前端用例」属于升 pin 那一步的范围。

## Out of scope

- 任意 TCP 隧道、可分享的公开链接、临时访问令牌、自动探测端口、转发到 `127.0.0.1` 之外——均同上游规格。
- 给 `portforwardhost` 加失败渲染钩子（决策 7 记为下一轮）。
- 收窄 `POST /v1/relay/ticket` 的射程（「安全」第 3 层）——本轮记录，不修。
- 桌面端那一半（已交付）。

## Testing decisions

| Seam | What it verifies | Prior art |
| --- | --- | --- |
| 路由与鉴权测试 | 三道校验各自拒绝；不存在与不属于你答同一种；前缀被正确剥掉（含 `/fw/12/3000` → `/`）；形状不对的请求不回落 SPA 外壳 | `internal/api/router_test.go`、`internal/controller/relay_ctr/` 既有测试 |
| 连接池测试 | 按（账号,设备）复用；引用计数归零后回收；断线后重拨；并发请求共用一条 | 本仓无先例，新建 |
| 失败页测试 | 「设备离线」与「端口上没有服务」渲染成两段不同的说明，各带刷新与回到设备；改写层的判据是状态码 + 二次在线读，不含任何上游文案匹配；404/403/500 不被改写 | 同上，新建 |
| 前端小节测试 | 新增/停用/删除；复制地址；空态；离线不出新增入口；停用行不出「打开」 | `frontend/src/__tests__/devices.test.tsx`、`device-expand.test.tsx` |
| 版本守卫 | 三条 pin 守卫同批改齐后绿；`wireview` 的穷举守卫在多出四路通知后仍绿 | `internal/pkg/wireversion/wireversion_test.go`、`internal/pkg/wireview/wireview_test.go` |

不自动化的部分：真实浏览器经转发访问一台真设备上的 dev server（含 HMR 的 WebSocket 往返、一次大文件下载）。**这也是上游那一轮记为 `not observed` 的中继路径第一次能真跑起来验**，由收尾时在联调环境跑并记录。

## Open questions

<!-- 空 -->
