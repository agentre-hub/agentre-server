/**
 * 把账号级实时通道挂在一个组件的生命周期上，并且**一个标签页只开一条**。
 *
 * 通道只负责说「该拉了」，拉什么由 onRefresh 自己决定 —— 每个页面照旧拥有自己的
 * 取数路径，**首次加载不经过这里**。判据仍是通道那条：把它整个关掉，所有页面仍然
 * 正确，只是变慢到兜底轮询的 30 秒（见 `@/lib/accountChannel`）。
 *
 * 共用一条而不是各开各的：外壳（侧栏在线数）与页面同时在场，各开一条就是一个标签页
 * 好几条 websocket，而 server 那边**一条连接就是一份 Redis 订阅**
 * （accountchan_svc.Subscribe 的注释）。所以这里持一条共用的通道 + 一份订阅者名单，
 * 收到信号按订阅者自己的种类名单分发。
 *
 * 第二个出口是这条通道**自己**的状态（`useAccountChannelState`）：侧栏那盏灯据它
 * 回答「我现在看到的东西是不是实时的」。它与「该拉了」分成两份订阅者名单，但共用
 * 同一条通道，也共同决定它的存活。
 *
 * 另外三条各写一遍就会各漏一条的规矩也在这里：
 *
 *  - 回调经 ref 转发。页面传进来的多半是每次渲染新建的闭包，直接进依赖数组的话
 *    每渲染一次就退订重订一次。
 *  - 种类按内容比，不按引用比。页面写的是字面量数组，每次渲染都是新引用。
 *  - 起不来不抛给页面。票据取不到、WebSocket 构造抛出这些极端情况下，少的只是
 *    一次「早知道该拉了」，不该连累已经在途的首次加载。
 */
import * as React from "react";

import {
  startAccountChannel,
  type AccountChannelHandle,
  type AccountChannelState,
} from "@/lib/accountChannel";

interface Subscriber {
  /**
   * 这个订阅者认的种类。null 那一路（建连/重连/轮询）不看它。
   *
   * 就地改，不换订阅者：种类变了只是换一份名单，退订再重订会让名单里最后一个
   * 订阅者短暂归零，把整条共用通道拆掉重建。
   */
  types: ReadonlySet<string>;
  refresh: () => void;
}

const subscribers = new Set<Subscriber>();

/**
 * 只看灯的那一份名单（`useAccountChannelState`）。与上面那份分开：它们要的是两件
 * 事——一个是「去把数据读回来」，一个是「你看到的东西还是不是实时的」。混在一起
 * 的话，点灯的组件会被每一条信号喊醒去重拉一遍它根本没有的数据。
 *
 * 但**通道的存活按两份名单合起来算**：外壳上只剩一盏灯的时候把通道停掉，灯就再
 * 也不会变了，而它正指着「已连接」。
 */
const stateSubscribers = new Set<(state: AccountChannelState) => void>();
let channel: AccountChannelHandle | null = null;
let channelState: AccountChannelState = "connecting";

/**
 * 分发一次「该拉了」。
 *
 * `signalType === null` 是建连、重连与兜底轮询那一路：它们不知道落后的是哪一类，
 * 所以喊醒所有人 —— 按某一类去分发会漏掉别的。
 */
function fanOut(signalType: string | null): void {
  // 复制一份再遍历：某个订阅者的 refresh 触发 setState，可能同步卸载掉别的订阅者。
  for (const subscriber of [...subscribers]) {
    // 判据写成「拿到了一个种类，而它不在我的名单里」而不是「不为 null」：说不出
    // 种类的调用（null、以及漏传的 undefined）意思都是「你可能落后了」，那时喊醒
    // 所有人才是安全的一侧——漏喊会让页面停在旧数据上，多喊只是多读一次。
    if (typeof signalType === "string" && !subscriber.types.has(signalType)) {
      continue;
    }
    subscriber.refresh();
  }
}

function fanOutState(state: AccountChannelState): void {
  channelState = state;
  for (const notify of [...stateSubscribers]) notify(state);
}

function ensureChannel(): void {
  if (channel !== null) return;
  try {
    channel = startAccountChannel({ onRefresh: fanOut, onState: fanOutState });
  } catch {
    // 通道本来就允许不在：这一次没起来，下一个订阅者进来时再试。
    channel = null;
    // 但灯不能停在「连接中」：没有通道就没有人再说话，那个读数会一直挂着，而
    // 「未连接」才是唯一带着出路的那一态。
    fanOutState("disconnected");
  }
}

/** 两份名单都空了才收摊。 */
function releaseChannel(): void {
  if (subscribers.size > 0 || stateSubscribers.size > 0) return;
  channel?.stop();
  channel = null;
  channelState = "connecting";
}

function subscribe(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  ensureChannel();
  return () => {
    subscribers.delete(subscriber);
    releaseChannel();
  };
}

/** 灯的那一路订阅，交回退订。`useSyncExternalStore` 的第一个参数。 */
function subscribeState(notify: () => void): () => void {
  stateSubscribers.add(notify);
  ensureChannel();
  return () => {
    stateSubscribers.delete(notify);
    releaseChannel();
  };
}

/**
 * 从头再开一条通道。
 *
 * 出路只有这一条：走到 `disconnected` 说明池子连**建**都没建起来（票取不到 /
 * WebSocket 构造抛），它已经把连接置回 null 且不会自己重来。停掉旧的再起一条，
 * 于是 `subscribeSignals` 会重新走一遍 `ensureConnection`——重取票、重拨。
 *
 * 当场把读数退回「连接中」：留在「未连接」上的话，用户按下去什么都不会动，
 * 那颗按钮看起来就是坏的。
 */
export function retryAccountChannel(): void {
  channel?.stop();
  channel = null;
  fanOutState("connecting");
  ensureChannel();
}

export function useAccountChannel(
  signalTypes: readonly string[],
  onRefresh: () => void,
): void {
  const refreshRef = React.useRef(onRefresh);
  React.useEffect(() => {
    refreshRef.current = onRefresh;
  });

  // 种类的身份取自内容：页面传的是字面量数组，不这么做每次渲染都是新引用。
  const types = signalTypes.join(",");

  // 订阅者的身份是**这个组件**，不是它此刻认的那份名单。
  const subscriberRef = React.useRef<Subscriber | null>(null);
  subscriberRef.current ??= {
    types: new Set(types.split(",")),
    refresh: () => refreshRef.current(),
  };
  React.useEffect(() => {
    subscriberRef.current!.types = new Set(types.split(","));
  }, [types]);

  React.useEffect(() => subscribe(subscriberRef.current!), []);
}

/**
 * 那条共用连接此刻的状态。挂上它的组件本身也是一个使用方：只有灯的页面照样能把
 * 通道拉起来。
 *
 * 走 `useSyncExternalStore` 而不是「effect 里订阅 + setState」：状态是**事件**，
 * 而这条通道多半在这个组件挂上来之前就已经连上了（外壳先挂、灯后挂）。自己订阅
 * 的话，得在 effect 里补一次当下的值才不会永远停在初值，而那正是 effect 里禁止
 * 的同步 setState。这个 hook 的 getSnapshot 直接读那个模块级读数，两个问题一起没了。
 */
export function useAccountChannelState(): AccountChannelState {
  return React.useSyncExternalStore(subscribeState, () => channelState);
}
