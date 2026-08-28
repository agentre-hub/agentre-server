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
let channel: AccountChannelHandle | null = null;

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

function subscribe(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  if (channel === null) {
    try {
      channel = startAccountChannel({ onRefresh: fanOut });
    } catch {
      // 通道本来就允许不在：这一次没起来，下一个订阅者进来时再试。
      channel = null;
    }
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      channel?.stop();
      channel = null;
    }
  };
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
