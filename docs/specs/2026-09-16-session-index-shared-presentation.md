# 会话索引共享呈现与空组所有权

> Status: Approved
> Owner: 共享前端 / 两端会话索引
> Last updated: 2026-09-16

**Objective:** 让桌面端与 server 控制台由同一套共享呈现规则渲染会话索引的组列表、筛选、空态和组内全量弹层，使空组密度、交互、文案和恢复路径不再随宿主分叉。

**Hard invariant:** 数据获取、导航、平台集成和副作用继续由各宿主持有；共享包不得引入 Wails、React Router、HTTP/session client、宿主 store、dnd-kit 或平台条件分支，desktop 的项目树拖拽、server 的键盘导航与两端既有会话入口不得退化。

## Problem

1. **连续空组的密度由 server 宿主偶然决定。** `agentre-server/frontend/src/components/session/SessionIndex.tsx` 的索引根容器用 12px 纵向间距组织控制区；组直接作为同级子节点时，这个间距会重复落到每个空项目组之间。server 提交 `1ac802e` 用本地列表容器消除了现象，但共享包仍未拥有“多个会话组如何连续排列”的规则，desktop 与 server 仍可能再次分叉。
2. **server 无法把正常行交给共享 `SessionGroup`。** 共享组件在打开新标签、重命名和删除动作上把字符串行 ID 强转为数字，而 server 的稳定行键包含机器与会话两维，不能转成数字。server 因而把行放进 `renderAfterSessions`，并自行处理空态触发、菜单和“查看全部”入口顺序；共享组件名义上拥有空态，实际不能完整承接 server。
3. **同一索引控件有两份呈现和状态机。** 两端分别实现“全部 / 运行中 / 未读”筛选、索引级空态以及组内“查看全部 N”弹层，已经出现样式、点击语义、恢复动作、加载状态和错误呈现差异。
4. **已知空机器组策略重复。** 共享轴投影只从现有行生成机器组，server 另行补齐机器并重排，desktop 又从自己的机器名单建立空组骨架。漏掉任一宿主补丁都会让刚配对但没有会话的机器从索引消失。
5. **收窄后的空组会说出错误结论。** server 已在搜索或筛选造成组内零行时关闭“暂无会话”，改由索引级空态解释；desktop 仍可能把“没有匹配当前条件”呈现成“这台机器上还没有对话”。
6. **desktop 的组内弹层标题过滤只检查已加载页。** 用户看到的是搜索控件，但它没有覆盖整个组，与会话索引已经淘汰的“只搜索首屏”缺陷同类。

## Actors and user stories

1. 作为查看多个项目或机器的用户，我希望空会话组连续紧凑排列，同时仍能分辨控制区和组列表，这样空组不会累计成大片无意义留白。
2. 作为筛选或搜索会话的用户，我希望空结果准确说明是哪一种条件造成的，并给出一条可执行的返回路径，而不是声称项目或机器本来没有会话。
3. 作为查看某个组全部会话的用户，我希望弹层在两端有一致的加载、分页、失败与空态行为，并且搜索不会假装覆盖尚未加载的数据。
4. 作为键盘、读屏或多标签页用户，我希望共享化之后仍能使用方向键、焦点、右键菜单、中键或修饰键打开等既有能力。
5. 作为维护者，我希望共享组件拥有两端共同呈现的全部规则，而宿主只适配数据、导航与副作用。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | 采用分层共享组件，不共享整个 `SessionIndex` | 两端的数据源、项目树、导航和机器状态不同，但列表、筛选、空态和弹层是同一产品概念。Rejected: 巨型共享索引——会形成平台条件与大量宿主 slots；仅共享 hooks——仍会保留两份 DOM、样式和无障碍行为 |
| 2 | `SessionGroupList` 只拥有紧凑列表容器并接受 `children` | 这足以隔离宿主控制区间距，同时允许 desktop 在外部保留递归树与 DnD。Rejected: 让列表接管组映射和组头选择——会把宿主产品动作推成 prop explosion |
| 3 | `SessionGroup` 与 `SessionRow` 的动作身份统一为原始字符串 ID | 共享 `SessionRowModel.id` 本来就是字符串；包内转成数字破坏 server 的复合身份。Rejected: server 再维护一份数字映射——增加隐式状态和错删风险 |
| 4 | 行菜单只呈现宿主实际提供的动作 | 缺少 handler 的动作不是禁用能力，而是不存在的能力。Rejected: 固定显示重命名、打开与删除三项——server 会出现按下无反应的死菜单项 |
| 5 | server 正常行进入 `SessionGroup.sessions` | 只有这样，行与空态互斥、“查看全部”位于行之后、attention 去重和折叠可达性才真正由共享组件负责。Rejected: 继续用 `renderAfterSessions`——保留空态和弹层的宿主补丁 |
| 6 | 筛选采用 desktop 胶囊样式和 toggle 语义，同时采用 server 的分组无障碍语义 | 用户决定。固定三档为“全部 / 运行中 / 未读 N”；再次点击已选中的非全部档回到全部。Rejected: radio 式重复点击无动作；宿主 `variant`——允许产品表现继续漂移 |
| 7 | 索引级空态采用 server 的完整形态，筛选理由优先于搜索理由 | 用户决定。筛选有可见 chip、账号总数和明确“看全部”回程；搜索框自身仍可清除。Rejected: desktop 的纯文字空态——没有恢复路径；搜索优先——不解释当前 chip |
| 8 | “查看全部 N”由一个共享弹层状态机承载 | 用户决定。两端共同需要首次加载、追加、失败保留、重试、空态和关闭重开刷新。Rejected: 两份弹层；只共享按钮或 loader hook——仍会让视觉和错误行为漂移 |
| 9 | 删除 desktop 弹层内只过滤已加载页的标题搜索 | 用户决定。它不能回答整个组，呈现为搜索会误导用户。完整搜索继续走索引的数据查询。 |
| 10 | `AxisInput.machines` 是共享投影的已知机器名单，`buildAxisGroups` 直接生成空机器组 | 用户决定。本条取代共享投影此前“机器轴只摆有行组”的规则，使 server 无需第二次补齐。desktop 的 roster 是宿主数据源和本机优先排序依据，但必须传入共享投影，并以共享输出决定名单内空组是否存在。Rejected: 独立补齐函数或 server 补丁——调用遗漏会让机器消失 |
| 11 | `AxisInput.agents` 是 Agent 轴的权威组名单，已知 Agent 即使没有会话也显示 | 用户决定。空 Agent 组保留组头及其新建会话入口；收窄时组头保留、组内空文案静默。本条取代共享投影此前“Agent 轴只摆有行组”的规则。Rejected: 只显示有会话的 Agent——desktop 会失去现有组头入口；两端继续不同——同一产品轴仍分叉 |
| 12 | 项目轴在两端都常驻“随手对话”组 | 用户决定。已有项目时空组保留入口；账号完全为空且没有项目时，页面级真空态替代整份列表；收窄无结果时组头保留但组内空文案静默。本条取代共享投影此前“兜底组只在有行时出现”的规则。Rejected: 只在有未归项目会话时显示——丢失直接入口；两端继续不同——项目轴结构仍分叉 |
| 13 | 筛选、索引空态、组内空态和弹层 copy 进入 `agentreUi` namespace | 这些文字属于共享呈现，包括默认“暂无会话”和机器空态。搜索框、新建菜单、机器连接状态等仍由宿主持有的控件继续保留宿主 copy；只有唯一消费者已经迁入共享包的 key 才从宿主删除。Rejected: 通过 label/title props 回传共享文字——名义共享、实际仍由宿主复制 |
| 14 | 共享包提供会话索引专用的宿主中立空态与行骨架 | server 现有 `InlineEmpty` 和 `SessionListSkeleton` 不能被共享包反向 import；共享实现应复用包内 `Skeleton` 原语。server 的组织索引等非会话消费者不因本轮被迫迁移。Rejected: 从 server import 呈现件——违反依赖方向；两端各画一份——继续漂移 |
| 15 | 能力差异用窄 props/ports 表达，不使用 `isDesktop`、`isWeb` 或视觉 variant | desktop 的头像和右侧定位、server 的自适应垂直定位是真实能力差；其余呈现必须一致。 |
| 16 | 共享包和 desktop 先形成已推送的不可变提交，server 再更新 pin | server 从 GitHub commit 安装共享包，未推送或浮动引用会使独立构建不可复现。Rejected: 先删除 server 实现——消费者会在共享修订可解析前失去工作实现 |

## Shared presentation contract

`SessionGroupList` 在控制区与组集合之间形成唯一列表边界。控制区到整个列表可以保留 12px 间距；列表内相邻顶层组不增加额外纵向间距。它不判断有哪些组、不排序、不渲染页面级空态，也不认识 DnD。

`SessionGroup` 接受宿主投影好的常规行与 attention 行。行模型保留字符串 ID、标题、状态、链接、`attentionRank`，以及 overline、行首、第二行、行尾和链接外动作插槽；链接内的 `trailing` 与链接外的 `rowActions` 继续分开，避免嵌套交互元素。选择、打开新标签、重命名与删除端口收到原始字符串 ID；desktop 在自己的适配边界转换本地数字主键，server 直接使用复合键。链接渲染端口同时得到字符串行身份，使 server 能继续设置导航目标而不向共享 DOM 注入宿主约定。

共享行菜单只显示已有端口对应的项。删除保持 destructive 呈现并位于末尾；只有删除前确有其他菜单项时才显示分隔线。没有任何菜单端口时，行不产生菜单外壳。

`renderAfterSessions` 继续存在，但只承载真正位于当前组行之后的结构，例如 desktop 的子项目树或“本项目会话”内层组；它不再承载 server 的正常会话行或连接中骨架。`SessionGroup` 提供独立的 pending 内容槽：有 pending 内容时它替代常规空态、使用共享的会话行骨架，并继续由宿主决定 `aria-busy`、连接状态和重试动作。

本轮新增并从共享包唯一 barrel 导出的公共呈现合同为 `SessionGroupList`、`SessionFilterChips`、`SessionIndexEmpty`、`SessionGroupOverflow`、会话行骨架，以及它们的宿主中立 view/loader 类型；具体导出名在实施中不得产生同义副本。

## Filtering and empty states

共享筛选是受控组件，固定接收当前可见值 `all | running | unread`、未读数量和变更端口。点击运行中或未读时，共享组件计算下一值并报告给宿主：未选中时报告该档，已经选中时报告 `all`；点击全部也报告 `all`。宿主继续拥有实际筛选状态和取数。server 的会话索引筛选状态同步收窄为这三档；底层仍可保留供 attention 等内部判定使用的 waiting 事实，但它不是索引筛选值，也不能借此增加第四颗 chip。未读数量为零时不显示数字徽标。

筛选组具有可读的分组名称，每颗 chip 报告按下状态并保留稳定的测试身份。三档使用 desktop 既有胶囊形态；字体、内边距和焦点环由共享包统一。

宿主按轴的已知组与可见行共同决定是否挂载共享索引空态，不以“没有可见行”单独作为判据。空态文案按以下优先级解释：

1. 非全部筛选生效时，标题逐字点名当前筛选档。账号总数大于零时说明外面还有多少条并提供“看全部”；总数未知时省略数量但仍提供“看全部”；总数为零时不制造通向另一块空白的动作。
2. 没有筛选而搜索生效时，说明没有匹配项，并在宿主提供清除端口时显示“清除搜索”。
3. 没有筛选和搜索时，说明账号还没有会话，不显示无效回程。

搜索与筛选同时生效且结果为空时按筛选解释。已知 Agent 在两端都生成组；未收窄时空 Agent 组显示“暂无会话”并保留组头的新建入口，收窄时组头保留但组内空文案静默。项目轴在两端都常驻“随手对话”组：已有项目时空组如实显示并保留入口；账号完全没有项目和会话时，页面级“还没有对话”替代整份组列表；收窄无结果时项目与“随手对话”组头可以保留上下文，但组内空文案静默。机器轴未收窄且存在已知机器时由各组如实说明空态；没有任何已知机器和会话时显示页面级真空态。时间轴没有已知组可提供上下文，零行时直接按筛选、搜索、真空三路显示页面级空态。任何轴因搜索或筛选造成所有行消失时统一显示一次页面级空态，保留的组头只提供上下文，不重复显示“暂无会话”。

## Group overflow

`SessionGroup` 在常规行之后渲染“查看全部 N”触发器；折叠时触发器退出键盘可达性。弹层只在打开时挂载并获取第一页，关闭后再打开从第一页重新开始，避免新旧 cursor 拼接。卸载或新一轮请求开始后，旧请求的结果不得覆盖当前状态。

分页端口只暴露不透明 cursor：第一页传空 cursor，后续传上一页返回的 cursor。desktop 的 offset 由宿主 adapter 编码和解码，server 的后端 cursor 原样透传；共享组件不认识 offset、scope、HTTP 或 Wails。

弹层统一包含组名、总数、关闭按钮、列表和页脚。首次取数尚无行时显示稳定骨架；没有结果时显示共享空态；取数失败时显示通用可恢复文案和重试，不暴露原始异常文本。追加页失败时保留已经加载的行。页脚显示已加载数量与总数；存在下一页时保留明确按钮，同时可在接近列表底部时自动触发同一动作，在飞请求必须去重。

行的具体事实仍由宿主投影，弹层通过行渲染端口保留 desktop 的实时状态订阅和 server 的路由链接。desktop 可以提供共享头部的头像；缺少头像时不留空位。desktop 向右展开，server 根据触发器上下可用空间选择方向并受 Radix 可用高度约束。定位参数只表达容器几何，不改变内容和交互。

弹层不提供本地标题搜索。完整搜索由索引查询负责，不能只过滤已经加载的页。

## Machine groups

机器轴使用“已知机器名单与行引用机器的并集”。共享 `buildAxisGroups` 保证 `AxisInput.machines` 中的机器即使没有行也生成组；被行引用但不在名单中的设备 ID 仍生成组，避免历史会话消失；完全没有设备 ID 的行进入 unknown 兜底组，unknown 永远最后。本条与已知 Agent、常驻“随手对话”的决定一并取代共享投影此前“四个轴都只摆有会话组”的规则；相关实现注释必须与新合同一致，不能继续引用相反的旧“决策 10”。

共享默认排序为在线优先、名称、数字设备 ID，server 直接采用该顺序并删除自己的二次补齐。desktop 把 machine roster 作为 `AxisInput.machines` 传入共享投影，以共享输出决定名单内空组是否存在；宿主只把共享结果按 roster 中“本机第一、其余在线优先”的 rank 排列，不再自行合成缺失机器组。

未收窄且一台可回答的机器确认返回空列表时，组内显示“这台机器上还没有对话”。离线、连接中或连接失败时不声称机器没有会话，由宿主状态角标、骨架或重试动作解释。搜索或筛选造成零行时，所有机器组的真实空态静默，交给索引级空态说明。

## Ownership boundaries

共享包拥有组列表密度、组与行的呈现和折叠语义、菜单能力呈现、固定筛选、索引空态、会话索引空态原语、会话行骨架、组内全量弹层、相关 copy，以及已知 Agent、常驻“随手对话”和空机器的投影规则。

desktop 继续拥有 Wails 调用、store、查询 scope、offset 适配、项目树递归与排序、dnd-kit 拖拽、标签页导航、命令面板、对话框、实时状态订阅以及本机第一规则。

server 继续拥有 HTTP/mirror 数据、后端 cursor 获取、React Router 链接、方向键与 Enter 导航、保存和删除副作用、项目管理动作、机器连接状态/重试/最后在线说明以及移动端状态标签。

两端分别把宿主事实投影成共享行、组、筛选和分页端口。共享包不得反向 import 任一宿主模块，也不得因类似名字下沉不同产品合同。

## Failure, compatibility and accessibility

共享化不得改变既有展开状态的 localStorage 命名空间。折叠内容保持 `aria-hidden`，不可见链接退出 Tab 顺序；方向键导航仍把真实焦点移动到 server 行链接。中键、修饰键打开和复制链接地址仍通过宿主链接渲染端口成立。

筛选、菜单和弹层都必须可由键盘完成：chips 报告 pressed 状态；菜单不出现无 handler 的死项；弹层可由 Escape、关闭按钮和外部交互关闭；加载更多永远有真实按钮，自动加载只是补充。

字符串 ID 合同是有意的公共合同修正。desktop 的数字主键只在 desktop adapter 转换，包内不再出现身份强转。server 现有复合 ID 原样往返，删除或选择不得因转换得到 `NaN` 或误命中同号会话。

筛选、索引空态、组内空态和弹层文案同时提供中文和英文；搜索框、新建菜单、机器连接状态等宿主控件的文案不迁移。宿主只删除唯一消费者已经迁入共享包的重复 key，包括迁入后的机器空态副本。未提供可选恢复端口时，对应按钮整个不渲染，而不是显示无效动作。

## Out of scope

- 共享整个会话索引页面、工具栏外壳或数据获取 hook。
- 改变 desktop 项目树层级、拖拽与项目动作。
- 改变 server 的方向键导航、保存策略、删除确认或机器连接协议。
- 新增“等你处理”筛选 chip；它仍不是本轮固定三档的一部分。
- 修改 `IndexRow.sessionId` 的数字字段或 wire 协议。
- 在弹层中新增远端标题搜索协议。
- 修改 `agentre-hub` 仓库。
- 重写或强推已经发布的 server 提交 `1ac802e`。

## Testing decisions

| Seam | What it verifies | Prior art |
|---|---|---|
| 共享行与组合同 | 复合字符串 ID 原样进入选择/重命名/打开/删除端口；菜单仅显示存在的能力；正常行、attention、pending 骨架、空态和查看全部次序正确；历史 persistence key 的 localStorage 命名空间不变 | `agentre-ui` 的 `session-group.test.tsx`、`session-row.test.tsx`、`expanded-state.test.ts` |
| 共享组列表 | 控制区只把间距施加到整份列表，相邻空组由紧凑容器连续排列；容器不接管宿主组结构 | server `session-index.test.tsx` 中 `session-index-groups` 回归测试 |
| 共享筛选 | 固定三档、胶囊呈现、toggle 回全部、未读零徽标、分组无障碍名和 pressed 状态 | desktop `session-index-page.test.tsx`、server `session-index.test.tsx` |
| 共享索引空态 | 真空、搜索空、筛选空三路；筛选优先；总数 unknown/zero/positive；无回调不摆动作；已知空 Agent；常驻“随手对话”在全空账号下让位于页面级真空态；time 轴零行直接用页面级空态；收窄时组内空态静默 | server `frontend/src/__tests__/session-index.test.tsx`；desktop `frontend/src/components/agentre/__tests__/session-index-page.test.tsx` |
| 共享弹层状态机 | 首次骨架、空结果、分页追加、在飞去重、追加失败保留、重试、关闭重开刷新、旧请求不覆盖、显式按钮与自动加载同路；desktop 不再渲染只过滤已加载页的标题搜索 | desktop `sessions-popover.test.tsx`、server `frontend/src/__tests__/session-index.test.tsx` 与 `chat.test.tsx` 的组溢出测试 |
| 共享机器投影 | roster 作为共享 `AxisInput.machines` 后，已知空机器成组、名单外引用不丢、无设备 ID 进 unknown、unknown 最后、server 默认顺序与 desktop 只做本机优先 rank 均保持 | `agentre-ui` 的 `axis-groups.test.ts`、desktop `use-index-groups.test.tsx`、server 机器轴测试 |
| desktop 宿主接入 | 项目树和 DnD 不受列表容器影响；数字 ID 在适配边界转换；offset adapter、实时状态、筛选恢复与机器轴空态正确 | desktop 会话索引与弹层既有测试 |
| server 宿主接入 | 正常行进入 `sessions`；复合 ID 删除正确；右键仅有删除；cursor adapter、上下定位、方向键焦点与项目/机器状态保持 | server `session-index.test.tsx` 与共享包接入守卫 |
| 公共边界与文案 | 新组件/类型从唯一 barrel 导出，包不引入宿主依赖，双语 key 对称且宿主不保留已迁入的重复实现 | 包 `public-api.test.ts`、boundary/i18n 守卫；server `shared-ui-package.test.tsx` 的接入守卫 |

自动化之外的真实运行核验按两个仓库各自的 `docs/verification.md` 执行；规格只要求观察共享化覆盖到的密度、空态恢复、弹层定位和响应式布局，不在这里复制证据目录、启动或清理步骤。

## Open questions

<!-- 空 -->
