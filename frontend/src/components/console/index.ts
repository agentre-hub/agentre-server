/**
 * 共享控制台视觉基础（task 1）：从正式 Pencil 组件提炼的、被多页面重复
 * 消费的最小原语集。页面只能组合这些组件，不得复制其尺寸/状态颜色/字阶/
 * 交互语义，也不得修改本目录。
 *
 * 对应画板节点：ConsoleNavItem=ZC7pI、MobileTabBar=A6Z3k、
 * StatusMark=zF5jv、FilterChip=rNQXR、Metric=IhldU 统计卡、
 * EmptyState=正式空态画板。行级菜单已归共享包的 DropdownMenu（规格 2026-08-22 E 段）。
 */
export { ConsoleNavItem } from "./ConsoleNavItem";
export { EmptyState } from "./EmptyState";
export { FilterChip } from "./FilterChip";
export { Metric } from "./Metric";
export { MobileTabBar, type MobileTab } from "./MobileTabBar";
export { StatusMark, type StatusTone } from "./StatusMark";
