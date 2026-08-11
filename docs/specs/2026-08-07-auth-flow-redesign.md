# 认证流按设计稿重做（含设计令牌基座）

> Status: Draft
> Owner: agentre-server maintainers
> Last updated: 2026-08-07

**Objective:** 让登录、输入设备码、设备授权确认、授权结果、404 这几屏与 `~/Code/设计稿/agentre-server.pen` 的画板 01–19、38–39 一致：共用的认证外壳、成体系的排版与圆角、四种各自成形的失败态，并把 `docs/design.md` 重写成能照着落地的设计系统文档。

**Hard invariant:** 后端一行不改——本轮只消费 `internal/api/router.go` 现有的端点与 `internal/api/device/device.go` 现有的字段。零 build tag、`no-restricted-syntax` 字面色禁令、`i18next/no-literal-string`、locale 键对等、e2e 双 project（desktop + mobile）无横向溢出，这些门禁全部维持。

## Problem

1. **五个页面各自为政，没有任何共用外壳。** `Login.tsx:38`、`Device.tsx:99`、`Devices.tsx:122`、`DeviceSuccess.tsx:8`、`NotFound.tsx:7` 各写一遍 `flex min-h-screen items-center justify-center bg-background px-4 py-12`，没有品牌标识，也没有页脚。`AppControls.tsx:42` 用 `fixed right-3 top-3` 浮在所有内容之上——它不属于任何一屏，于是也没有任何一屏为它留出空间。画板 02–17 的三段式（AuthTopBar / Main / AuthFooter）在代码里不存在。

2. **失败态只有一个红色 Alert。** 画板 18「认证流 · 边界与错误态」的批注原话是「现在实现只有一个红色 Alert 兜住所有失败」。实际情况正是如此：`Device.tsx:110` 一个 `<Alert variant="destructive">{error}` 承接了代码不存在、代码过期、审批失败、用户拒绝四种完全不同的处境。其中「拒绝」尤其失真——`Device.tsx:86` 把 `t("device.denied")` 塞进 `error` 状态，于是「你主动拒绝了一台设备」被渲染成一条红色报错。

3. **后端已经把这四种失败分得很清楚，前端却全部丢掉了。** `internal/controller/device_ctr/device.go:174-199` 把 `expired_token` 映射成 `code.DeviceFlowExpiredToken`（30202，HTTP 410）、把 `user_code_invalid` 映射成 `code.DeviceFlowUserCodeInvalid`（30205，HTTP 400）。`lib/api.ts:37` 已经把 `code` 原样带进 `ApiError`，但没有任何一处读它——`Device.tsx:58` 与 `:73` 只取 `e.message`。区分能力是现成的，只是没人用。

4. **一半的设计令牌是死重量。** `--status-running` / `--status-waiting` / `--status-idle` / `--code-surface` / `--primary-soft` / `--primary-text` / `--subtle-foreground` / `--border-strong` 在 `globals.css` 里声明齐全、在 `@theme` 里映射齐全、被 `design-token-contract.test.ts` 守着，但全仓 `.tsx` 一次都没用到（`grep` 结果只命中 `globals.css` 自身）。现有页面只用 `bg-background`、`text-muted-foreground`、`border`、`text-primary` 四个。

5. **深色模式下 destructive 按钮是浅红底浅字。** `globals.css:119-120` 深色块里 `--destructive: #f87171`（浅红）配 `--destructive-foreground: #fafafa`（近白）。稿子的 `danger-fg` 深色值是 `#1A0B0C`——正因为深色下的 danger 底色是亮的，前景色必须反过来是暗的。`Devices.tsx:160` 的「解除授权」按钮在深色下就是这个组合。

6. **圆角尺度整体偏硬。** `globals.css:32` 的 `--radius: 0.5rem` 推出 `rounded-sm/md/lg` = 4 / 6 / 8px；稿子的 `r-sm / r-md / r-lg` 是 6 / 10 / 14px。差值不大但处处可见——`button.tsx` 的 `rounded-md`、`alert.tsx` 的 `rounded-lg` 全部偏小一号。

7. **没有等宽字体，而这一屏最怕认错字符。** `globals.css:203` 的 `font-family` 只有 `ui-sans-serif, system-ui, sans-serif`，没有 `--font-mono`。`Device.tsx:102` 的设备码输入框、`Login.tsx` 里本该出现的 `user_code` 全部走比例字体。稿子的设计系统板写明理由：「user_code、设备 ID、API Key 一律 JetBrains Mono —— 等宽把 0/O、1/l 的误读风险降到最低」。而 `usercode` 字母表 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`（`Device.tsx:25`）虽已剔除 0/O/1/I，剩下的 `5/S`、`2/Z`、`8/B` 在比例字体下仍然会认错。

8. **`user_code` 深链进登录页后就消失了。** `Login.tsx:20` 读出 `user_code` 只为拼进 GitHub authorize 的 query，页面上没有任何提示。画板 02 在此处有一块 `brand-soft` 的上下文条：「登录后继续授权设备 / A4F-7Q2」——用户从设备跳过来，需要看见自己要授权的是哪一台。

9. **风险文案的触发条件与稿子相反。** `Device.tsx:135` 用 `info?.device_kind === "agentred"` 决定是否显示「可执行任意代码」，`device-approval-risk.test.tsx:63` 明确断言 desktop **不**显示。但桌面端实际发送 `{"compute": true, "client": true, "file_browse": true}`（`agentre/internal/service/server_svc/login.go:113`）——它真的会跑编码 agent，却拿不到这段警告。画板 10 的设备是 `桌面应用`，警告照常显示。

10. **`docs/design.md` 写的是约束，不是设计系统。** 现有六节（colour tokens / theming / responsive / i18n / components / adding a page）讲的全是「不许写字面色」「记得两个 locale 都加」这类护栏，没有一处说明这个产品长什么样：没有字阶、没有间距尺度、没有页面骨架、没有稿子与代码的令牌对照。新加一屏时它能拦住你犯错，但帮不了你把屏做对。

## Actors and user stories

1. 作为从桌面应用点进浏览器的用户，我想在登录页就看见自己要授权的设备码，这样我知道这次跳转没跳错。
2. 作为要授权一台计算节点的用户，我想在批准前看清它将获得哪些能力、以及"能执行任意代码"意味着什么，这样我不会闭着眼睛点同意。
3. 作为输错了设备码的用户，我想就地看到哪里错了并直接改，这样我不必回到上一页重来。
4. 作为主动拒绝了授权的用户，我想看到一句确认而不是一条报错，这样我知道系统按我的意思做了。
5. 作为等太久导致代码过期的用户，我想被明确告知过期并知道下一步做什么，这样我不会反复重试同一个死码。
6. 作为要新加一屏的开发者，我想从 `docs/design.md` 直接读到字阶、间距、圆角和页面骨架，这样我不必逐个打开画板量像素。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | 本轮只做认证流与样式基座，设备管理页留给下一轮 | 用户决定。两者是独立的用户旅程，设备页依赖本轮的基座而反之不然，先合入基座能更早验证。Rejected: 一个 spec 打包做完——分支活得太久，中途 review 粒度过大 |
| 2 | 不重命名设计令牌。稿子的 `brand/surface/text/ok/warn/idle` 在代码里仍叫 `primary/card/foreground/status-*` | `components/ui/*` 五个 shadcn 组件与桌面端 agentre 都编译在这套名字上，改名要同时动它们并与桌面端分家，而 `globals.css:28-30` 明确写着「两端同源是有意的」。Rejected: 按稿子改名——收益只是文档措辞一致，代价是跨仓分裂 |
| 3 | 稿子的 `chrome` 与 `code-bg` 合并映射到既有的 `--code-surface` | 两者在稿子里的浅深值完全相同（`#F4F4F5` / `#111316`），是同一个「凹陷面」角色。`--code-surface` 已存在且深色值 `#121418` 只差一点。Rejected: 新增 `--chrome`——凭空多一个与既有令牌等值的名字 |
| 4 | 色值只改三处：`--destructive-foreground` 深色 `#fafafa → #1a0b0c`、`--code-surface` 深色 `#121418 → #111316`、`--destructive-soft` 深色 `#2a1414 → #2a1315` | 修 Problem 5，其余色值本就与稿子同源。第一处是对比度缺陷而非口味问题 |
| 5 | 圆角尺度改成 `rounded-sm/md/lg` = 6 / 10 / 14px，直接声明而不再由 `--radius` 计算 | 修 Problem 6。稿子的三档就是这三个值，`calc(var(--radius) ± n)` 凑不出 6/10/14 的非等差关系。Rejected: 保留 calc 链并改 `--radius`——任何一档对上另两档就对不上 |
| 6 | 正文用系统字体栈；只把 JetBrains Mono 的拉丁子集自托管进产物 | 用户决定。等宽在这一屏有功能意义（Problem 7），正文 Inter 与系统字体的肉眼差异很小，而前端是 `//go:embed` 进 Go 二进制的，每 KB 都进镜像。Rejected: 两套都自托管（二进制 +150–250KB）；全用系统栈（各平台等宽字形差异大，稿子 34px/字距 7 的大号码样式会在 Windows 上散架） |
| 7 | 风险文案改由 `capabilities.compute` 触发，不再看 `device_kind` | 用户决定，与画板 10 一致。桌面端确实发 `compute: true`（Problem 9），漏警告比多警告危险。Rejected: 维持 `kind === "agentred"`；两者取并集——`agentred` 若不带 `compute` 键属于假想情况，当前无任何生产者会那样发 |
| 8 | 授权确认从 `Dialog` 变成 `/device` 路由下的整页区域 | 画板 10/12 是整页布局，内容量（风险段落 + 设备卡 + 大号码 + 能力清单 + 过期条 + 双按钮 + 脚注）也超出对话框的合理体量。移动端 390 宽下对话框会被挤成全屏，不如一开始就按页排。Rejected: 保留 Dialog 并加长内容——移动端等于伪全屏，且 `role="dialog"` 会让屏幕阅读器把整页当模态 |
| 9 | 拒绝与过期各给一条路由：`/device/denied`、`/device/expired` | 画板 18 称其为「终态页」。与既有 `/device/success`（`App.tsx:33`，同样在 `RequireAuth` 之外）同族，刷新安全。Rejected: 做成 `/device` 的内部状态——刷新即丢失，用户看到的是一个空的代码输入框 |
| 10 | 代码错误就地校验，绝不跳页 | 画板 18 的批注：「就地校验，不跳页——用户还在输入上下文里」。判据是 `ApiError.code === 30205`（`DeviceFlowUserCodeInvalid`）。Rejected: 与过期一样给一条终态路由——输错一个字符就丢掉已输入内容，是惩罚而不是帮助 |
| 11 | 前端建一份错误码常量表，并用守卫测试钉住它与 `internal/pkg/code/code.go` 不漂移 | 决策 9/10 要求前端按业务码分支。守卫测试读 Go 源文件比对，与 `design-token-contract.test.ts` 读 `globals.css` 是同一手法。Rejected: 就地裸写 `30202` / `30205`——`code.go:29-37` 是 `iota` 段位，后端插入一个常量就会整体平移，而前端不会报错，只会把「过期」认成「拒绝」 |
| 12 | 「已收录」的能力键只有 `compute`、`client`、`file_browse` 三个 | 这是当前唯一的生产者实际发送的集合（`agentre/internal/service/server_svc/login.go:113`）。未收录的键按画板 10 的方式原样透出，不隐藏、不猜测。Rejected: 把稿子演示用的 `session.remote_start` / `fs.browse` / `filesystem.write` 也写进词表——没有任何后端会发它们，等于凭空承诺三种不存在的能力 |
| 13 | 授权成功页不渲染「已连接」状态 | 用户决定。`DeviceApproveResponse`（`internal/api/device/device.go:64-66`）只返回 `device_kind`，拿不到 `device_id`；且 daemon 此刻还在轮询 token，大概率尚未接入 relay。写「已连接」是一句我们答不上来的断言——与 `Devices.tsx:132` 那条注释同一原则。Rejected: 按 kind+platform+version 匹配 `/v1/devices`——同型号多台会认错 |
| 14 | 页脚三个链接照稿子渲染，各指向一个「即将上线」占位页 | 用户决定。Rejected: 只留版权不出链接；从后端配置下发 URL——后者要动后端，违反本轮的 hard invariant |
| 15 | `AppControls` 并入 AuthTopBar，取消 `fixed` 定位 | 修 Problem 1。稿子的 TopBar 是文档流里的一段，右上角控件是它的一部分。Rejected: 保留 `fixed` 并给 TopBar 让位——两个东西争同一块屏幕角落，滚动时还会叠在品牌标识上 |

## 设计令牌与排版基座

**色板。** 令牌集合与当前 `globals.css` 一致，仅按决策 4 改三个深色值。稿子的命名与代码命名的对照关系必须写进 `docs/design.md`，让拿着画板的人能查到自己该写哪个工具类：`bg → background`、`surface → card`、`surface-raised → popover`、`chrome`/`code-bg → code-surface`、`text → foreground`、`text-muted → muted-foreground`、`text-subtle → subtle-foreground`、`brand → primary`、`brand-fg → primary-foreground`、`brand-soft → primary-soft`、`brand-text → primary-text`、`ok → status-running`、`ok-soft → status-running-bg`、`warn → status-waiting`、`warn-soft → status-waiting-bg`、`idle → status-idle`、`danger → destructive`、`danger-soft → destructive-soft`、`danger-fg → destructive-foreground`、`scrim → scrim`。稿子的 `warn-fg` 与 `proj-1..5` 不进代码——前者只用于本轮范围外的项目标签，后者属于控制台。

**圆角。** `rounded-sm` 6px（小控件、码格、icon 底板）、`rounded-md` 10px（按钮、输入、内嵌面板）、`rounded-lg` 14px（卡片）。

**字阶。** Display 32/600、H1 24/600、H2 18/600、Body 14/400、Body strong 14/600、Small 13/400、Caption 12/400；等宽 Mono 13/400，大号码 34/600 字距 7。行高在多行正文上取 1.5–1.6。

**等宽的适用范围。** `user_code`（含码格与大号确认码）、设备指纹与 ID、`platform · version`、未收录的能力键名。除此之外一律正文字体。

**间距。** 4 的倍数。卡片内间距桌面 36–40，移动 24–28；卡片内区块间距 22–26。

## 认证外壳

所有认证屏与 404 共用一个纵向三段布局：顶栏、主区、页脚。

**顶栏**左侧是品牌标识（`primary` 底、`rounded-sm` 的 28px 方块 + 终端字形，右接 15/600 的产品名），右侧是语言与主题两个 34px 图标按钮，中间由弹性空隙撑开。它在文档流里，不覆盖任何内容。

**主区**纵向水平双向居中，两侧留出安全边距；内容超过视口高度时从顶部开始排而不是被裁掉。

**页脚**居中一行：版权、服务条款、隐私政策、服务状态，均为 Caption 尺寸的 `text-subtle`。三个链接分别指向 `/terms`、`/privacy`、`/status`；这三条路由公开、无需会话，各自渲染同一套外壳加一句「即将上线」。

**卡片**是 `card` 底、`border` 描边、`rounded-lg` 的容器。宽度按屏内容定：登录 424、输入设备码 496、授权确认 576、授权结果 448；移动端一律填满安全边距内的可用宽度。404 不使用卡片。

## 五屏

**登录（画板 02–05）。** 标题、GitHub 登录按钮、一行服务条款脚注。当 URL 带 `user_code` 时，标题与按钮之间插入一块 `primary-soft` 的上下文条：一行小字说明「登录后继续授权设备」，下面是等宽的设备码。`next` 与 `user_code` 仍照现有方式透传给 authorize 端点。

**输入设备码（画板 06–09）。** 眉标「设备授权」、H1、一句说明、六个独立的码格（第三与第四格之间是一个分隔符，不是可输入格）、主按钮、一行「没有看到代码？回到设备上重新发起授权」脚注。

码格接受逐格输入并自动前进，退格自动回退，粘贴整串（含或不含连字符、大小写任意）时按 `Device.tsx:27` 现有的归一化规则一次填满。六格填满即可提交。归一化后不满六位或含字母表外字符时按「就地校验」处理，不发请求。

**设备授权确认（画板 10–13）。** 当 `/device` 带上一个能查到 pending 记录的 `user_code` 时进入此屏。自上而下：眉标「设备授权」、H1 提问、一段风险说明、设备信息面板（`code-surface` 底，图标 + 类别名 + 等宽的 `platform · version`）、`primary-soft` 底的代码确认块（一行「确认这串代码与设备上显示的完全一致」+ 大号等宽码）、能力清单、过期提示条、双按钮、一行「可随时在控制台撤销」的脚注。

风险说明在 `capabilities.compute` 为真时讲明这是一台计算节点、将以你的身份运行编码 agent、可执行任意代码与命令；否则给一句中性的说明。

过期提示条是 `status-waiting-bg` 底的一行，显示由 `expires_in` 起算的实时倒计时。倒计时归零即视为过期，进入终态。

按钮在桌面横排（拒绝在左、允许在右），移动端纵排且允许在上——这是画板 12 的排布，主操作在拇指可及处。

**授权成功（画板 14–17）。** 居中的成功图标、H1「设备已授权」、一句「可以关闭这个页面，回到设备上继续」、一块设备信息面板（类别名 + 等宽 `platform · version`，无状态标记）、一个「前往控制台管理设备」的次级按钮指向 `/devices`。设备信息取自本次会话已获得的 pending 数据；若不可得（例如直接访问该路由）则整块不渲染，其余照常。

**404（画板 38–39）。** 无卡片。大号 `border-strong` 色的 404 水印、H「页面不存在」、一句「链接可能已经失效，或者地址打错了」、一个带返回箭头的「回到首页」按钮。

## 失败路径

四种失败各自成形，不再共用一个红色 Alert。

**代码不存在或已使用**（`ApiError.code === 30205`）：六个码格转 `destructive` 描边，其下给一行 `destructive` 说明「这个代码不存在或已被使用。请核对设备上显示的 6 位代码。」。停留在输入屏，输入内容保留，用户可直接改。格式不合法（长度不足、含字母表外字符）走同一处理，且不发请求。

**授权请求已过期**（`ApiError.code === 30202`，或确认屏倒计时归零）：进入 `/device/expired`。该屏给出「授权请求已过期」、一句「回到设备上重新发起授权，然后输入新的代码。」，以及一个「重新输入代码」的主按钮返回 `/device`。

**已拒绝授权**：用户点「拒绝」且请求成功后进入 `/device/denied`。该屏给出「已拒绝授权」和一个「关闭页面」的次级按钮。这一屏是中性收尾，不使用 `destructive` 色。

**登录失败**：`/login?err=<code>` 时在卡片内渲染一条 `destructive-soft` 底的 Alert，含标题「登录未完成」与具体原因，其下是「重新登录」按钮。六条已知 `err` 值沿用 `Login.tsx:7-14` 的清单与 locale 里已有的文案；未知值仍原样透出。

**其余失败**（网络中断、代理返回非 JSON、审批接口 5xx）：在当前屏内以 Alert 呈现，不跳转、不改口。与 `Devices.tsx:39-44` 的既有原则一致——说不上来的事情不许编。

## 无障碍与响应式

倒计时用 `aria-live="polite"` 播报，且每秒刷新的数字不逐秒播报（只在分钟变化时播报）。码格是六个真实的输入框，各自带 `aria-label` 标明第几位；就地校验的错误文案通过 `aria-describedby` 关联到码格组，并让码格带上 `aria-invalid`。主题与语言按钮维持现有的 `aria-label` 写法。终态页的标题是各屏唯一的 `h1`。

浅色与深色、桌面与移动四种组合都必须成立。主操作在移动端占满宽度，桌面端按内容宽。任何视口下不得出现横向滚动。

## i18n

新增的每一条文案都进 `en` 与 `zh-CN` 两份 locale。中文文案以稿子上的原文为准；英文由中文意译，不逐字直译。现有 `device.denied`、`device.approveTitle`、`device.lookup`、`device.invalidCode`、`notFound.body` 等键的语义在本轮发生变化，需要按新结构重排键名，两份 locale 同步。

## docs/design.md

重写后的 `docs/design.md` 必须能让一个没打开过画板的人照着新加一屏。它要多出四样现在没有的东西：稿子令牌名到代码令牌名的完整对照表；字阶、间距与圆角三张尺度表；认证外壳的骨架描述（三段式、卡片宽度、移动端如何退化）；等宽字体的适用边界与理由。

现有六节讲的护栏（字面色禁令、`dark` 变体的三件套、locale 对等、`nonExplicitSupportedLngs` 的坑）全部保留——它们仍然成立，且都对应着真实踩过的坑。「Adding a page」一节的外层容器示例要换成新的外壳，否则它会继续教人写出第六个各自为政的 `min-h-screen`。

它不复述画板编号之外的视觉细节，也不承担设计稿的职责：稿子是唯一的像素来源，`design.md` 是把稿子翻译成本仓库工具类与组件的那一层。

`docs/documentation.md:16` 那张归属表现在写的是「Tokens, theming, responsive, i18n」，随本轮扩到字阶、间距、圆角与页面骨架，需要同步改口，否则下一个人会去别处找这些事实。

## Out of scope

- **设备管理页 `/devices`**：本轮它随基座一起变（新的圆角、修正后的深色 destructive 前景色），结构与信息层级不动。按画板 41/27 重做归下一轮，届时只呈现 `ListDevicesItem` 真有的字段。
- **控制台外壳**：SideNav（总览/对话/设备/审计）与移动 TabBar 不建。其承载的三个区需要后端不存在的概念。
- **稿子中无后端支撑的一切**：项目、Agent、对话与会话、接单开关、并发条、用量、审计、桌面端连接状态。
- **后端改动**：不给 `DeviceApproveResponse` 加 `device_id`，不给 `ListDevicesItem` 加 `authorized_at`。前者会让授权成功页能显示真实在线态（决策 13），值得单独一轮。
- **服务条款/隐私政策/服务状态的正文**：本轮只出占位。

## Testing decisions

| Seam | What it verifies | Prior art |
|---|---|---|
| `design-token-contract.test.ts` 的 `COLOR_TOKENS` 表 | 三个改动后的深色值；`rounded-sm/md/lg` 解析成 6/10/14px；`--font-mono` 已声明且有 `@font-face` | 已有，改表即先红后绿 |
| 新增的错误码常量守卫测试 | 前端常量与 `internal/pkg/code/code.go` 的 Device Flow 段位一致 | `design-token-contract.test.ts` 读 `globals.css` 的同一手法 |
| 设备码输入组件（React Testing Library） | 逐格输入自动前进、退格回退、粘贴整串归一化、不足六位不发请求 | 无 |
| 授权确认屏（RTL） | `capabilities.compute` 为真时出风险文案、为假时不出；已收录能力出说明、未收录能力原样出键名 | `device-approval-risk.test.tsx`，其 `getByRole("dialog")` 断言需改成页面区域断言 |
| 失败分支（RTL） | 30205 停留在输入屏并标红码格；30202 落到 `/device/expired`；拒绝成功后落到 `/device/denied` | 无 |
| `locale-parity.test.ts` | 新增键在两份 locale 都在 | 已有，无需改动 |
| `eslint-guardrails.test.ts` | 新代码不写字面色、不写裸 JSX 字符串 | 已有，无需改动 |
| `e2e/smoke.spec.ts` | 「设备授权页能查到 pending 设备并弹出确认框」改为断言确认区渲染；登录页无横向溢出一条在 desktop 与 mobile 两个 project 下都跑 | 已有，需改 |

**自动化覆盖不到的**：颜色是否好看、字重层级是否分明、深浅两套的观感是否都成立。这三件事由收尾时人眼比对画板与实际渲染完成，覆盖 02/06/10/14/18/38 六块画板的浅深两版与桌面移动两版。自托管字体是否真的被加载（而非静默回退到系统字体）同样只能观察，收尾时在浏览器里确认 `document.fonts` 中存在该字族。

`docs/design.md` 本身没有自动化守卫。它由收尾时的源码审读覆盖：逐条核对文中出现的令牌名、工具类名与文件路径在代码里确实存在，且「Adding a page」的示例能照着跑通。

## Links

- 设计稿：`~/Code/设计稿/agentre-server.pen`，画板 01（设计系统）、02–17（认证流四屏 × 桌面/移动 × 浅/深）、18–19（边界与错误态）、38–39（404）
- 令牌现状：`frontend/src/styles/globals.css`
- 错误码：`internal/pkg/code/code.go:28-37`，映射见 `internal/controller/device_ctr/device.go:174-199`
- 现有能力生产者：`../agentre/internal/service/server_svc/login.go:113`

## Open questions

（无）
