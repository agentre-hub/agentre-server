import { rpcMethods, type AnyRpcMethod } from "@agentre-hub/agentre-wire";
import { useEffect, useRef, type RefObject } from "react";

import {
  consumedSteerRefs,
  type SteerQueue,
} from "@/components/session/useSteerQueue";
import type { RelayClient } from "@/lib/relayClient";

/** 承载机那一行里这只 hook 唯一要读的那一格。 */
export type SessionCarrier = { kind?: string } | null | undefined;

export interface SteerAutoContinueParams {
  /**
   * 「又有一轮正常收场了」的计数。终态帧那一处 +1，0 = 这一屏还没见过。
   *
   * 不直接收终态帧：这只 hook 排在发送那一族**之后**（它要 `sendMessage`），而中继
   * 的回调排在最前面。计数是这两头唯一能握手的东西。
   *
   * 只增不减，且**不随会话重置** —— 换会话那一档由下面 `handled` 那一对认出来。
   */
  epoch: number;
  conversationId: string;
  /**
   * 承载这条对话的那台机器（`useSessionTargetDevice` 交出来的那一行）。
   *
   * 只认 agentred，理由见 `drainPendingSteers`。还没问出来时是空。
   */
  carrier: SessionCarrier;
  clientRef: RefObject<RelayClient | null>;
  originRef: RefObject<string | undefined>;
  steerQueue: SteerQueue;
  /** 开新一轮。就是详情视图手上那只 `useSessionSend().sendMessage`。 */
  sendMessage: (text: string) => Promise<void>;
}

/**
 * 只在承载机是 **agentred** 时才交出这条连接，否则交出 null。
 *
 * 判据写成一句 `kind === "agentred"`，不是为了好看：`desktop-answered-methods` 那道
 * 守卫按它核实「这条路真的限死在 agentred 上」（AGENTRED_ONLY_CALLERS 的 `via`）。
 * 放宽成别的判据、或者多出第二个使用方，那道守卫会立刻红。
 */
function agentredCarrier(
  carrier: SessionCarrier,
  client: RelayClient | null,
): RelayClient | null {
  const hostedByAgentred = !!carrier && carrier.kind === "agentred";
  if (!hostedByAgentred) return null;
  return client;
}

/**
 * 问承载机「这条对话的插话信箱里还剩什么」，顺手取走。答不出时交出 null。
 *
 * **只问 agentred**，两头的理由都成立：
 *
 *   - 桌面端根本不注册这个方法（共享包 `desktopAnsweredMethods` 里没有
 *     `runtimeDrainPending`），问过去只会被拒；
 *   - 更要紧的是它**不该被问** —— 桌面端托管的那条对话由它自己的 `chat_svc` 在轮末
 *     `DrainPending` 并自动接续（`turn_run.go`），控制台再去取一次就是从它手里抢走
 *     它马上要用的东西。这条路要补的正是 agentred 少的那一段。
 */
async function drainPendingSteers(
  method: AnyRpcMethod,
  carrier: SessionCarrier,
  client: RelayClient | null,
  params: object,
) {
  const target = agentredCarrier(carrier, client);
  if (!target) return null;
  return consumedSteerRefs(await target.request(method, params as never));
}

/**
 * 一轮收场之后：问执行端「插话信箱里还剩什么」，剩下的自动接续成新一轮。
 *
 * ## 为什么必须问
 *
 * agentred 的插话信箱按 claude 会话 UUID 存，**只在 CLI 会话被逐出时才清空**
 * （claudecode 的 `claudeActive.Close` 里那一句 `Forget`）。控制台此前在终态帧那
 * 一刻就把没被取走的那几条挪进丢弃横幅，却从没告诉执行端 —— 那段字仍然攥在它手
 * 里，下一轮一开，第一个 PostToolUse 钩子就把它捞出来凭空插进去。用户眼里是一段
 * 明明被告知「没发出去」的字，过一会儿自己长了腿跑进了另一轮。
 *
 * 就算这一屏自己的队列是空的也照问：信箱是按**会话**的，排进去的那一屏可能已经
 * 关掉了，而幽灵不会因为没人看着就消失。
 *
 * ## 为什么接续而不是交还
 *
 * 桌面端一直是接续的：`chat_svc` 在轮末 `DrainPending`，取到就合并成一条用户消息
 * 自动跑下一轮（`persistAutoContinueTurn`）。同一条对话换个端打开就换一套脾气，
 * 是比两种脾气各自的缺点都更糟的那一类。合并口径也照它：多条之间空一行
 * （`joinSteerTexts`）。
 *
 * 取不回来才是真的没人要了 —— 那时才摆丢弃横幅，把原文交还给用户。
 *
 * ## 三种收场里只管一种
 *
 * 出错与用户中断都不问、也不接续，判据与桌面端同一条
 * （`turn_run.go` 的 `stopErr == nil && !aborted`）：出错的一轮自动再跑一遍多半是
 * 再错一次；而按下停止那一刻 daemon 的 `Abort` 已经把信箱清空了，接续等于把刚叫停
 * 的事又捡起来。所以「这一轮算不算正常收场」由点火的那一处判，这里只认计数。
 */
export function useSteerAutoContinue({
  epoch,
  conversationId,
  carrier,
  clientRef,
  originRef,
  steerQueue,
  sendMessage,
}: SteerAutoContinueParams): void {
  /*
    下面那条 effect 只认 `epoch` 与会话身份：其余四样每次渲染都是新的身份，进依赖表
    就等于每渲染一次接续一次。存进 ref、在 effect 里写（渲染期读写 ref 是被禁的）。
  */
  const latest = useRef({
    carrier,
    clientRef,
    originRef,
    steerQueue,
    sendMessage,
  });
  useEffect(() => {
    latest.current = { carrier, clientRef, originRef, steerQueue, sendMessage };
  });

  /*
    上一次处理过的那一对。右栏换对话是**同实例换 props**（没有 key 强制重挂），而
    计数只增不减 —— 只看计数的话，切过去的那一瞬就会对一条根本没跑过的对话问一次
    信箱，取到东西还会凭空给它开一轮。所以要的是「**这一条**对话上的计数又涨了」，
    不是「依赖表变了」。
  */
  const handled = useRef({ epoch, conversationId });

  useEffect(() => {
    const previous = handled.current;
    handled.current = { epoch, conversationId };
    if (previous.conversationId !== conversationId) return;
    if (epoch <= previous.epoch) return;
    const {
      carrier: host,
      steerQueue: queue,
      sendMessage: send,
    } = latest.current;
    const client = latest.current.clientRef.current;
    const peerFingerprint = latest.current.originRef.current;
    /*
      目标换了（右栏切到别的对话 / 整屏卸下）就此作罢：换会话会把整份队列重置，
      而这一问的答案属于上一条对话——拿它去开一轮会开在错的那条上。
    */
    let stale = false;
    void (async () => {
      let drained;
      try {
        drained = await drainPendingSteers(
          rpcMethods.runtimeDrainPending,
          host,
          client,
          {
            conversationId,
            ...(peerFingerprint ? { peerFingerprint } : {}),
          },
        );
      } catch {
        // 问失败了：不知道执行端手上还有没有，按「没取回来」收场。这一档宁可多摆
        // 一次横幅，也不能静默把用户敲的字弄丢。
        if (!stale) queue.endTurn();
        return;
      }
      if (stale) return;
      // 这条路上问不出话（承载机不是 agentred、或连接已经没了）：那几条的去向不归
      // 这里管，照旧当场交还给用户。
      if (!drained) {
        queue.endTurn();
        return;
      }
      const text = drained
        .map((steer) => steer.text ?? "")
        .filter((body) => body !== "")
        .join("\n\n");
      // 取回来的那几条 chip 就地清掉（它们此刻已经不在执行端手里了）；对不上号的
      // （别的端排的）由归约原样放过，随后跟着 endTurn 交还给用户。
      queue.consume(drained);
      queue.endTurn();
      if (text === "") return;
      await send(text);
    })();
    return () => {
      stale = true;
    };
  }, [epoch, conversationId]);
}
