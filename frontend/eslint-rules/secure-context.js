/**
 * 安全上下文守卫的规则数据。
 *
 * 本站是用 http 部署的（如 `http://coding.local:8443`），那是**非安全上下文**。
 * `crypto.randomUUID` 在规范里带 `[SecureContext]`，在那里根本不存在：调用不是返回
 * 空值，而是直接 `TypeError: crypto.randomUUID is not a function`。
 *
 * 2026-08-30 它抛在派发逻辑里（Pi 的这一代身份），既不是 DispatchRunError 也不是
 * DispatchConnectionError，草稿页于是落到兜底那一支，对着一台明明连得上的机器说
 * 「连不上 coding，请重试」，而一帧中继都没发出去。同样的调用当时还在插话的
 * queuedId 与失败气泡的行标识上。
 *
 * 与设计 token、原生控件那两组共用同一条 `no-restricted-syntax`：规则数据单独成模块，
 * 守卫测试与 eslint.config.js 消费同一份来源（见 src/__tests__/eslint-guardrails.test.ts
 * 的 secure context guardrail 一节）。
 *
 * **豁免只有一处**：`src/lib/randomId.ts` —— 退化实现自己得调得动它，由 eslint.config.js
 * 按文件名开。
 *
 * 与 design-tokens.js / native-controls.js 不同，这一条**不往桌面端镜**：Wails 的
 * webview 跑在 `wails://` / `http://wails.localhost` 上，那是安全上下文，那边没有
 * 这个问题。这是本站作为 http 部署的宿主自己的约束。
 */

const secureContextSyntax = [
  {
    selector: 'CallExpression[callee.property.name="randomUUID"]',
    message:
      "禁止直接调 crypto.randomUUID：它带 [SecureContext]，本站的 http 部署上不存在，" +
      "调用会抛 TypeError。改用 @/lib/randomId 的 randomId()，它退到没有这层门槛的" +
      " crypto.getRandomValues。",
  },
];

export { secureContextSyntax };
