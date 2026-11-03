# 预设头像库 + 统一身份区（控制台网页端）

> Status: Approved
> Owner: 控制台前端
> Last updated: 2026-11-03

**Objective:** 控制台的 Agent 详情、部门详情、新建 Agent、新建部门，改用共享包的统一身份区：一枚可点的记号，加上名称和描述。不再有单独的名称输入框、铺开的色板和图标网格。点开记号是和桌面端同一个弹层，有「预设 · 图标 · 字母」三档，可以从内置的贴纸预设里挑。挑中的预设在控制台所有显示这个身份的地方都显示出来，桌面端挑的预设在控制台也认得。

**Hard invariant:**
- 不改服务端接口和表结构，不加迁移。预设 key（`preset:<组>-<名字>`，最长 25 个字符）存进现有的 `avatar_icon` / `icon` 字段，浏览器写接口的 `max=64` 不变。
- 保存语义不变：名称和描述失焦时提交，值没变就不提交；记号和颜色一点就提交，一次只提交改动的那个键。
- 新建时用户没设置的字段照旧不提交。新建 Agent 和部门默认不带图标和颜色。
- 颜色装饰位置照旧按颜色字段显示，包括总览页的 Agent 排行色点。

**依赖：** 桌面仓规格 `agentre/docs/specs/2026-11-02-preset-avatars.md`，已经交付并合并到 agentre main 的 `bf46e288`（PR #85）。本轮先把三处钉版同时抬到这个提交，再改本站：
- `frontend/package.json` 里的 `agentre-ui`、`agentre-wire` 两项，加上 `frontend/pnpm-lock.yaml`；
- `go.mod` 里的 `agentre/pkg/wire`。

`ef5e6fd8..bf46e288` 之间协议只多了一个字段 `ClaudeCodeRateLimits.five_hour_absent`，没有改版本号。

## Problem

1. **身份信息重复，而且铺开太占地方。** Agent 详情头部已经有一枚记号，下面的「身份」栏又有名称、描述，外加铺开的色板（`OrgColorPicker`）和图标网格（`OrgIconPicker`）（`frontend/src/pages/org/OrgAgentDetail.tsx:191`、`:275-305`）。部门详情也一样（`OrgDepartmentDetail.tsx:110-115`、`:146-183`）。
2. **部门详情头部不画部门图标。** 它只画名称首字（`OrgDepartmentDetail.tsx:110-115`，经 `OrgDetailGlyph`），和部门图标字段对不上。
3. **新建对话框只能填名称。** 新建部门只有名称，新建 Agent 只有名称和部门（`OrgCreateDialogs.tsx:29-67`、`pages/Org.tsx:475-499`）。描述、记号、颜色都要建完后再进详情改。
4. **六处 Agent 记号在本站用 `iconNode(avatar_icon)` 解 key**（`SessionDetailHeader.tsx:339`、`SessionDetailView.tsx:1809`、`DraftSession.tsx:435`、`:731`、`ProjectAgentPane.tsx:337`、`AgentPickList.tsx:223`）。项目设置的成员和候选行也一样（`useProjectManagement.ts:136`、`:145`、`:185`）。`iconNode` 认不出预设 key，会返回空，所以这些位置显示不了预设。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | Agent、部门的详情和新建对话框，统一改用共享包的 `IdentityFields` + `IdentityMarkPicker`（不传 `upload`，所以没有「图片」档） | 桌面仓规格决策 2、3、5：web 没有承载头像图片的接口。Rejected: 本站另写一份 |
| 2 | Agent 详情原有的附属信息（系统 / 负责人徽标、所属部门、汇报对象、保存状态）原样放进身份区的 `meta` 插槽 | 桌面仓规格「身份区·布局」 |
| 3 | 部门详情头部改由身份区里的记号（`DepartmentMark`）显示：预设 ▸ 图标 ▸ 首字加主题色 | 桌面仓规格决策 6：两端统一 |
| 4 | 本站解 key 的位置改用 `AgentAvatar` 的 `iconKey`；项目成员行按新的共享契约传 key 字符串 | 共享包 `AgentAvatar` 的优先级是 图片 ▸ 预设 ▸ 图标 ▸ 首字母；`ProjectMemberView.avatarIcon` 现在是 key 字符串 |
| 5 | 删除 `frontend/src/pages/org/orgPickers.tsx`（`OrgIconPicker`、`OrgColorPicker`、`RenderIcon`）及只有它们用的 i18n key | 跨宿主「一个概念一份实现」：弹层由共享包负责 |
| 6 | 新建对话框沿用「点创建先关窗、再异步写入」的现有流程；描述、记号、颜色只有用户真的设置了才放进请求 | 桌面仓规格决策 16 |

## 身份区（控制台）

| 位置 | 名称、描述 | 记号、颜色 |
|---|---|---|
| Agent 详情 / 部门详情 | 失焦时提交，值没变不提交 | 点了立即提交，只提交那一个键（`avatar_icon` / `avatar_color` 或 `icon` / `accent_color`） |
| 新建 Agent / 新建部门 | 只改草稿，点「创建」时一起提交 | 只改草稿 |
| 项目设置 / 新建项目 | 弹窗在共享包里，随钉版一起换成统一身份区；本站只接端口 | 同左 |

- 弹层档位：Agent 是「预设（职业、模型 / 工具）· 图标 · 字母」，部门是「预设 · 图标 · 字母」。颜色行的显示规则、取消预设、搜索时预设排在前面、无障碍，全部由共享包实现，和桌面端一致。
- 名称为空等校验、失败提示、保存状态，沿用本站现有的做法和位置（`OrgDetailHeader` 的 `SaveStatus`）。
- 可及名：名称和描述输入框分别是「名称」「描述」；记号按钮是「更改头像」（Agent）或「更改图标」（部门、项目）。

## 显示

控制台所有身份记号都认预设：
- 组织索引行和组头、归属选择、会话索引：随钉版自动生效；
- 会话详情头部和转录、新对话草稿、挑选 Agent 列表、「从项目里挑」、项目设置的成员和候选行：按决策 4 改；
- 部门详情头部：按决策 3 改。

旧版本（钉版之前）的控制台认不出预设 key，按旧代码兜底显示，不会出现空白或破图。

## Out of scope

- 头像图片上传（web 没有接口）。
- `avatar_color` 在总览页、看板被当成 CSS 颜色直接使用的问题。这是既有问题，与本轮无关，另行跟踪。
- 服务端接口、校验、迁移。
- 协议新字段 `five_hour_absent` 在控制台的显示。本轮只随钉版带进来，不接线。

## Testing decisions

| 行为 | 测试位置 |
|---|---|
| 钉版：两个 npm 包和 Go `pkg/wire` 指向同一个提交，锁文件只钉一个 `agentre-wire` | 现有 `internal/pkg/wireversion/wireversion_test.go` |
| Agent / 部门详情：只有一个身份区，没有单独的名称、色板、图标网格；失焦时只提交改动的键；挑预设立即提交 `{avatar_icon:"preset:…"}` 或 `{icon:"preset:…"}`；部门头部显示预设、首字或主题色 | `frontend/src/__tests__/org-page.test.tsx` |
| 新建 Agent / 部门：有描述、记号、颜色；没设置的字段不进请求；先关窗再写入 | `org-page.test.tsx`（新建流程） |
| 会话详情头部和转录、草稿、挑选列表、「从项目里挑」、项目成员行：预设 key 画成预设图片，认不出的 key 退回首字母 | `session-detail.test.tsx`、`new-conversation.test.tsx`、`chat.test.tsx` |
| 守卫：本站不再有 `orgPickers.tsx`，图标词表和弹层来自共享包 | `shared-ui-package.test.tsx` |

运行验证：本地起 agentre-server（`make dev`），用浏览器挑预设、取消预设、新建 Agent 和部门，对照数据库写入，亮色、暗色各截一次图。跨端认 key 用同一个工作区的数据检查：桌面端挑的预设在控制台显示正确。

## Open questions

（无）
