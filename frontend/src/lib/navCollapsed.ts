/**
 * 桌面侧栏「收起 / 展开」的本机偏好。
 *
 * 与「最近用过的 Agent」同一类东西（见 recentAgents.ts）：这是一个人在这台机器上
 * 怎么用这块屏，不是账号数据。存进账号要加字段、加迁移、加写入端点，还要想清楚
 * 两台机器分辨率不同时以谁为准——为一条侧栏付这个代价不值。
 *
 * 读写都吞掉 localStorage 的异常（隐私模式、配额满）：记不住最多是下次进来又
 * 是展开的，绝不该让整个控制台外壳崩掉。
 */
export const NAV_COLLAPSED_KEY = "agentre.console.navCollapsed";

/** 读不到 / 读坏了都按「展开」算：那是不需要先学会一个按钮的那一侧。 */
export function readNavCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNavCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 静默：记不住不是错误，下次展开就是了。
  }
}
