# 2026-11 控制台接入共享包 UI/UX 打磨

> Status: Approved
> Owner: agentre-server 维护者
> Last updated: 2026-11-06

**Objective:** 把 `@agentre-hub/agentre-ui`（及同版本的 `@agentre-hub/agentre-wire`）的钉从 agentre `4a759e83` 抬到 `6bde33a8`（agentre PR #86 合并提交 `70e53804` 之上、把 `countPendingBelow` 搬进共享包的那个 main 提交），让控制台拿到 2026-11-05 UI/UX 打磨里共享包的改动，并在控制台宿主接上需要宿主提供数据/回调的新能力，使控制台与桌面端的对话体验一致。桌面端规格见 agentre `docs/specs/2026-11-05-ux-polish.md`（C1–C8、S1–S6），本文件只写控制台侧的需求与决策。叠在 `ux/2026-11-05-ux-polish` 分支（PR #36）上一起发布。

**Hard invariants:**
- `pkg/wire` / `pkg/syncwire` 的 Go 钉跟着前端钉一起抬到同一提交 `6bde33a8`（`internal/pkg/wireversion` 守卫要求 Go `pkg/wire` 与 TS `agentre-wire` 同一 commit；`4a759e83..6bde33a8` 之间二者只有 README/注释改动），不改协议版本，不加迁移。
- 控制台只改宿主与测试；共享包的改动按跨仓顺序先在 agentre 落地合并（本轮 agentre 只做 A4 需要的计数规则抽取）。
- 不加解释性状态 banner；界面不贴机器原话；文案走 i18n，zh-CN 与 en 同步。
- 每条行为改动先写失败测试（TDD）；抬钉导致的既有断言失败，只改断言到新的共享包行为，不回退共享包行为。

## Requirements

**A1 抬钉**
- `frontend/package.json` 的 `@agentre-hub/agentre-ui` 与 `@agentre-hub/agentre-wire` 两根钉直接改到 agentre main `6bde33a8`（#86 合并提交 `70e53804` 之上、把 `countPendingBelow` 搬进共享包的那个提交），`pnpm install` 更新 lockfile。
- 因共享包行为变化而失败的控制台单测 / e2e 断言更新到新行为（失败卡事实句 + 折叠详情、审批卡默认展开与按钮文案、重试指示行、去掉常驻快捷键提示等），不改共享包。
- 验收：`make test`、`make lint`、`make e2e` 全绿；W5b（剪贴板写入被拒时「复制诊断信息」不贴浏览器原话）在真实控制台成立。

**A2 停止进入输入框提交位（对应桌面 C2）**
- 控制台会话页给共享 `ChatComposer` 传 `running` / `onStop` / `stopping`：运行中草稿为空时提交位是停止键，有草稿时停止与发送并排；焦点在空输入框按 Esc 停止；点下后停止中禁用直到回合结束。控制台现有的停止入口（若有）共用同一 stopping 态。
- 停止走控制台现有的中断通道（`runtimeAbort`），不新增后端接口；停止中状态从头部抽到共享的宿主 hook，持续到回合结束而不是请求返回。
- 决策：运行时能力明确报告不支持 abort 时不显示停止键；能力未知或获取失败时维持今天的行为（显示）。

**A3 失败卡出口（对应桌面 C3）**
- 控制台给转录上下文传 `backendType`（登录过期时出对应 CLI 的登录命令卡）。
- 决策：控制台没有「重新生成这一轮」的 RPC（`runtimeRun` 只会追加新一轮），本轮不传 `onRetryTurn` / `onRerun`，失败卡按共享包回退只给事实句 + 详情；不用「再发一遍同样文本」冒充重试。

**A4 回到底部药丸「N 项待处理」（对应桌面 C4）**
- 控制台给 `TranscriptJumpControl` 传 `pendingBelow`：视口下方未决的审批/提问块数。
- 决策：计数规则只能有一份实现。已在 agentre main `6bde33a8` 把桌面宿主的 `countPendingBelow` 原样搬进 `@agentre-hub/agentre-ui`（导出 `countPendingBelow(messages, bottomVisibleId)` 与 `pendingDecisionId`，桌面改用它）；控制台直接调用它，不另写一份。

**A5 组织架构缺口标记（对应桌面 S2）**
- 控制台组织架构索引里不能对话的 Agent 行，给共享 `OrgAgentRow` 传 gap（6px 待配置点 + 可读名带原因）；索引筛选提供「待配置」（共享 `OrgIndexFilters` 的可选字段）。
- 判定「不能对话」用控制台已有的数据；如果控制台拿不到等价的不可对话原因，本条降级为只做筛选或不做，并在计划阶段报告，不新增后端接口。

## Out of scope
- 桌面端独有的宿主改动（tab 次序、通知 toast、状态栏、看板撤销、合并预览、快捷键 tooltip 等）。
- 新的后端接口或协议变更。
- 控制台成功页步骤条只读模式（需改共享包）。
