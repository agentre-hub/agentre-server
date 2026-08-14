/**
 * 这个浏览器自己的派发顺序（决策 7 / 9 / 10 / 11）。
 *
 * 顺序的持有者是**设备**（这台浏览器），被排序的是 backend：排列以 backend
 * sync_id 数组表达，因为 rank 是位置性的（重排即变）、device_id 也不唯一
 * （一台机器可以挂多个 backend）。同一账号换一个浏览器就是另一台设备、另一份顺序。
 *
 * 排列交给服务端解析，浏览器不自行挑档：服务端按调用方设备的排列重排执行目标链
 * 后再走既有的「跳过本机相对引用、取第一个可用」循环，因此「当前」标记与真实
 * 派发目标始终是同一档。
 */
import { api } from "@/lib/api";
import {
  ensureWebDevice,
  getFingerprint,
  isWebDeviceRevoked,
} from "@/lib/webDevice";

/** 排序只需要一档上的这两个字段（ISP：不依赖整个 ExecTargetItem）。 */
export interface OrderableTier {
  /** 跨机稳定且逐档唯一的标识，是排列唯一能用的锚点。 */
  backend_sync_id?: string;
  availability: string;
}

/**
 * 这一档能不能被这台浏览器排序。
 *
 * skipped_for_web 是 device_id 为空的「本机」相对引用：在浏览器语境下它永远没有
 * 指代对象、永远不可派发，给它一个可排的位置纯是噪音（决策 11）——它照常显示，
 * 只是不可移动。没有 backend sync_id 的档同理：排列以 sync_id 表达，无从指代的
 * 一档说不出「排第几」（服务端也只收非空标识）。
 */
export function isMovableTier(tier: OrderableTier): boolean {
  return tier.availability !== "skipped_for_web" && !!tier.backend_sync_id;
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

/**
 * 这台浏览器**已有的**设备指纹；还没注册过 / 已被解除授权时是 null。
 *
 * 这是一次纯本地读，不发请求、更不注册：读一份偏好不该有建出一台设备行的副作用。
 * 总览页是纯读页，打开它就在账号的设备列表里多一台机器，是用户没要求过的后果
 * （e2e 的「真实空态」正是守这条）。注册留给写路径 —— 用户真排了一次序，这台
 * 浏览器才需要成为一台有身份的设备。
 *
 * 读的是 localStorage 里的指纹而不是 sessionStorage 里的设备 JWT：token 随标签页
 * 会话失效，设备身份和它排的顺序不随之消失，重开标签页仍按自己的顺序读。
 *
 * 读路径（取链、取派发计划）取不到就回落账号顺序、不报错 —— 派发不该因为一个偏好
 * 读不到就失败。指纹在服务端解析不到活跃设备时同样回落（决策 9 的读侧）。
 */
export function callerDeviceFingerprint(): string | null {
  // 已解除授权的指纹服务端必拒，带上去只会换来一次注定失败的解析。
  if (isWebDeviceRevoked()) return null;
  return getFingerprint();
}

export interface SaveExecTargetOrderInput {
  agentSyncId: string;
  backendSyncIds: string[];
}

/**
 * 保存「这台浏览器把某个 Agent 的执行目标排成这个次序」，返回落库用的设备指纹。
 *
 * 顺序的持有者是设备，所以这里先确保这台浏览器**有**设备身份：第一次排序即注册
 * （已注册则直接复用，按指纹幂等、不新增设备行）。注册放在写路径而不是读路径，
 * 是因为只有到这一步用户才真的表达了「我要这台浏览器有自己的顺序」。
 *
 * 失败照常抛出，由界面就地说明 —— 顺序存不下时不得只在控制台留一行日志。已被
 * 解除授权时 ensureWebDevice 抛 WebDeviceRevokedError，同样交给界面表达。
 */
export async function saveExecTargetOrder(
  input: SaveExecTargetOrderInput,
): Promise<string> {
  const { fingerprint } = await ensureWebDevice();
  await api("/v1/workspace/exec-target-order", {
    method: "POST",
    body: JSON.stringify({
      device_fingerprint: fingerprint,
      agent_sync_id: input.agentSyncId,
      backend_sync_ids: input.backendSyncIds,
    }),
  });
  return fingerprint;
}
