/**
 * 移动端底部避让的共享表达式（规格 2026-11-05 W7）。
 *
 * 底栏（MobileTabBar）是 74px 的正常流元素，贴在视口底边；凡是要浮在它之上的
 * 东西（FAB、toast）都从这里取同一个让开量，不再各写一个魔法数。
 *
 * Tailwind 只抽取字面 class，所以这里给的是运行时值：调用方用 inline style /
 * 组件 prop 消费，不要拼成 class 字符串。
 */

/** 底栏整体高度：内容 74px + 安全区。 */
export const MOBILE_TAB_BAR_HEIGHT =
  "calc(74px + env(safe-area-inset-bottom, 0px))";

/** 浮在底栏之上的让开量：底栏高度 + 16px 呼吸空间。 */
export const MOBILE_TAB_BAR_CLEARANCE =
  "calc(74px + 16px + env(safe-area-inset-bottom, 0px))";
