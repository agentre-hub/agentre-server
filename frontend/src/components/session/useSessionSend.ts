import { rpcMethods } from "@agentre-hub/agentre-wire";
import type { SessionSummary } from "@agentre-hub/agentre-wire";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import type { ChatComposerSubmit } from "@agentre-hub/agentre-ui";
import type { ModelTarget } from "@agentre-hub/agentre-ui";

import type { FailedSend } from "@/components/session/SendFailureBubble";
import { randomId } from "@/lib/randomId";
import type { RelayClient } from "@/lib/relayClient";
import { browserDisplayName, type RelayTicket } from "@/lib/relayTicket";
import { isNativeCompactBackend, SLASH_COMPACT } from "@/lib/slashCommands";
import { classifySendFailure, type SessionViewStatus } from "@/lib/sessionView";

/**
 * 发一条消息之后就地给出的反馈。三种互斥形态,不折叠成一个布尔:
 *   - queued —— 消息排进了**正在跑的那一轮**(steer),还没被消费。
 *   - failed —— 没发出去;detail 是对端自己的说明(已本地化),原样转述。
 * 「钉住的 agentred 不可用」不在这里 —— 它是会话级状态(停用新写入 + 状态横幅),
 * 由 pinnedAgentredUnavailable 承载。
 */
export type SendFeedback =
  { kind: "none" } | { kind: "queued" } | { kind: "failed"; detail?: string };

/** 这一轮跑到哪一步，以及发出去那一条的就地反馈。 */
export interface TurnActivity {
  /** 转录的三点读它。 */
  turnActive: boolean;
  /** 选路那一刻同步读的那一份，见下面 turnActiveRef 的说明。 */
  turnActiveRef: RefObject<boolean>;
  markTurnActive: (v: boolean) => void;
  pendingAssistant: boolean;
  setPendingAssistant: Dispatch<SetStateAction<boolean>>;
  sendFeedback: SendFeedback;
  setSendFeedback: Dispatch<SetStateAction<SendFeedback>>;
  /** 目标会话换了。由详情视图的渲染期重置调用。 */
  reset: () => void;
}

/**
 * 轮次状态与发送反馈。
 *
 * 与 useSessionSend 分成两只不是为了好看：中继的实时回调（onRunResultDone /
 * onAutonomousTurnStarted）与 attach 都要写这几样，而它们排在 `status` 与
 * `effectiveTarget` **之前** —— 发送那一族恰恰要等这两样才拼得出参数。所以这一半
 * 先声明，发送那一半晚一步，中间隔着的正是它们各自等的东西。
 */
export function useTurnActivity(): TurnActivity {
  /**
   * 这条会话此刻是否在跑一轮 —— 发消息的选路依据(在跑走 steer 插话,空闲走 run
   * 开新一轮)。
   *
   * 为什么不直接读 summary.lifecycleState:那是 **session.list 那一刻**的快照,此后
   * 永不刷新(这个组件只在 attach 时取一次清单)。用它选路,自己刚发出去的一轮还在
   * 飞时第二条消息仍会走 run,一头撞上 daemon 的 acquireTurnGate。这里以快照为起点,
   * 之后由实时信号维护:自己开轮 / 自主续轮开始 → true,轮次结束 → false。
   *
   * 它仍然只是**尽力而为**:别的端在这一刻开轮,浏览器要等事件才知道。判错的那一
   * 瞬间由 sendMessage 的一次回落收场(见那里),不是靠猜错误文本。
   *
   * **ref 与 state 一起写**,两者不是重复:
   *   - ref 给 `sendRouted` **同步**读(选路那一刻要的是「此刻」,不是上一次渲染
   *     看到的值),它是这个 ref 存在的全部理由;
   *   - state 给转录的三点(`&lt;Transcript streaming&gt;`)。ref 刻意不参与渲染,只写
   *     ref 的话「这一轮在跑」这件事就没有任何东西能把它画出来 —— 用户发完一条
   *     消息只能对着一段不动的转录猜。
   *
   * 一律经 `markTurnActive` 写,别只写一边。
   */
  const turnActiveRef = useRef(false);
  const [turnActive, setTurnActive] = useState(false);
  const [pendingAssistant, setPendingAssistant] = useState(false);
  const markTurnActive = useCallback((v: boolean) => {
    turnActiveRef.current = v;
    setTurnActive(v);
  }, []);
  const [sendFeedback, setSendFeedback] = useState<SendFeedback>({
    kind: "none",
  });

  /** 目标会话换了：反馈说的是**那一条**发出去的消息，跟着重来。 */
  const reset = useCallback(() => {
    setSendFeedback({ kind: "none" });
  }, []);

  return {
    turnActive,
    turnActiveRef,
    markTurnActive,
    pendingAssistant,
    setPendingAssistant,
    sendFeedback,
    setSendFeedback,
    reset,
  };
}

export interface SessionSendParams {
  /** 已装载的目标会话：这三样一变，排着的与没发出去的都属于上一条，要清掉。 */
  did: number;
  sid: string;
  originProp: string | undefined;
  /** 七类不可达状态。排队与回落都按它判（R11）。 */
  status: SessionViewStatus;
  /** 执行端此刻的实况。run 的参数从它上面拿——一份离线快照拼不出来。 */
  summary: SessionSummary | null;
  relayTicket: RelayTicket | null;
  clientRef: RefObject<RelayClient | null>;
  originRef: RefObject<string | undefined>;
  turn: TurnActivity;
  /** 这条对话钉的模型（用户这一次选的优先，否则落库那一份）。 */
  effectiveTarget: ModelTarget;
  effectivePermissionMode: string;
  /** 「钉住的 agentred 不可用」是会话级状态，归详情视图；这里只在发送时翻它。 */
  setPinnedAgentredUnavailable: Dispatch<SetStateAction<boolean>>;
}

/** 详情视图从这一族拿到的东西。 */
export interface SessionSend {
  /** 这一次发送在飞。输入框与失败气泡的按钮都读它。 */
  sending: boolean;
  /** 排着队等连接的那一条（决策 6）。 */
  pendingSend: string | null;
  /** 用户自己撤掉排着的那一条。 */
  cancelPendingSend: () => void;
  /** 没发出去的那些消息（决策 7）。 */
  failedSends: FailedSend[];
  sendMessage: (
    submitted: ChatComposerSubmit | string,
    replacing?: string,
  ) => Promise<void>;
  dropFailedSend: (id: string) => void;
  retryFailedSend: (failure: FailedSend) => Promise<void>;
}

/**
 * 目标会话换了没有。
 *
 * 与详情视图那段渲染期重置同一个模式（React 官方的「prop 变化时重置 state」）。
 * 不共用那一段是因为这一族在它**下面**才声明——那一段跑的时候这只 hook 还没被
 * 调用过，拿不到它的 setter。
 */
function useTargetChanged(
  did: number,
  sid: string,
  originProp: string | undefined,
): boolean {
  const [last, setLast] = useState({ did, sid, originProp });
  if (last.did !== did || last.sid !== sid || last.originProp !== originProp) {
    setLast({ did, sid, originProp });
    return true;
  }
  return false;
}

/**
 * 给这条会话发消息：选路（run / steer）、`/compact` 的两条分叉、重连期间的排队，
 * 以及没发出去那些字的去处。
 */
export function useSessionSend({
  did,
  sid,
  originProp,
  status,
  summary,
  relayTicket,
  clientRef,
  originRef,
  turn,
  effectiveTarget,
  effectivePermissionMode,
  setPinnedAgentredUnavailable,
}: SessionSendParams): SessionSend {
  const {
    turnActiveRef,
    markTurnActive,
    setPendingAssistant,
    setSendFeedback,
  } = turn;
  const [sending, setSending] = useState(false);
  /**
   * 没发出去的那些消息（决策 7）。它们不进 `events`：转录那一份是**对端说过的
   * 话**，一条根本没到对端的消息混进去会让下一次按 seq 拼接对不上号。
   */
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);
  /**
   * 排着队等连接的那一条（决策 6）。只留**一条**：重连期间连着敲好几段话，一个
   * 一个排进去、连上时一股脑发出去，读起来像自己被顶替了 —— 新的一条来时把旧的
   * 交给失败气泡，让用户自己决定。
   */
  const [pendingSend, setPendingSend] = useState<string | null>(null);

  const targetChanged = useTargetChanged(did, sid, originProp);
  if (targetChanged) {
    // 失败气泡属于**那一条**会话：换一条不该还挂着上一条没发出去的字。
    setFailedSends([]);
    setPendingSend(null);
  }

  /** 开新一轮（R9）。这一轮要落在**发起端**那条会话上，才续得上它的上下文、也才
   *  扇出给同一条会话的其余订阅者（R6 / R18）。 */
  function startTurn(
    c: import("@/lib/relayClient").RelayClient,
    message: ChatComposerSubmit,
  ): Promise<unknown> {
    const userBlocks = message.images?.map((image) => ({
      type: "image",
      data: {
        media_type: image.mediaType,
        source: { inline: image.dataUrl.split(",", 2)[1] ?? "" },
      },
    }));
    const { providerKey: llmProviderKey, modelKey: llmModelKey } =
      effectiveTarget;
    return c.request(rpcMethods.runtimeRun, {
      conversationId: sid,
      ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
      cwd: summary?.cwd,
      title: summary?.title,
      agentSyncId: summary?.agentSyncId,
      userText: message.text,
      ...(userBlocks?.length
        ? {
            userBlocks: userBlocks.map((block) => ({
              type: block.type,
              data: new TextEncoder().encode(JSON.stringify(block.data)),
            })),
          }
        : {}),
      permissionMode: effectivePermissionMode,
      ...(llmProviderKey ? { llmProviderKey, llmModelKey } : {}),
      sourceDevice: relayTicket?.clientId,
      sourceDeviceName: browserDisplayName(),
      backend: { type: summary?.backendType },
    });
  }

  /** 插话：把消息排进**正在跑的那一轮**（桌面端 internal/peer 与 agentred 都注册了
   *  runtime.steer）。origin 与 run 同样要带回：agentred 按 (发起端指纹, 会话 id)
   *  解会话。 */
  function steerTurn(
    c: import("@/lib/relayClient").RelayClient,
    body: string,
  ): Promise<unknown> {
    return c.request(rpcMethods.runtimeSteer, {
      conversationId: sid,
      ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
      // queuedId 是这条 steer 的不透明标识，**每条一个新的**。直连 agentred 的
      // 目标按它记提交方（handlers/runtime.go 的 SteerSource，门槛就是非空），
      // 等 backend 消费掉这条 steer 时把「来自 <设备>」盖回去；不传就没有归属，
      // 而同一个人用 run 发的消息是有的 —— 同一会话里两条消息标注不一致。
      //
      // 桌面端 peer 那条路径不看它（EnqueuePeerSession 自己 newQueuedID() 再按
      // peerSource 记归属），传了也无害。这里不按目标类型分叉：一条发送路径就该
      // 只有一种形状。
      queuedId: randomId(),
      text: body,
    });
  }

  /**
   * 按会话状态选路发送，返回 true = 这条消息是**排进当前这一轮**的（steer）。
   *
   * 「会话正忙」在协议上没有专属错误码：chat_svc 的 ChatSendInFlight 经
   * daemon/rpc 落成 -32603 + 本地化 message。所以正忙不靠解析错误判定，而是
   * 「选路 + 一次回落」——判定的那一瞬间轮次刚起或刚结束时，换另一条路再问一次，
   * 由对端自己裁决。对端拒绝一次是干净的空操作（run 在 acquireTurnGate 之前不落
   * 任何库，steer 在 Steer 之前不记任何来源），不会因此多出一条消息。
   */
  async function sendRouted(
    c: import("@/lib/relayClient").RelayClient,
    message: ChatComposerSubmit,
  ): Promise<boolean> {
    const body = message.text;
    const running = turnActiveRef.current;
    if (running && message.images?.length) {
      throw new Error("image input cannot be steered into an active turn");
    }
    try {
      await (running ? steerTurn(c, body) : startTurn(c, message));
      markTurnActive(true);
      if (!running) setPendingAssistant(true);
      return running;
    } catch (err) {
      // 只有对端真的收到并拒绝了，才值得换一条路重试。请求没走到对端（传输失败）
      // 时不回落：它可能已经送达，重发会多出一条消息。
      if (classifySendFailure(err).kind !== "rejected") throw err;
      try {
        await (running ? startTurn(c, message) : steerTurn(c, body));
        markTurnActive(true);
        if (running) setPendingAssistant(true);
        return !running;
      } catch {
        // 两条路都被拒 = 不是竞态。交出**第一条**（按选路本该走的那条）的说明：
        // 它才是对当前状态的描述。
        throw err;
      }
    }
  }

  /**
   * 压缩当前上下文。`runtime.run` 的 `compact` 参数就是这件事，daemon 的
   * handlers/runtime.go 把它直接透传给 runner —— 而 CapCompact 正是 codex 与 piagent
   * 声明的能力。这一轮**没有用户消息**：把 `/compact` 也当正文送过去等于既压缩又
   * 多说一句。
   */
  function compactTurn(
    c: import("@/lib/relayClient").RelayClient,
  ): Promise<unknown> {
    return c.request(rpcMethods.runtimeRun, {
      conversationId: sid,
      ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
      cwd: summary?.cwd,
      title: summary?.title,
      agentSyncId: summary?.agentSyncId,
      compact: true,
      sourceDevice: relayTicket?.clientId,
      sourceDeviceName: browserDisplayName(),
      backend: { type: summary?.backendType },
    });
  }

  // R9：给会话发新消息（不需要发起端在线；上下文由 agentred 侧的
  // providerSessionID 续上，决策 8）。
  async function sendMessage(
    submitted: ChatComposerSubmit | string,
    replacing?: string,
  ) {
    const c = clientRef.current;
    const message =
      typeof submitted === "string"
        ? { text: submitted.trim() }
        : { ...submitted, text: submitted.text.trim() };
    const body = message.text;
    if (!body && !message.images?.length) return;
    /*
      重连期间不往一条断了的连接上扔（决策 6）：排一条看得见的队，连上自动发出。
      判据是 `status`，不是 `c` 在不在——重连时 client 还在，只是发不出去。

      只对 `reconnecting` 这么做。`lost` 与 B / C 档不排队：那几档要么已经不再
      自动重连、要么等的是那台机器，排进去就是许一个不会到的承诺。
    */
    if (status === "reconnecting") {
      setPendingSend((prev) => {
        if (prev) queueFailedSend(prev, "notSent");
        return body;
      });
      return;
    }
    if (!c || !summary || !relayTicket) return;
    setSending(true);
    setSendFeedback({ kind: "none" });
    try {
      /*
        `/compact` 分两路，与桌面端 slash-commands/registry.ts 的注释逐条对上：
        claudecode 的 CLI 自己认这个前缀，原样当正文送过去就行；codex / piagent 的
        CLI **不认**，桌面端是在 chat-panel 的 onSubmit 里拦下这段文本转成压缩 RPC。
        不拦的话，菜单在这两个后端上摆的是一条按下去只会当普通消息发出去、什么也不
        做的命令。

        只拦**正好**是这条命令的那一行：「/compact 之前先把结论记下来」是一句给模型
        的话，不是一条命令。
      */
      if (
        body === `/${SLASH_COMPACT}` &&
        !isNativeCompactBackend(summary.backendType)
      ) {
        await compactTurn(c);
        markTurnActive(true);
        setPinnedAgentredUnavailable(false);
        return;
      }
      const queued = await sendRouted(c, message);
      setPinnedAgentredUnavailable(false);
      // 重发成功：那条失败气泡的使命完成了，撤掉。
      if (replacing) dropFailedSend(replacing);
      if (queued) setSendFeedback({ kind: "queued" });
    } catch (err) {
      const failure = classifySendFailure(err);
      if (failure.kind === "executionUnavailable") {
        // 对端明说了「执行目标不可用」：历史继续可读，但停用新写入并给专门说明。
        // 只有这个专属码算数——把任何失败都归到这里，会把「会话正忙」报成守护进程
        // 掉线，用户看到的是一个假的故障。
        setPinnedAgentredUnavailable(true);
        if (replacing) dropFailedSend(replacing);
      } else {
        // 这一条没发出去：把用户写的那段字留在流里（决策 7）。静默吞掉会让人以为
        // 已经发了；而输入框早在提交那一刻就被 AIChatInput 清空了，字不留在这里
        // 就真的没了。对端自己的说明（已本地化）原样转述，不替换成我们编的故事。
        //
        // 重发失败时**原地更新**那一条，不再挂一条新的：同一段字在流里出现两次
        // 只会让人以为自己发了两遍。分类可能变（断线重发被拒），所以整条替换。
        queueFailedSend(body, failure.kind, failure.detail, replacing);
      }
    } finally {
      setSending(false);
    }
  }

  /*
    排着的那一条的两个去处（决策 6）：连上了就发出去，彻底断了就交给失败气泡。

    放在 effect 里而不是 `sendMessage` 里：它等的是**状态变化**，不是某一次点击。
    依赖只列 status —— `sendMessage` 每次渲染都是新函数，列进去这个 effect 会每
    渲染跑一遍，同一条消息发好几次。
  */
  useEffect(() => {
    if (!pendingSend) return;
    // 还在等：连接可能回来，这一条继续排着。
    if (status === "connecting" || status === "reconnecting") return;
    // 连上不等于**发得出去**：重连回来那一拍，会话摘要（session.list）常常还在
    // 路上，而 sendMessage 要它才拼得出 run 的参数。差一样就等下一拍——摘要落地
    // 时这个 effect 会因为 summary 变了再跑一遍。少了这一条，排着的那句会在
    // 「连上了但还没就绪」的缝里被静默丢掉。
    const ready =
      status === "connected" && clientRef.current && summary && relayTicket;
    if (status === "connected" && !ready) return;
    const body = pendingSend;
    // 状态更新推到 effect 之后：`react-hooks/set-state-in-effect` 禁止在 effect
    // 体里裸调 setState，而这里本来就要跟着一次异步发送走。
    void (async () => {
      setPendingSend(null);
      if (ready) {
        await sendMessage(body);
        return;
      }
      // 剩下的档（lost / 机器不在 / 设备撤销）：这条永远发不出去了，与其一直排着，
      // 不如摆到用户眼前让他决定。它从来没走到对端，所以重发是干净的。
      queueFailedSend(body, "notSent");
    })();
    // 只跟这几样的变化走。sendMessage / queueFailedSend 每次渲染都是新函数，
    // 列进依赖会让这个 effect 每渲染跑一遍，同一条消息发好几次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, pendingSend, summary, relayTicket]);

  /** 往流里挂一条失败气泡。重发失败时原地替换 `replacing` 那一条。 */
  function queueFailedSend(
    text: string,
    kind: FailedSend["kind"],
    detail?: string,
    replacing?: string,
  ) {
    const next: FailedSend = {
      id: replacing ?? randomId(),
      text,
      kind,
      detail,
    };
    setFailedSends((prev) =>
      replacing && prev.some((f) => f.id === replacing)
        ? prev.map((f) => (f.id === replacing ? next : f))
        : [...prev, next],
    );
  }

  function dropFailedSend(id: string) {
    setFailedSends((prev) => prev.filter((f) => f.id !== id));
  }

  /**
   * 重发一条失败的消息。
   *
   * transport 那一类**先补一次转录再发**（按钮上写的就是「检查后重发」）：请求
   * 可能已经送达，那样重发就会多出一条消息。补齐把已经落地的那条拉回屏幕上，
   * 用户据此自己判断还要不要发。补齐失败不拦着重发——那时用户手里的信息不比
   * 现在少，拦下来只会让这条消息彻底发不出去。
   */
  async function retryFailedSend(failure: FailedSend) {
    const c = clientRef.current;
    if (failure.kind === "transport" && c) {
      try {
        await c.catchUp(sid, originRef.current || undefined);
      } catch {
        // 故意吞掉：补齐只是「看一眼」，它失败不该把重发这条路也堵死。
      }
    }
    await sendMessage(failure.text, failure.id);
  }

  const cancelPendingSend = useCallback(() => setPendingSend(null), []);

  return {
    sending,
    pendingSend,
    cancelPendingSend,
    failedSends,
    sendMessage,
    dropFailedSend,
    retryFailedSend,
  };
}
