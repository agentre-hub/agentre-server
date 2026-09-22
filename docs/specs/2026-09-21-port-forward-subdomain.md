# 端口转发：随机前缀子域 + 远端目标

> Status: Approved
> Owner: 服务端 / 控制台前端 / 设备端（agentre 仓）
> Last updated: 2026-09-22

**Objective:** 用户在控制台打开一条端口映射，得到一个与控制台跨源、形如 `https://<随机前缀>.fw.agentrehub.com/` 的地址；映射的目标既可以是设备环回上的端口，也可以是设备所在网络里的 `http(s)://host:port`。

**Hard invariant:**

- 被转发的应用**拿不到**控制台的会话、CSRF token 与 relay ticket——既不同源，也不能借同站身份写控制台。
- 转发域名上**只有**转发：控制台 API、SPA 与 `/v1/*` 在转发 Host 上一律不应答。
- 设备的授权闸门仍在拨号之前：一次 open 只能拨到那条声明里存着的目标，调用方没有任何办法临时指定别的地址。
- 本规格跨 `agentre` 与 `agentre-server` 两仓，按 AGENTS.md 的依赖顺序交付：`agentre` 侧先落地、推送，`agentre-server` 再 pin 那个修订；wire 变更两仓成对推。

## 上游与取代关系

- 取代 [2026-09-09-console-port-forward-host](2026-09-09-console-port-forward-host.md) 里关于**地址形状、前缀剥离、同源取舍、会话 cookie 透传**的部分（其决策 4、6，「安全」一节，Hard invariant 里「不新增表、不新增迁移」一条）。连接池、共享代理、失败页渲染钩子等其余决策不变。
- 取代 `agentre` 仓端口转发规格里「目标恒为设备 `127.0.0.1`」「open 按端口定位」两条。该规格已在首发收口时从仓里删掉（`agentre` 提交 `a759a36d`），行为现由代码与本规格共同定义。

## Problem

1. **转发的应用与控制台同源。** 已验证：地址是 `/fw/<设备>/<端口>/…`（`internal/api/portforward/route.go:27`），挂在控制台同一个 origin 上、只有 `SessionAuth` 没有 CSRF（`internal/api/router.go:387-417`）。旧规格「安全」一节写明了后果：被转发服务里的任意脚本能读控制台全部 GET，能从 `GET /v1/auth/me` 拿到 `csrf_token` 让 CSRF 失效，还能经 `POST /v1/relay/ticket` 对账号名下任意机器开终端、跑 agent。
2. **绝对路径资源打不到被转发的应用。** 已验证：前缀在进代理前用 `http.StripPrefix` 剥掉（`internal/controller/portforward_ctr/portforward.go:170-192`），只有以 `/fw/<设备>/<端口>/` 为基准的相对链接才落在映射里。Vite、Next 等 dev server 的 `/@vite/client`、`/assets/x.js` 都是根绝对路径，会落到控制台的 SPA 兜底上。
3. **转发的应用自己的 cookie 全部丢失。** 已验证：代理前整条 `Cookie` 头被删掉（`portforward.go:189`），为的是不把控制台会话票交给被转发的服务。所以任何需要登录的被转发应用都用不了。
4. **只能转发设备自己的环回端口。** 已验证：设备闸门 `DialDeclared(ctx, port int)` 只收端口，拨号写死 `127.0.0.1`（`agentre` 仓 `internal/daemon/portforward/portforward.go:10-12`、`stream.go:138`），wire 的 `PortForwardOpenRequest` 也只有 `port`（`pkg/wire/proto/agentre/wire/wire.proto:1411-1416`）。设备所在网络里的内网站点转不出来。
5. **地址把设备号和端口摆在明面上。** 用户决定：地址里不再出现设备号和端口，改成与映射绑定的随机前缀。

## Actors and user stories

1. 作为在远端设备上跑 dev server 的用户，我希望转发出来的页面与本地打开时一样，绝对路径资源和 HMR 都正常，这样我不必为转发改应用的 base 配置。
2. 作为需要访问设备所在内网站点（含自签 https）的用户，我希望把 `https://intranet.corp:8443` 声明成一条映射，从控制台打开，这样我不必在设备上另开隧道。
3. 作为控制台用户，我希望被转发的应用无论写成什么样，都碰不到我的控制台账号。
4. 作为收藏了转发地址的用户，我希望下次直接打开书签还是同一个地址，被转发应用自己的登录状态也还在。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | 地址是 `<前缀>.<base_domain>`，前缀是 **12 位小写 base32 随机串**，不带设备号和端口 | 用户决定。Rejected: `<端口>-<设备>.fw…` —— 用户不要在地址里体现端口和设备；Rejected: 把 `(设备, 映射)` 加密进前缀、服务端不存表 —— 前缀长，也无法单独作废 |
| 2 | **每条映射一个固定前缀**：控制台第一次打开时分配，映射在就不变 | 用户决定。书签、被转发应用自己的 cookie 与 localStorage 都按 origin 存，前缀一变就全部清空。Rejected: 每次打开换新前缀 |
| 3 | 服务端**新增一张前缀表** `(前缀, 账号, 设备, 映射 id)` | 前缀不透明，服务端要能从 Host 找回设备，只能自己记。映射本体仍存在设备上，服务端不存目标。Rejected: 前缀由设备生成、存在映射里 —— 服务端拿到 Host 时不知道该去问哪台设备 |
| 4 | 生产用 `agentrehub.com` 的**专属子域层级** `*.fw.agentrehub.com`，dev 用 `*.fw.agentre.docker.local` | 用户决定用子域，不另注册域名。独立层级让通配证书只覆盖转发这一层，也不和 hub 等兄弟子域混在一起。Rejected: 独立注册域 —— 用户选了子域，同站残余风险记在「安全」一节 |
| 5 | 子域的六条加固**全做**：专属层级、控制台会话改 `__Host-` 前缀、写操作校验 `Sec-Fetch-Site`、转发独立登录、只剥自家 cookie、HSTS `includeSubDomains` | 用户决定。子域与控制台同站：Lax cookie 会随同站 POST 发出，子域还能种同名 cookie（cookie tossing）。`__Host-` 让种 cookie 失效；`Sec-Fetch-Site` 让同站写请求被拒，不再只靠 CSRF token 一道。Rejected: 只做转发那一侧 —— 控制台会话仍可被种同名 cookie |
| 6 | 转发登录走**控制台签发的一次性授权码**，换来一张只对**这一个前缀**有效的 host-only cookie；转发会话**依附控制台会话** | 控制台 cookie 是 host-only 的，本来就不会发到子域，需要一次交接。一个前缀一张票，被转发的应用 A 拿不到应用 B 的票；依附控制台会话则让「登出控制台 / 撤销设备」当场生效。Rejected: 把控制台 cookie 设成 `Domain=agentrehub.com` —— 直接把会话交给所有子域 |
| 7 | 映射目标是 `http(s)://host:port`；**纯端口 `3000` 是 `http://127.0.0.1:3000` 的简写** | 用户决定这一轮就支持远端目标，协议支持 http 和 https。Rejected: 只支持 http —— 内网站点常常只开 https；Rejected: 支持 https 但恒校验证书 —— 内网自签证书连不上 |
| 8 | 设备闸门**声明即授权**：声明过的目标就能拨，不设网段黑名单 | 用户决定。拥有设备的账号本来就能在这台设备上开 `terminal.*` 和 `runtime.run`，设备网络够得着的地方它早就够得着，放开目标不给这个账号新增任何能力。真正要守的是「谁能声明」，这仍然只有设备所属账号能做。Rejected: 默认拒绝 169.254.0.0/16 等链路本地地址 —— 拦不住有终端权限的人，只多一层误伤；Rejected: 在设备配置文件里写白名单 |
| 9 | https 目标默认校验证书，**每条映射可以单独勾选「忽略证书错误」** | 用户决定。内网自签证书很常见，但默认必须安全。Rejected: 全局开关 —— 一处图省事，所有映射都跟着变弱 |
| 10 | `open` **按映射 id 定位**，不再带端口 | 目标变成了 `(协议, 主机, 端口)`，端口不再是一条映射的唯一身份；id 本来就是启停和删除用的主键（`wire.proto:1378-1380`）。Rejected: open 带完整目标 —— 那等于让调用方指定拨号地址，违反 Hard invariant |
| 11 | 设备只改写 `Host`、同源 `Location`、`Set-Cookie` 的 `Domain`，**不改写响应体** | 前三处不改，远端站点就用不了：虚拟主机认错站、登录后跳到浏览器够不着的地址、cookie 被浏览器拒收。改写放在设备这一侧，因为只有设备知道目标是什么，两个宿主都能受益。Rejected: 改写 HTML 里的绝对链接 —— 子域已经让根路径就是应用的根，再改写只会引入一类新的解析缺陷 |
| 12 | 桌面端仍是**每条映射一个 `127.0.0.1:<随机端口>`**，只跟着改成按 id 打开、支持远端目标 | 用户决定。它本来就跨源，根路径也正常。Rejected: 改成 `<前缀>.localhost` —— 要重写桌面端的监听，而今天没有需要它的问题 |
| 13 | `/fw/` 路径**直接删除**，不留兼容期、不做重定向 | 首发按全新发布处理，不留历史包袱。Rejected: `/fw/…` 302 到子域 —— 旧地址里带着设备号和端口，服务端要先建前缀才能跳转，只为一种没有存量的旧形状留一条代码 |
| 14 | 请求**完全不带** `Sec-Fetch-*` 时，`GET` 且 `Accept` 含 `text/html` 也算顶层导航；带了 `Sec-Fetch-Mode` 就只认它 | 2026-09-22 dev 运行期验证：浏览器只对可信源（https、`localhost`）发 Fetch Metadata，http 的 dev 转发域上每次导航都不带这组头，原判据把所有导航答成 401，转发登录起不来。用户决定加兜底判据。文档导航各浏览器都带 `Accept: text/html,…`，`fetch()`/XHR/子资源的默认值不含它。Rejected: 用 `Upgrade-Insecure-Requests` 做兜底 —— 不是所有浏览器都发，比 `Accept` 多不出任何信息；Rejected: 声明 http 部署不支持转发 —— dev 就是 http，转发在 dev 上验不了 |
| 15 | 「无效目标」在所有宿主里是**同一句话**，由共享包 `@agentre-hub/agentre-ui` 持有：表单即时校验与设备 -32076 回绝都说它 | 2026-09-22 运行期验证看到控制台里表单与设备各说一句。用户决定统一成共享包那句。Rejected: 以设备那句为准 —— 文案归共享包是跨宿主所有权的约定 |

## 映射与目标（设备端 · agentre 仓）

**声明。** 一条映射由名称、目标、启用位组成；https 目标还有「忽略证书错误」一位。目标输入接受三种写法：

- `3000` → `http://127.0.0.1:3000`
- `host:port` → `http://host:port`
- `http(s)://host[:port]`：端口省略时按协议取 80 或 443

以下写法**拒绝创建**，报明确的无效目标错误（所有宿主同一句：「请输入端口、host:port 或 http(s)://主机[:端口]。」，不论是表单即时校验挡下还是设备回绝）：路径、查询串、用户信息、`http`/`https` 以外的协议、端口越界、主机为空。同一台设备上目标（规范化后的协议、主机、端口）唯一，重复时报与今天「端口已被占用」同一类的错误。映射**不可编辑**目标：要换目标就删掉重建，重建后是一条新映射，前缀也跟着换新。

**迁移。** 设备本地库追加一条补丁迁移，给已有映射补上目标字段，值等于 `http://127.0.0.1:<原端口>`、不忽略证书。已有映射的行为不变。

**打开一条流。**
- **前提：** 宿主（控制台或桌面端）拿到一条到设备的连接。
- **动作：** 宿主按映射 id 发 open。
- **结果：** 设备先过闸门——映射存在且已启用才拨号，只拨声明里存的目标；主机名在设备上解析；https 在设备上做 TLS，按那条映射的证书设置决定校不校验。

**上游改写（只作用在被转发这一跳）：**
- 请求的 `Host` 改成目标的 `host[:port]`，默认端口省略。
- 响应的 `Location` 如果指向目标自己的 origin，改成只剩路径和查询串的相对地址；指向别处的保持原样。
- 响应的每条 `Set-Cookie` 删掉 `Domain` 属性，其余属性原样保留。

**失败归因。** 今天的「端口上没有服务」扩成「目标连不上」，设备回报的原因分三种：连接被拒、名字解析失败、TLS 校验失败。已声明 / 已停用 / 设备够不着 / 上游断开 / 转发没完成的归因不变。

## 地址与路由（agentre-server）

**配置。** `port_forward.base_domain` 决定转发域：生产是 `fw.agentrehub.com`，dev 是 `fw.agentre.docker.local`。转发地址的 scheme 与端口跟 `PublicURL` 一致，所以 dev 上是 `http://<前缀>.fw.agentre.docker.local:8443/`。没有配置 `base_domain` 的部署不提供转发，控制台打开映射时报「这个部署此刻提供不了端口转发」。

**分配前缀。**
- **前提：** 已登录的控制台用户。
- **动作：** 对自己名下的一台设备、一条映射 id，调用 `POST /v1/port-forwards/links`（会话 + CSRF）。
- **结果：** 返回前缀和完整地址。对同一个 `(设备, 映射 id)` 重复调用，拿到的永远是同一个前缀。设备不是这个账号的、已撤销、不存在时一律 404，与今天不可区分的口径相同。

前缀表是新表，走新迁移，DDL 必须在 MySQL 8.4 上成立；repo 单测用 sqlmock。映射在设备上被删掉后，表里那一行保留不动：访问它时设备答「没有这条映射」，走已有的失败页。

**按 Host 分发。** 在路由最前面判断：Host 是 `<单段标签>.<base_domain>` 的请求**整条**交给转发处理器，不经过控制台的任何路由、SPA 兜底、CORS 或 CSRF 中间件；其余 Host 走控制台，控制台上的 `/fw/` 返回普通的 404。前缀不存在、不属于当前转发会话、形状不对时，一律与「设备不是你的」答同一个 404。

**每次请求的判定**（有顺序）：转发会话有效 → 会话依附的控制台会话还活着 → 前缀属于这个账号 → 设备归属仍然成立 → 设备在线 → 借连接、按映射 id 打开。任意一步不过，都走今天对应的失败答复。

**剥离。** 转交前只删掉本系统的转发 cookie 和 `Authorization` 头。被转发应用自己的 cookie 原样透传，路径与查询串也原样透传，不再有前缀可剥。

## 转发登录

1. **前提：** 浏览器带着一个没有有效转发 cookie 的请求访问 `<前缀>.<base_domain>/<任意路径>`。
   - 如果是**顶层导航**，就 302 到控制台 `/v1/port-forwards/authorize?prefix=<前缀>&return=<原路径与查询串>`。
   - 如果不是（子资源、fetch、WebSocket 升级），就答 401 纯文本，不跳转。
   - 顶层导航的判据：请求带了 `Sec-Fetch-Mode` 时，只有 `GET` 且它等于 `navigate` 才算；请求**一个 `Sec-Fetch-*` 头都不带**时（浏览器对 http 非 localhost 的源就是这样），`GET` 且 `Accept` 含 `text/html` 才算。
2. 控制台上没登录时，authorize 把用户送去登录页 `/login?next=<这条 authorize 地址>`。登录后原路回来。
3. 控制台确认这个前缀属于当前账号，签发一枚**一次性授权码**（Redis，60 秒，只能用一次，绑定前缀和控制台会话），然后 302 到 `<前缀>.<base_domain>/__agentre/callback?code=…&return=…`。前缀不属于当前账号时答 404，不签发。
4. 转发域用授权码换出一个转发会话，写下 cookie，再 302 到 `return`。
   - cookie：https 下名叫 `__Host-agentre_fw`，host-only、`Path=/`、`Secure`、`HttpOnly`、`SameSite=Lax`；http（dev）下去掉 `__Host-` 前缀和 `Secure`。
   - 授权码失效、已用过、前缀对不上时，答 400 纯文本「这个登录链接已失效，请回控制台重新打开」，不写 cookie。
5. `return` 只接受以单个 `/` 开头的相对路径。任何别的形式（`//host`、带 scheme、反斜杠）都换成 `/`，所以不存在开放重定向。

**会话寿命。** 转发会话记着它签发自哪个控制台会话，每次请求都确认那个控制台会话还在。控制台登出、会话过期、设备被撤销，下一次请求就失效，按第 1 步重新走一遍。

**保留路径。** 转发域上的 `/__agentre/` 归本系统所有，被转发应用自己的这个路径访问不到。这是已知代价。

## 控制台加固

- **会话 cookie 改名。** https 部署下控制台会话 cookie 叫 `__Host-server_session`，其余属性不变；http（dev）部署保持 `server_session`。上线后已有的登录会被登出一次，这是已知代价。旧名字的 cookie 不再读取。
- **写操作校验来源。** 凡是按 cookie 鉴权、要过 CSRF 的写请求，都额外要求 `Sec-Fetch-Site` 是 `same-origin` 或 `none`。没有这个头时退回校验 `Origin`：必须等于控制台自己的 origin 或已配置的 origins。不满足就 403，与今天 CSRF 失败的答复相同。Bearer 调用方不受影响。
- **HSTS。** 生产 ingress 下发带 `includeSubDomains` 的 HSTS。
- **Ingress 与证书。** helm chart 要能为转发域挂上通配 host `*.fw.agentrehub.com` 和它自己的 TLS secret。证书怎么签（DNS-01）、通配 DNS 怎么配，是部署的前提，不归本仓代码。

## 控制台界面

- 映射小节的「打开」「复制地址」，第一次用到时调用分配前缀，之后显示和复制的都是子域地址。显示和复制的是同一个串。
- 新增映射的表单：目标输入框接受三种写法，提示写明「端口，或 http(s)://主机:端口」；目标是 https 时出现「忽略证书错误」勾选框。
- 行上显示名称和规范化后的目标。目标是环回端口的，仍然只显示端口。
- 共享包 `@agentre-hub/agentre-ui` 的 `PortForwardSection` 是这些行和表单唯一的实现，两个宿主各自只接数据与动作。文案走 i18n。

## 失败的呈现

已有的四张页和三句纯文本全部保留，按原来的归类出现。新增：

- **目标连不上**（取代「端口上没有服务」）：分三种原因各一句话——
  - 连接被拒：「<目标> 上没有服务在监听」
  - 名字解析失败：「设备解析不了 <主机>」
  - 证书校验失败：「<目标> 的证书没有通过校验」，并提示可以在映射上勾选「忽略证书错误」

  出口仍然是「刷新」和「回到设备」。
- 转发域上未登录的非导航请求：401 纯文本。
- 授权码失效：400 纯文本，内容见「转发登录」一节。

## 安全

**这一节是转发安全取舍唯一的记录处，界面里不出现它。**

加固之后：被转发的应用在另一个 origin 上，读不到控制台的响应，拿不到 CSRF token；带 cookie 的同站写请求会被 `Sec-Fetch-Site` / `Origin` 拦下；它也种不了 `__Host-server_session`；它拿到的转发票只对自己那个前缀有效。

**残余风险（用户知情后接受）：**

1. 转发域和控制台**同站**（都在 `agentrehub.com` 下）。浏览器按站点处理的东西（`SameSite` 判定、某些按站点分区的缓存与存储）不把它们分开。要消除，只能换独立注册域。
2. 一个转发应用可以给 `agentrehub.com` 设带 `Domain=` 的 cookie，影响同站其他**没有用 `__Host-` 前缀**的 cookie。`agentre-hub` 仓的 cookie 属于这一类风险，但不在本轮范围内，只做标注。
3. 声明即授权：一条映射能把设备当成进入它所在内网的跳板。这与设备所属账号已有的终端能力等价，前提是声明方只能是设备所属账号。部署形态变化时（例如对团队开放控制台）必须重新评估。
4. dev 是 http：`__Host-` 前缀和 `Secure` 都不生效；浏览器也不对 http 源发 `Sec-Fetch-*`，所以 dev 上写操作的来源校验走的是 `Origin` 兜底，加固只剩 origin 隔离与 `Origin` 校验两层。
5. 顶层导航的兜底判据（决策 14）可以被脚本伪造：http 源上的脚本显式带 `Accept: text/html` 去请求，拿到的是 302 而不是 401。那个 302 只指向控制台的 authorize，且是跨源的，脚本读不到结果，不构成新的暴露面。

## Out of scope

- 改写被转发应用的 HTML 或 JS 内容。
- 映射目标带路径前缀（例如 `http://host/app/`）。
- 编辑已有映射的目标、重新生成前缀、自定义前缀。
- 桌面端改成域名前缀模式。
- 被转发应用对 `Origin` / `Referer` 做严格校验导致的拒绝（原样透传浏览器的值）。
- `agentre-hub` 仓的 cookie 加固。
- 通配 DNS 与通配证书的签发流程（部署前提）。

## Testing decisions

| Seam | What it verifies | Prior art |
|---|---|---|
| 设备：声明校验（agentre `internal/daemon/portforward`） | 三种写法的规范化；拒绝路径 / 非 http(s) / 越界端口；目标唯一；补丁迁移给已有行补上环回目标 | 现有 `portforward` 包单测 |
| 设备：闸门与拨号 | 按 id 打开只拨声明里的目标；已停用 / 未声明被拒；https 校验证书，勾选后放过自签（`httptest` TLS 服务器）；三种「连不上」原因各自归因 | `stream_test.go` |
| 设备：上游改写 | `Host` 改写与默认端口省略；同源 `Location` 变相对、异源不动；`Set-Cookie` 去掉 `Domain` | 同上 |
| 共享代理 `pkg/wire/portforwardhost` | 按 id 打开；新失败类别映射到对应的 `FailureKind` | `proxy_test.go`、`failure_test.go` |
| 服务端：路由树（`internal/api/portforward`） | 转发 Host 上 `/v1/auth/me`、SPA 路径都不走控制台；控制台 Host 上 `/fw/…` 答 404；未知 / 跨账号前缀答同一个 404；只剥自家 cookie，应用 cookie 透传 | 现有 `forward_test.go`（跑真实路由树 + 真实 SessionAuth） |
| 服务端：转发登录 | 导航跳 authorize、非导航答 401；不带 `Sec-Fetch-*` 时 `GET` + `Accept: text/html` 跳、`*/*` 答 401，带了 `Sec-Fetch-Mode: cors` 时即便 `Accept` 含 `text/html` 也答 401；授权码只能用一次、60 秒过期、跨账号前缀不签发；`return` 规范化；控制台登出后转发会话失效 | 无，新写 |
| 服务端：加固 | `__Host-` 名在 https 下签发与读取；CSRF 在 `Sec-Fetch-Site: same-site` / `cross-site` 下 403，缺头时按 `Origin` 判；Bearer 不受影响 | 现有 middleware 单测 |
| 服务端：前缀表 repo | 分配幂等、按前缀查询的 SQL | sqlmock |
| 前端：共享包 `PortForwardSection` | 目标输入三种写法、https 勾选框出现条件、行显示 | 现有 Vitest |

**不自动化，收尾时在 dev 上实跑并记录：**
- 真实浏览器经 `*.fw.agentre.docker.local` 打开设备上的 Vite dev server：绝对路径资源、HMR WebSocket、一次大文件下载。
- 一个设备所在内网的自签 https 站点：勾选前失败页正确，勾选后能登录、登录后跳转留在转发域。
- 书签重开：前缀不变，应用的登录状态还在；控制台登出后再开，要重新走授权跳转。

前提：本机把 `fw.agentre.docker.local` 这一后缀交给 docker.local 上的 AdGuard 解析（已验证 `dig @192.168.8.141` 能解析通配；`/etc/hosts` 不支持通配，`.local` 默认走 mDNS）。

## Open questions
