/**
 * 会话索引轴清单（宿主持有的那一半）。
 *
 * 轴投影纯函数 `buildAxisGroups` 与组的形状契约（`IndexGroup` / `IndexGroupRow` /
 * `GroupKind` / `AxisInput` / `IndexRow` 等）已迁入共享包 `@agentre-hub/agentre-ui`
 * （规格 2026-08-18「共享包承载什么」）：组怎么分、怎么排、兜底组摆在哪，两端只该
 * 有一份答案，调用方改从包里直接 import。
 *
 * **可选轴清单没有跟着搬**（决策 17）：桌面端今天只 offer 项目 / Agent / 时间三档，
 * server 控制台四档全给——这一条各端自己说了算，因此仍是宿主自己的一份，留在这里。
 */
import type { IndexAxis } from "@agentre-hub/agentre-ui";

export type {
  IndexAxis,
  IndexRow,
  MachineInfo,
  ProjectNode,
} from "@agentre-hub/agentre-ui";

/**
 * 四个轴，按选择器里摆的顺序。**只有这一份**：宿主要拿它校验 URL 上的 `?axis=`，
 * 选择器要拿它摆选项，两边各写一遍就会漂——多出来的那个轴写得进地址栏却选不着，
 * 或者选得着却被宿主当非法值悄悄退回默认轴。
 */
export const INDEX_AXES: IndexAxis[] = ["project", "agent", "time", "machine"];
