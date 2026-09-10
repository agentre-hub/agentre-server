/**
 * 这个浏览器**亲眼看到**的轮次，按对话记着。左栏据它在镜像之上叠一层。
 *
 * 为什么需要它：控制台索引的行只有一条来路 —— server 的账号镜像。那条路要一个来回
 * （实测 2s），而且**可能整个不通**：镜像对一条 `interrupted` 的会话有意不 attach，
 * 于是收不到任何实时帧，那一行整轮都是灰的（agentred 重启后这是常态，靠 `Mirror.Revive`
 * 每分钟一档慢慢捞回来）。而正在看着这一屏的人手里有更强的事实：这一轮就是他发的。
 *
 * 桌面端早就是这么干的 —— `session-status-store` 在发送成功那一刻乐观置 running，
 * 「不依赖后端在 turn 起手时 emit session_status」。这里是同一条路子在本站的落法。
 *
 * **它只做加法**：说得出「在跑」，说不出「没在跑」。轮次一结束就把那半句收回去，
 * 让镜像重新说了算 —— 覆盖层如果反过来敢说 idle，一条被 server 判成 `failed` 的
 * 会话会被它悄悄洗白。见 `overlayLiveRow`。
 *
 * 两个事实的**寿命不一样**，这正是记成一条而不是一个布尔的理由：
 *
 *   - 「在跑」只在这一屏**盯着**它的时候成立。切走 / 关掉之后这条会话是死是活这个
 *     浏览器就不知道了，claim 必须跟着撤（`forgetLiveTurn`），否则一条在你没看的
 *     时候跑完的对话会永远绿着 —— 没有任何东西再来纠正它。
 *   - 「什么时候有过动静」是既成事实，撤不掉：消息确实是那一刻发出去的，那一行就
 *     该待在它该待的位置上。所以 `forgetLiveTurn` 只收回前一半。
 *
 * 存在内存里、不落 storage：刷新之后这一屏什么都没亲眼看到，镜像（服务端已在轮次
 * 边界前移 `last_message_at`）才是那时唯一说得出话的一方。
 */
import { useSyncExternalStore } from "react";

/** 一条对话在这个浏览器眼里此刻的样子。 */
export interface LiveTurn {
  /** 这一轮**此刻**在跑吗。只有还盯着它的时候才为真，见文件头。 */
  running: boolean;
  /** 看到这件事的时刻（Unix 毫秒）。行的时间与排序据它前移。 */
  at: number;
}

/**
 * 快照按引用比。写的时候整份换掉，不就地改 —— `useSyncExternalStore` 拿它判
 * 「变了没有」，就地改会让订阅者一次都不醒。
 */
let snapshot: ReadonlyMap<string, LiveTurn> = new Map();
const listeners = new Set<() => void>();

function publish(next: ReadonlyMap<string, LiveTurn>): void {
  snapshot = next;
  for (const notify of [...listeners]) notify();
}

/**
 * 亲眼看着这条对话的一轮**开起来或收场了**。发送成功、回声、开轮帧、自主续轮都走
 * 这里（详情视图的 `markTurnActive` 旁边就是它）。
 *
 * `running: false` 同样是一件发生过的事：这一轮刚收场，回复就是那一刻落下的，所以
 * 时间跟着往前。
 *
 * **没变过就不出声**，两种情形都落在这一档，而且都不是无谓的优化：
 *
 *   - 同一轮里这句话会被喊好几遍（run 的应答、daemon 扇回来的回声、开轮帧各一次）。
 *     每次都重记，时间会在一轮里反复往前跳。
 *   - 「此前没说过它在跑，现在说它没在跑」压根不是一件发生过的事 —— attach 那一刻
 *     的清单快照、以及补齐回放里的每一个终态帧都长这样。记下来就等于**点开一条
 *     对话就把它顶到列表最前面并标成未读**（联调机上实测到的那一版就是这样）。
 */
export function noteLiveTurn(conversationId: string, running: boolean): void {
  if (!conversationId) return;
  const prev = snapshot.get(conversationId);
  if (prev ? prev.running === running : !running) return;
  const next = new Map(snapshot);
  next.set(conversationId, { running, at: Date.now() });
  publish(next);
}

/**
 * attach 那一刻的清单快照。它说得出「此刻在不在跑」，说不出「刚发生了什么」——
 * 一条已经跑了十分钟的对话，你现在才打开它，那不是一次新的活动。
 *
 * 所以它只立**在跑**那半句，时间一格不动（`at: 0` = 这一屏没有时间可说，
 * `overlayLiveRow` 取大者时它自然让位给镜像）。这条分界与 `useLiveTurnTiming`
 * 的 `noteAttachedTurn` 是同一条：接进来时对端已经在跑的那一轮，起点观察不到。
 */
export function seedLiveTurn(conversationId: string, running: boolean): void {
  if (!conversationId) return;
  const prev = snapshot.get(conversationId);
  if (prev ? prev.running === running : !running) return;
  const next = new Map(snapshot);
  next.set(conversationId, { running, at: prev?.at ?? 0 });
  publish(next);
}

/**
 * 不再盯着这条对话了（详情卸载 / 右栏换了一条）。
 *
 * 只收回「在跑」那一半：它此后没有任何来路，留着就是一颗永远不会灭的绿点。时间那
 * 一半是既成事实，留着 —— 也正因为留着，切走之后那一行仍待在最上面。
 *
 * 从没记过的那些一个字都不写：凭空造一条 `{running:false, at:now}` 等于把一条几天
 * 没动过的对话顶到列表最前面。
 */
export function forgetLiveTurn(conversationId: string): void {
  const prev = snapshot.get(conversationId);
  if (!prev || !prev.running) return;
  const next = new Map(snapshot);
  next.set(conversationId, { ...prev, running: false });
  publish(next);
}

/** 测试隔离用。生产代码不该调。 */
export function resetLiveTurns(): void {
  publish(new Map());
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

function getSnapshot(): ReadonlyMap<string, LiveTurn> {
  return snapshot;
}

/**
 * 此刻这份亲眼所见。
 *
 * 走 `useSyncExternalStore` 而不是「effect 里订阅 + setState」，与
 * `useAccountChannelState` 同一条理由：这一屏挂上来之前多半已经有人写过了，自己订阅
 * 就得在 effect 里补一次当下的值，而那正是本仓 lint 禁掉的同步 setState。
 */
export function useLiveTurns(): ReadonlyMap<string, LiveTurn> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
