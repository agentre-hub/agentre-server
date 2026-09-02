/**
 * 「这个后端支不支持会话级思考力度」——问执行端本人，不在这一侧按后端类型猜。
 *
 * 读的是 `runtime.capabilities` 应答的**另一格**：`permission_mode` 之外还有一串
 * `CapabilityEntry`（`{name, enabled}`，Go 侧那张 `Capabilities.Set` 映射逐条铺开，
 * 所以 `enabled: false` 的条目**也在**里面 —— 只认名字会把 openclaw 判成支持）。
 *
 * 解不动（对端太老、形状不对、这一问失败）时按「不支持」处置，与档位那一侧的三态
 * 不同：档位空着要说一句「这台机器此刻列不出档位」，而力度控件本来就有「后端不支持
 * 就整颗不渲染」这条既定处置（规格 2026-09-01 决策 6），此刻多摆一句说明只是在说
 * 一个用户改不了的事实。
 */
export const REASONING_EFFORT_CAPABILITY = "reasoning_effort";

export function decodeReasoningEffortSupport(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const list = (raw as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(list)) return false;
  return list.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const item = entry as { name?: unknown; enabled?: unknown };
    return item.name === REASONING_EFFORT_CAPABILITY && item.enabled === true;
  });
}
