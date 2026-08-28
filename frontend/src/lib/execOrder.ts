/**
 * 执行目标的派发顺序（决策 10 / 11 / 14）。
 *
 * **浏览器排的就是账号默认顺序**：没有「这个浏览器自己那一份」，改的是同步组里
 * agent_exec_target 的 sort_order。浏览器之间没有任何物理差异能证成不同的顺序 ——
 * 桌面端每台排序不同是在表达「我这台机器上有本机档」这个硬事实，而浏览器永远跳过
 * 本机相对引用，任何浏览器面对的都是同一个候选集。
 *
 * 被排序的是 backend，排列以 backend sync_id 数组表达：rank 是位置性的（重排即变）、
 * device_id 也不唯一（一台机器可以挂多个 backend）。
 *
 * 排列交给服务端落库，浏览器不自行挑档：服务端改完 sort_order 后照旧走「跳过本机
 * 相对引用、取第一个可用」的循环，因此「当前」标记与真实派发目标始终是同一档。
 */
import { api } from "@/lib/api";

/** 排序只需要一档上的这两个字段（ISP：不依赖整个 ExecTargetItem）。 */
export interface OrderableTier {
  /** 跨机稳定且逐档唯一的标识，是排列唯一能用的锚点。 */
  backend_sync_id?: string;
  availability: string;
}

/**
 * 这一档能不能被这台浏览器排序。
 *
 * no_device 是后端行没写运行设备（agentred_fingerprint 为空）的「未指定设备」档
 * （规格 2026-08-21 决策 14）：在浏览器语境下它永远没有指代对象、永远不可派发，
 * 给它一个可排的位置纯是噪音（决策 11）——它照常显示，只是不可移动。没有
 * backend sync_id 的档同理：排列以 sync_id 表达，无从指代的一档说不出「排第几」
 * （服务端也只收非空标识，并把它钉在原位）。
 */
export function isMovableTier(tier: OrderableTier): boolean {
  return tier.availability !== "no_device" && !!tier.backend_sync_id;
}

/**
 * 把第 index 档往前（-1）/ 往后（+1）挪一位，返回要提交的 backend sync_id 排列；
 * 这一档不可移动、或它已经是第一个 / 最后一个可移动的档时返回 null —— 调用方据此
 * 禁用按钮，而不是发一次什么都不改的提交。
 *
 * 换位只发生在两个**可移动**的档之间，不可移动的档钉在原位：用户挪一台机器时，
 * 不会顺手把「本机」那一档也挪走。
 */
export function reorderTargets(
  tiers: OrderableTier[],
  index: number,
  direction: -1 | 1,
): string[] | null {
  const movable = tiers.map((_, i) => i).filter((i) => isMovableTier(tiers[i]));
  const pos = movable.indexOf(index);
  if (pos < 0) return null;
  const swapPos = pos + direction;
  if (swapPos < 0 || swapPos >= movable.length) return null;

  const next = [...tiers];
  next[movable[pos]] = tiers[movable[swapPos]];
  next[movable[swapPos]] = tiers[movable[pos]];
  return next
    .map((tier) => tier.backend_sync_id ?? "")
    .filter((syncID) => syncID !== "");
}

export interface SaveExecTargetOrderInput {
  agentSyncId: string;
  backendSyncIds: string[];
}

/**
 * 把某个 Agent 的执行目标排成这个次序 —— 写的是账号默认顺序，因此从未调整过的
 * 桌面端会跟着变（那是账号默认的定义，不是副作用），已经拖过一次的桌面端有本端
 * 覆盖、不受影响。
 */
export async function saveExecTargetOrder(
  input: SaveExecTargetOrderInput,
): Promise<void> {
  await api("/v1/workspace/exec-target-order", {
    method: "POST",
    body: JSON.stringify({
      agent_sync_id: input.agentSyncId,
      backend_sync_ids: input.backendSyncIds,
    }),
  });
}
