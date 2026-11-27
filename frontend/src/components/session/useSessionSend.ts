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

import { isNativeCompactBackend, SLASH_COMPACT } from "@agentre-hub/agentre-ui";
import type {
  ChatComposerHandle,
  ChatComposerSubmit,
} from "@agentre-hub/agentre-ui";
import type { ModelTarget, TranscriptMessage } from "@agentre-hub/agentre-ui";

import { deliveredFailureIds } from "@/components/session/deliveredSends";
import type { FailedSend } from "@/components/session/SendFailureBubble";
import type { SteerQueue } from "@/components/session/useSteerQueue";
import { useAliveEffect } from "@/hooks/use-alive-effect";
import { useTargetGuard } from "@/hooks/use-target-guard";
import {
  draftStore,
  isEmptyDraft,
  liveDraftOf,
  useDraftKey,
} from "@/lib/drafts";
import { forgetLiveTurn, noteLiveTurn, seedLiveTurn } from "@/lib/liveSessions";
import {
  outboxStore,
  payloadBytes,
  requestTimeoutFor,
  subscribeOutbox,
  type OutboxMessage,
} from "@/lib/outbox";
import { randomId } from "@/lib/randomId";
import { encodeUserBlocks } from "@/lib/userBlocks";
import type { RelayClient, UploadProgress } from "@/lib/relayClient";
import { browserDisplayName, type RelayTicket } from "@/lib/relayTicket";

import { classifySendFailure, type SessionViewStatus } from "@/lib/sessionView";

/** 这一轮跑到哪一步。 */
export interface TurnActivity {
  /** 转录的三点读它。 */
  turnActive: boolean;
  /** 选路那一刻同步读的那一份，见下面 turnActiveRef 的说明。 */
  turnActiveRef: RefObject<boolean>;
  /**
   * `fromSnapshot` = 这一句来自 attach 那一刻的清单快照，不是一次亲眼看到的轮次
   * 边界。左栏据它分辨「刚有动静」与「打开时它就在跑」，见 `seedLiveTurn`。
   */
  markTurnActive: (v: boolean, fromSnapshot?: boolean) => void;
  /**
   * 这个浏览器自己开了一轮（发出即见那一下）。与 `markTurnActive(true)` 的区别：
   * 之后那一份**更早**问到的清单快照说「没在跑」时，不能把它收回去，见下面
   * `ownTurnRef`。
   */
  markOwnTurnStarted: () => void;
  pendingAssistant: boolean;
  setPendingAssistant: Dispatch<SetStateAction<boolean>>;
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
export function useTurnActivity(conversationId: string): TurnActivity {
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
  /** 只动这一屏自己那两份。`reset` 走它 —— 它在渲染期被调用，不能往外说话。 */
  const setTurnActiveLocal = useCallback((v: boolean) => {
    turnActiveRef.current = v;
    setTurnActive(v);
  }, []);
  /**
   * 除了这两份，还往 `@/lib/liveSessions` 记一笔：**左栏**据它在账号镜像之上叠一层。
   *
   * 左栏此前只有镜像一条来路，于是「我刚发了一条消息」要等一个来回才看得出来
   * （联调机 2026-09-08 实测 2s），而镜像对一条 `interrupted` 的会话有意不 attach ——
   * 那时它整轮一次都不亮。桌面端一直不吃这个亏（`session-status-store` 在发送成功
   * 那一刻乐观置 running，"不依赖后端在 turn 起手时 emit session_status"）。
   *
   * 记在**这里**而不是各个调用点：`markTurnActive` 已经是这件事唯一的写入口
   * （自己发送 / 回声 / 开轮帧 / 自主续轮 / attach 时的清单快照，五条路都经过它），
   * 各写一遍就会漏掉其中几条。
   */
  /**
   * 自己开的那一轮还没见到终点。
   *
   * 清单与镜像转录并行之后（弱网决策 10），清单先回来就能发送，而 attach 收尾按的
   * 仍是**发送之前**问到的那份快照：它说「idle」时，此刻在跑的正是自己刚开的这一轮
   * ——照它收回，三点与 Running 就在这一轮跑着的时候灭掉，直到它跑完都不再亮。
   * 所以快照的「没在跑」让位给它；一次亲眼看到的终点（终态帧 / 发送撤回）才放下。
   */
  const ownTurnRef = useRef(false);
  const markTurnActive = useCallback(
    (v: boolean, fromSnapshot?: boolean) => {
      if (fromSnapshot && !v && ownTurnRef.current) v = true;
      if (!fromSnapshot && !v) ownTurnRef.current = false;
      setTurnActiveLocal(v);
      if (fromSnapshot) seedLiveTurn(conversationId, v);
      else noteLiveTurn(conversationId, v);
    },
    [conversationId, setTurnActiveLocal],
  );
  /**
   * 不再盯着这一条了（右栏换了一条 / 整屏卸载）：撤回「在跑」那半句。
   *
   * 它此后没有任何来路 —— 这个浏览器收不到这条会话的帧了，一条在你没看的时候跑完
   * 的对话会永远绿着。时间那一半不撤：消息确实是那一刻发出去的（见 forgetLiveTurn）。
   *
   * 放在 effect 的清理里而不是 `reset` 里：`reset` 由渲染期的「prop 变了就重置」调用，
   * 那里不能有外部副作用；而清理拿得到的正是**上一条**会话的标识。
   */
  useEffect(() => () => forgetLiveTurn(conversationId), [conversationId]);
  /**
   * 目标会话换了：这一族说的全是**那一条**会话的事，跟着重来。
   *
   * 「在不在跑」也在其中,而它此前留在这里没清 —— 桌面右栏切换是同实例换 props
   * (没有 key 强制重挂),于是从在跑的 A 切到空闲的 B,B 一打开就摆着 A 那一份:
   * 头部画出「停止」、状态点是绿的,而 B 根本没在跑,要等 attach 按 B 的清单快照
   * 把它改回来。同一份还被 `turnActiveRef` 拿去做发送选路(在跑走 steer 插话,
   * 空闲走 run 开新一轮),这一段里往 B 发消息会当成插话发给一轮并不存在的 turn。
   *
   * 清成 false 而不是「保持不动」：新会话在不在跑,只有 attach 答得出,在它回答
   * 之前这一屏**不知道** —— 而上一条会话的答案与这个问题无关。
   */
  const markOwnTurnStarted = useCallback(() => {
    ownTurnRef.current = true;
    markTurnActive(true);
  }, [markTurnActive]);
  const reset = useCallback(() => {
    ownTurnRef.current = false;
    setTurnActiveLocal(false);
    setPendingAssistant(false);
  }, [setTurnActiveLocal]);

  return {
    turnActive,
    turnActiveRef,
    markTurnActive,
    markOwnTurnStarted,
    pendingAssistant,
    setPendingAssistant,
    reset,
  };
}

/**
 * 这一条要走 `runtime.steer`,而它带着图 —— steer 的参数里只有 `text`
 * （daemon 的 handlers/runtime.go），所以这条**确实**发不出去,一帧都没出门。
 *
 * 有自己的类型而不是裸 `Error`:裸 `Error` 不是 `RelayError`,
 * `classifySendFailure` 认不出它、会归成 `transport`,气泡于是说「连接断了,可能
 * 已经送达,再发一次可能变成两条」—— 连接好好的、这条没送达、重发也是干净的。
 */
class ImagesCannotSteer extends Error {
  constructor() {
    super("image input cannot be steered into an active turn");
    this.name = "ImagesCannotSteer";
  }
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
  /**
   * 执行端清单在这条连接上还没答（弱网决策 11）。连着而它为真时发送排队等清单，
   * 不报「还没发出去」；清单答了（失败，或里面没有这一条）而 `summary` 仍空时，
   * 排着的那条才交给失败气泡。缺省为假：调用方没有「清单在路上」这一档。
   */
  summaryPending?: boolean;
  relayTicket: RelayTicket | null;
  clientRef: RefObject<RelayClient | null>;
  originRef: RefObject<string | undefined>;
  turn: TurnActivity;
  /** 这条对话钉的模型（用户这一次选的优先，否则落库那一份）。 */
  effectiveTarget: ModelTarget;
  /**
   * 这条对话此刻的 CLI 自带模型选择（mode 空 = 跟随 Agent 绑定）。每一轮都随
   * runtime.run 过线：agentred 按每一轮的请求取模型，不带就退回后端绑定值；桌面端
   * 承载已有会话时不认这两格，带上无害。
   */
  cliModel?: { mode: string; value: string };
  effectivePermissionMode: string;
  /** 「钉住的 agentred 不可用」是会话级状态，归详情视图；这里只在发送时翻它。 */
  setPinnedAgentredUnavailable: Dispatch<SetStateAction<boolean>>;
  /**
   * 这一轮里排着的那几条插话。走 steer 的那条路由这里挂进去、换句柄、失败撤掉 ——
   * 「这条消息是排进当前这一轮的」只有选路这一处知道。
   */
  steerQueue: SteerQueue;
  /**
   * 这一次发送**开了新的一轮**（不是插话进正在跑的那一轮）。
   *
   * 只有这一处知道选路的结果，而「一轮的起点观察得到」正是那条 meta 敢不敢自己
   * 计时的判据（见 useLiveTurnTiming）。与 `setPendingAssistant(true)` 同进同退：
   * 那一行说的也是同一件事——这一轮刚由这个浏览器开起来。
   */
  onOwnTurnStarted?: () => void;
  /**
   * 这一屏转录此刻画到的最大 seq（不低于清单那一刻执行端的高水位：镜像那一段可能
   * 还没回来）。「发送中」那一条记下按发送那一刻的值，回声认的是
   * 它之后才到的那一帧 `user_message`（见 `SendingMessage.afterSeq`）。只在发送那一
   * 刻读。缺省 0。
   */
  transcriptSeq?: () => number;
  /**
   * 输入框的句柄。排着的那条被「撤销」时，整条消息（字与图，原样）从这里放回输入框
   * （规格 2026-11-25 C 节）。不给 = 撤销只撤不放回。
   */
  composerHandleRef?: RefObject<ChatComposerHandle | null>;
  /**
   * 这一屏投影出来的转录。「可能已送达」的那几条在这里看得见了（内容一致、时间不早于
   * 交出时刻的用户消息）就收起，连同发件箱里那一条（规格 2026-11-25 K4）。缺省为空：
   * 什么都不收。
   */
  transcript?: readonly TranscriptMessage[];
}

/** `transcript` 的缺省值：模块级常量，免得每次渲染一个新数组让下面的 effect 重跑。 */
const NoTranscript: readonly TranscriptMessage[] = [];

/**
 * 这么大的消息才显示上传进度：小消息一眨眼就出门，进度环只会闪一下。
 */
const UploadProgressMinBytes = 64 * 1024;

/**
 * 自己刚发出去、回声还没到的那一条（弱网规格 2026-11-20 决策 12）。
 *
 * 它不进 `events`，理由与失败气泡同一条：那一份是对端说过的话。详情视图把它接在
 * 投影出来的转录末尾，三点挂在它之后；回声一到就让位给正式那条。
 */
export interface SendingMessage extends ChatComposerSubmit {
  /** 发送那一刻转录画到的 seq。seq 比它大的 `user_message` 帧才是这一条的回声。 */
  afterSeq: number;
  /** runtime.run 已经应答：这一轮被对端接下了。在此之前没有一轮可停。 */
  acknowledged: boolean;
  /**
   * 这一帧还在往外传（大图，规格 2026-11-25 C4）：已传 / 共。传完即撤；没有「取消」
   * ——已经交给 WebSocket 的帧浏览器撤不回。
   */
  upload?: UploadProgress;
}

/** 详情视图从这一族拿到的东西。 */
export interface SessionSend {
  /** 这一次发送在飞。输入框与失败气泡的按钮都读它。 */
  sending: boolean;
  /** 排着队等连接的那一条（决策 6）。 */
  pendingSend: ChatComposerSubmit | null;
  /** 已经发出去、回声还没到的那一条（弱网决策 12）。 */
  sendingMessage: SendingMessage | null;
  /**
   * 「在跑」已经提前亮了，但 runtime.run 还没应答 —— 这一轮还没被对端接下。停止键
   * 据此先不给：此刻没有一轮可停。
   */
  awaitingRun: boolean;
  /** 用户自己撤掉排着的那一条：整条放回输入框。 */
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
  summaryPending = false,
  relayTicket,
  clientRef,
  originRef,
  turn,
  effectiveTarget,
  cliModel,
  effectivePermissionMode,
  setPinnedAgentredUnavailable,
  steerQueue,
  onOwnTurnStarted,
  transcriptSeq = () => 0,
  composerHandleRef,
  transcript = NoTranscript,
}: SessionSendParams): SessionSend {
  const {
    turnActiveRef,
    markTurnActive,
    markOwnTurnStarted,
    setPendingAssistant,
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
   *
   * 排的是**整条消息**而不是一段文本:贴在这一句上的图与字同属用户刚说的那一条,
   * 只排文本的话连上之后发出去的是一条纯文本 —— 图在排队那一瞬间就没了,而屏幕上
   * 那条排队气泡看着一切正常。
   */
  const [pendingSend, setPendingSend] = useState<OutboxMessage | null>(null);
  /**
   * 发出即见的那一条（弱网决策 12）。只在开新一轮的那条路上挂：插话那条由
   * steerQueue 的 chip 当场承载，再挂一份就是同一句话出两遍。
   *
   * 发送成功后**不**清：回声常常晚于 run 的应答，先清掉的话这句话会在两者之间的
   * 缝里消失一下。何时让位由详情视图按回声判（见那里的 `sendingShown`）。
   */
  const [sendingMessage, setSendingMessage] = useState<SendingMessage | null>(
    null,
  );

  const draftKey = useDraftKey();
  /** 用户在这一屏丢弃过的失败（发件箱的通知晚到时不把它们加回来）。 */
  const dismissedRef = useRef(new Set<string>());

  const targetChanged = useTargetChanged(did, sid, originProp);
  if (targetChanged) {
    // 失败气泡属于**那一条**会话：换一条不该还挂着上一条没发出去的字。
    setFailedSends([]);
    setPendingSend(null);
    setSendingMessage(null);
    // 发出即见那一下是这里点亮的「在跑」（见 sendRouted）：它属于上一条会话，这里
    // 自己收回，不指望调用方恰好也重置了轮次状态。reset 只动这一屏的两格，渲染期可调。
    turn.reset();
    // 上一条那次发送还在飞，而它的结果从此不再写这里的任何状态（见下面的守卫）
    // ——包括 finally 里那次 setSending(false)。不在这里放下，新会话的输入框会
    // 顶着一个永远转不完的发送键。
    setSending(false);
  }

  /**
   * 在途结果的目标守卫。见 useTargetGuard —— 这一族尤其需要它：右栏是同实例换
   * props，`useTargetChanged` 清得掉已经落地的状态，却拦不住一次**已经 await
   * 出去**的 `sendRouted`。
   */
  const guardTarget = useTargetGuard(`${did}|${sid}|${originProp ?? ""}`);

  /*
    打开（或换到）一条对话：从本机发件箱恢复它排着的那条与失败的那些（C2）。发送方已经
    不在了的「已交出」由发件箱落成「可能已送达」（C3）。之后本页别处（离开前那一屏还在
    飞的发送）写进来的失败随通知并进来。
  */
  useAliveEffect(
    (alive) => {
      const merge = (stored: FailedSend[]) =>
        setFailedSends((prev) => {
          const fresh = stored.filter(
            (f) =>
              !dismissedRef.current.has(f.id) &&
              !prev.some((p) => p.id === f.id),
          );
          return fresh.length ? [...prev, ...fresh] : prev;
        });
      void outboxStore.restore(sid).then(({ queued, failed }) => {
        if (!alive()) return;
        if (queued) setPendingSend((prev) => prev ?? queued);
        merge(failed);
      });
      return subscribeOutbox(sid, (entry) => {
        if (alive()) merge(entry.failed);
      });
    },
    [sid],
  );

  /** 开新一轮（R9）。这一轮要落在**发起端**那条会话上，才续得上它的上下文、也才
   *  扇出给同一条会话的其余订阅者（R6 / R18）。 */
  function startTurn(
    c: import("@/lib/relayClient").RelayClient,
    message: ChatComposerSubmit,
    onUpload: (progress: UploadProgress) => void,
  ): Promise<unknown> {
    const userBlocks = encodeUserBlocks(message.images);
    const { providerKey: llmProviderKey, modelKey: llmModelKey } =
      effectiveTarget;
    const params = {
      conversationId: sid,
      ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
      cwd: summary?.cwd,
      title: summary?.title,
      agentSyncId: summary?.agentSyncId,
      userText: message.text,
      ...(userBlocks ? { userBlocks } : {}),
      permissionMode: effectivePermissionMode,
      ...(llmProviderKey ? { llmProviderKey, llmModelKey } : {}),
      // 空 mode 就是 proto3 的缺省值，省略与写空串在线上同义；省略只是不改既有请求形。
      ...(cliModel?.mode
        ? { cliModelMode: cliModel.mode, cliModel: cliModel.value }
        : {}),
      sourceDevice: relayTicket?.peerFingerprint,
      sourceDeviceName: browserDisplayName(),
      backend: { type: summary?.backendType },
    };
    // 大消息（C4）：等应答的上限按体积放宽，并报上传进度。小消息照旧，请求形状不变。
    const bytes = payloadBytes(message);
    if (bytes < UploadProgressMinBytes) {
      return c.request(rpcMethods.runtimeRun, params);
    }
    return c.request(rpcMethods.runtimeRun, params, {
      timeoutMs: requestTimeoutFor(bytes),
      onUpload,
    });
  }

  /** 插话：把消息排进**正在跑的那一轮**（桌面端 internal/peer 与 agentred 都注册了
   *  runtime.steer）。origin 与 run 同样要带回：agentred 按 (发起端指纹, 会话 id)
   *  解会话。 */
  async function steerTurn(
    c: import("@/lib/relayClient").RelayClient,
    body: string,
  ): Promise<void> {
    // queuedId 是这条 steer 的不透明标识，**每条一个新的**。直连 agentred 的
    // 目标按它记提交方（handlers/runtime.go 的 SteerSource，门槛就是非空），
    // 等 backend 消费掉这条 steer 时把「来自 <设备>」盖回去；不传就没有归属，
    // 而同一个人用 run 发的消息是有的 —— 同一会话里两条消息标注不一致。
    //
    // 它同时是这条 chip 的**本地句柄**：应答回来之前队列只认这个号。桌面端托管的
    // 那条路上 chat_svc 会另造一个号（EnqueuePeerSession → enqueue 的
    // newQueuedID），所以应答带回来的才是权威的那个，见下面的 adopt。
    const localId = randomId();
    // 提交那一刻就挂上去：输入框在提交时已经被清空，这段字此刻只存在于队列里。
    steerQueue.enqueue(localId, body);
    try {
      const result = (await c.request(rpcMethods.runtimeSteer, {
        conversationId: sid,
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
        queuedId: localId,
        text: body,
      })) as { queuedId?: string; cancellable?: boolean } | undefined;
      // 空 queuedId = 对端还没升级到会回传句柄的那一版：这条留在降级档（撤不掉，
      // 只能靠文本抵消消费），不按版本号猜。
      steerQueue.adopt(localId, {
        queuedId: result?.queuedId ?? "",
        cancellable: result?.cancellable === true,
      });
    } catch (err) {
      // 这一条没排进去：chip 撤掉，那段字改由转录里的失败气泡承载。两处同时挂着
      // 同一句会读成发了两遍。
      steerQueue.drop([localId]);
      throw err;
    }
  }

  /**
   * 按会话状态选路发送。走 steer 的那一条会由 `steerTurn` 挂进队列。
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
    stillHere: () => boolean,
  ): Promise<void> {
    const body = message.text;
    const running = turnActiveRef.current;
    const hasImages = !!message.images?.length;
    /*
      插话（`runtime.steer`）的参数里只有 `text`（daemon 的 handlers/runtime.go），
      图带不动。所以「这一条带着图」与「这一条要走 steer」不能同时成立。

      判在**选路这一处**,而不是进 `sendMessage` 之前:`turnActiveRef` 只是一份尽力
      而为的快照,而通往 steer 的路有两条 —— 这一条(快照说在跑),以及下面回落的
      那一条(快照说没在跑,run 却被对端拒了)。任何一条不拦,那张图就在一次报成
      **成功**的发送里静默没了,用户没有任何理由再发一次。

      抛的是一个自己的类型,不是裸 Error:裸 Error 不是 RelayError,
      `classifySendFailure` 认不出它、归成 `transport`,气泡于是说「连接断了,可能
      已经送达,再发一次可能变成两条」——三句全是假的。
     */
    if (running && hasImages) throw new ImagesCannotSteer();
    /**
     * 这一轮跑起来了。
     *
     * 「跑起来的是**哪一条**会话」正是这里要守住的：`turnActiveRef` /
     * `pendingAssistant` / 那条 meta 的计时都属于发起这次发送的那条对话，而请求
     * 回来时右栏可能已经换成了另一条。不守的话，B 会凭空冒出三个点与一段从 A
     * 那边算起的耗时。
     */
    const noteStarted = (openedTurn: boolean) => {
      if (!stillHere()) return;
      markTurnActive(true);
      if (openedTurn) {
        setPendingAssistant(true);
        onOwnTurnStarted?.();
      }
    };
    /*
      发出即见（弱网决策 12）：开新一轮的这条路上，不等 run 应答就把这条摆出来、
      点亮三点与头部的 Running。弱网下这一两秒里用户此前看不到任何东西，分不清
      发没发出去。

      在**选路之后**才点亮：`running` 已经按此刻的 ref 读过了，这里改它不影响这一次
      的路由。失败时（被拒 / 没发出去 / 断开）一并撤回 —— 撤回的就是这里点亮的那
      一份，此前它是灭的（`running` 为假才走到这一支）。
     */
    if (!running) {
      setSendingMessage({
        ...message,
        afterSeq: transcriptSeq(),
        acknowledged: false,
      });
      markOwnTurnStarted();
      setPendingAssistant(true);
    }
    // 上传进度只挂在「发送中」那一条上；传完即撤。
    const onUpload = (progress: UploadProgress) => {
      if (!stillHere()) return;
      const upload = progress.sent < progress.total ? progress : undefined;
      setSendingMessage((prev) => prev && { ...prev, upload });
    };
    try {
      await (running ? steerTurn(c, body) : startTurn(c, message, onUpload));
      noteStarted(!running);
      if (!running && stillHere())
        setSendingMessage((prev) => prev && { ...prev, acknowledged: true });
      return;
    } catch (err) {
      if (!running && stillHere()) {
        setSendingMessage(null);
        markTurnActive(false);
        setPendingAssistant(false);
      }
      // 只有对端真的收到并拒绝了，才值得换一条路重试。请求没走到对端（传输失败）
      // 时不回落：它可能已经送达，重发会多出一条消息。
      if (classifySendFailure(err).kind !== "rejected") throw err;
      // 回落那一支走的是 steer(上面 `running` 为真的那条已经在函数开头拦掉了),
      // 而它带不动图 —— 所以这一条**没有**第二条路。交出对端自己那句拒绝的原话:
      // 它才是对当前状态的描述,而且已经由对端本地化过。改走 steer 等于把用户贴的
      // 图悄悄摘掉再发一次,并把结果报成成功。
      if (hasImages) throw err;
      try {
        await (running ? startTurn(c, message, onUpload) : steerTurn(c, body));
        noteStarted(running);
        return;
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
      sourceDevice: relayTicket?.peerFingerprint,
      sourceDeviceName: browserDisplayName(),
      backend: { type: summary?.backendType },
    });
  }

  // R9：给会话发新消息（不需要发起端在线；上下文由 agentred 侧的
  // providerSessionID 续上，决策 8）。
  //
  // `fromQueue` = 这一条就是排着的那条（下面那只 effect 连上时交进来）：交出时要从
  // 发件箱里**认领**它，别的实例（标签页）先认领走了就不发（C3，不发两次）。
  async function sendMessage(
    submitted: ChatComposerSubmit | string,
    replacing?: string,
    fromQueue?: OutboxMessage,
  ) {
    const c = clientRef.current;
    // 只取消息本身（字与图）：从发件箱交进来的那条还带着它的身份，那一格不是消息。
    const message: ChatComposerSubmit =
      typeof submitted === "string"
        ? { text: submitted.trim() }
        : submitted.images
          ? { text: submitted.text.trim(), images: submitted.images }
          : { text: submitted.text.trim() };
    const body = message.text;
    if (!body && !message.images?.length) return;
    /*
      重连期间不往一条断了的连接上扔（决策 6）：排一条看得见的队，连上自动发出。
      判据是 `status`，不是 `c` 在不在——重连时 client 还在，只是发不出去。

      只对 `reconnecting` 这么做。`lost` 与 B / C 档不排队：那几档要么已经不再
      自动重连、要么等的是那台机器，排进去就是许一个不会到的承诺。

      握手完成而清单还在路上（弱网决策 11）走同一条路：输入框此刻已经可用，清单
      到了这一条自动发出；清单失败或里面没有这一条时，下面那只 effect 把它交给
      失败气泡。

      排着的这条同时存进本机发件箱（C2）：离开对话、重载、杀 App 之后回来仍在。
    */
    if (
      status === "reconnecting" ||
      (status === "connected" && summaryPending && !summary)
    ) {
      // 从一条失败气泡上重发的:它现在排着队了,原来那条气泡就该撤掉。同一条消息
      // 同时以两个身份摆在屏幕上（一个说排着队、一个说没发出去）比哪一个都糟。
      if (replacing) dropFailedSend(replacing);
      const queued: OutboxMessage = {
        id: fromQueue?.id ?? randomId(),
        ...message,
      };
      setPendingSend((prev) => {
        if (prev && prev.id !== queued.id)
          queueFailedSend(prev, "notSent", undefined, prev.id);
        return queued;
      });
      void outboxStore.queue(sid, queued, replacing);
      return;
    }
    if (!c || !summary || !relayTicket) {
      /*
        发不出去，但**不是**什么都没发生：用户的那段字已经被输入框在提交那一刻
        清空了（AIChatInput 的行为），这里裸 return 的话它就真的没了 —— 没有气泡、
        没有提示，一句话凭空消失。而输入框只按连接状态启用
        （SessionComposerBand），会话清单请求失败、或这条会话已经不在清单里时就会
        走到这儿。

        归 `notSent`：一次请求都没发出去，所以那颗「重发」是干净的。

        `replacing` 要往下传：从一条失败气泡上重发而这时还没就绪的话，不传就成了
        同一条消息在流里挂两条气泡 —— 与下面那句「重发失败时原地更新那一条」同一
        条规矩，只是这一档此前漏了。
      */
      const failure = queueFailedSend(message, "notSent", undefined, replacing);
      void outboxStore.putFailure(sid, failure);
      return;
    }
    /*
      从这里往下都要 await。请求发出去那一刻捕获目标，解析时先比对再写状态：
      右栏是同实例换 props，A 的这一次发送很可能是在 B 打开着的时候才回来的。
      发件箱那几笔写的是**发起它的那条**会话（`conversationId`），与此刻屏幕上是哪条
      无关：离开了对话，结果照样落进它自己的发件箱。
    */
    const stillHere = guardTarget();
    const conversationId = sid;
    /*
      `/compact` 分两路，与桌面端 slash-commands/registry.ts 的注释逐条对上：
      claudecode 的 CLI 自己认这个前缀，原样当正文送过去就行；codex / piagent 的
      CLI **不认**，桌面端是在 chat-panel 的 onSubmit 里拦下这段文本转成压缩 RPC。
      不拦的话，菜单在这两个后端上摆的是一条按下去只会当普通消息发出去、什么也不
      做的命令。

      只拦**正好**是这条命令的那一行：「/compact 之前先把结论记下来」是一句给模型
      的话，不是一条命令。
    */
    const compact =
      body === `/${SLASH_COMPACT}` &&
      !isNativeCompactBackend(summary.backendType);
    /*
      交出（C3）：把这一条记成「已交出」（同时拿住它的发送锁）。App 在拿到结果之前被
      杀，下次打开时它落「可能已送达」，永不自动再发。

      排着的那条与从失败气泡重发的那条，库里还摆着它的另一个身份（排队 / 失败）：
      **等这一笔落库之后**才写出请求，否则在两者之间被杀，恢复出来的是一条会被自动再发
      （排队）或标着「重发是干净的」（失败）的消息。排着的那条还在这里被认领：别的实例
      先认领走了就不发。一条刚敲出来的新消息库里没有别的身份，不等这一笔——选路要的是
      此刻的轮次状态，晚几毫秒就可能把插话判成新的一轮。
    */
    const outboxId = replacing ?? fromQueue?.id ?? randomId();
    /*
      交出时刻（K4）：转录里出现内容一致、不早于它的用户消息时，「可能已送达」收起。
      从一条「可能已送达」上重发的沿用它最初那次交出：那一次就可能已经送到了，转录里
      出现的也可能是那一份。
    */
    const handedOffAt =
      failedSends.find((f) => f.id === replacing && f.kind === "transport")
        ?.handedOffAt ?? Date.now();
    const handed = outboxStore.handOff(
      conversationId,
      { id: outboxId, ...message, handedOffAt },
      { claimQueued: fromQueue?.id, replacing },
    );
    if ((fromQueue || replacing) && !(await handed)) return;
    const settleOutbox = (failure?: FailedSend) =>
      outboxStore.settle(conversationId, outboxId, failure);
    if (stillHere()) setSending(true);
    try {
      if (compact) {
        await compactTurn(c);
        await settleOutbox();
        if (!stillHere()) return;
        markTurnActive(true);
        setPinnedAgentredUnavailable(false);
        return;
      }
      await sendRouted(c, message, stillHere);
      await settleOutbox();
      if (!stillHere()) return;
      setPinnedAgentredUnavailable(false);
      // 重发成功：那条失败气泡的使命完成了，撤掉。
      if (replacing) dropFailedSend(replacing);
    } catch (err) {
      /*
        这一轮还在跑,而这条带着图（见 `ImagesCannotSteer`）:一帧都没发出去,所以
        重发是干净的,但要说清等的是这一轮跑完。判据由 `sendRouted` 在**选路那一处**
        给出 —— 那里读到的 `turnActiveRef` 才是决定走 run 还是 steer 的那一份。
      */
      const failure: {
        kind: FailedSend["kind"] | "executionUnavailable";
        detail?: string;
      } =
        err instanceof ImagesCannotSteer
          ? { kind: "imageWhileRunning" }
          : classifySendFailure(err);
      const failed: FailedSend | undefined =
        failure.kind === "executionUnavailable"
          ? undefined
          : {
              id: outboxId,
              text: message.text,
              images: message.images,
              kind: failure.kind,
              detail: failure.detail,
              ...(failure.kind === "transport" ? { handedOffAt } : {}),
            };
      await settleOutbox(failed);
      // 这条消息属于**发起它的那条会话**。目标已经换了就一个字都不写：那条红气泡
      // 挂到新会话下面，它的「重发」会拿着新的 sid 把 A 的话真的发进 B。（它已经落进
      // A 的发件箱，回到 A 时就在。）
      if (!stillHere()) return;
      if (!failed) {
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
        queueFailedSend(
          message,
          failed.kind,
          failed.detail,
          outboxId,
          failed.handedOffAt,
        );
      }
    } finally {
      // 结果落库之后才放锁：别的实例看到锁空着，才会把还记着的「已交出」当成被杀。
      (await handed)?.();
      // 目标换了的话这一格已经由那次重置放下了；这里再写就成了「用 A 的结果去关
      // B 的发送中」——B 自己那次发送正转着的话会被当场关掉。
      if (stillHere()) setSending(false);
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
    //
    // 但只等**还会来**的那一份：清单已经答过（失败，或里面没有这一条）而摘要仍空，
    // 这一条就再也拼不出参数了（弱网决策 11），落到下面的失败气泡。
    const ready =
      status === "connected" && clientRef.current && summary && relayTicket;
    if (status === "connected" && !ready && (summary || summaryPending)) return;
    const queued = pendingSend;
    // 状态更新推到 effect 之后：`react-hooks/set-state-in-effect` 禁止在 effect
    // 体里裸调 setState，而这里本来就要跟着一次异步发送走。
    void (async () => {
      setPendingSend(null);
      if (ready) {
        await sendMessage(queued, undefined, queued);
        return;
      }
      // 剩下的档（lost / 机器不在 / 设备撤销）：这条永远发不出去了，与其一直排着，
      // 不如摆到用户眼前让他决定。它从来没走到对端，所以重发是干净的。
      const failure = queueFailedSend(queued, "notSent", undefined, queued.id);
      void outboxStore.failQueued(sid, failure);
    })();
    // 只跟这几样的变化走。sendMessage / queueFailedSend 每次渲染都是新函数，
    // 列进依赖会让这个 effect 每渲染跑一遍，同一条消息发好几次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, pendingSend, summary, summaryPending, relayTicket]);

  /**
   * 往流里挂一条失败气泡。重发失败时原地替换 `replacing` 那一条；`replacing` 不在流里
   * 时以它为身份新挂一条（发件箱里同一条消息始终是同一个身份）。只动这一屏的气泡，
   * 发件箱由调用方写。
   *
   * 收的是**整条消息**:图与字一起进气泡,那颗「重发」才发得出和用户写的同一条。
   */
  function queueFailedSend(
    message: ChatComposerSubmit,
    kind: FailedSend["kind"],
    detail?: string,
    replacing?: string,
    handedOffAt?: number,
  ): FailedSend {
    const next: FailedSend = {
      id: replacing ?? randomId(),
      text: message.text,
      images: message.images,
      kind,
      detail,
      ...(handedOffAt ? { handedOffAt } : {}),
    };
    // 这一条又挂回流里了：它不再算「已丢弃」。重发途中被收起（K4）或被丢弃的那条重发
    // 又失败时，不撤掉这一笔的话下面那次收起永远跳过它。
    dismissedRef.current.delete(next.id);
    setFailedSends((prev) =>
      replacing && prev.some((f) => f.id === replacing)
        ? prev.map((f) => (f.id === replacing ? next : f))
        : [...prev, next],
    );
    return next;
  }

  /*
    「可能已送达」在转录里看得见了：收起气泡，连同发件箱里那一条（规格 2026-11-25 K4）。
    判据见 deliveredFailureIds——对不上的一律留着。只撤不发：这里从不重发任何东西。

    气泡的 state 在发件箱那一笔落库之后才改（回调里写，effect 体内不写）；记进
    dismissedRef 是为了发件箱的通知晚到时不把它加回来，也让下一次重跑不再撤一遍。
  */
  useEffect(() => {
    const delivered = deliveredFailureIds(failedSends, transcript).filter(
      (id) => !dismissedRef.current.has(id),
    );
    if (delivered.length === 0) return;
    for (const id of delivered) dismissedRef.current.add(id);
    void Promise.all(
      delivered.map((id) => outboxStore.dropFailure(sid, id)),
    ).then(() =>
      setFailedSends((prev) => prev.filter((f) => !delivered.includes(f.id))),
    );
  }, [failedSends, transcript, sid]);

  function dropFailedSend(id: string) {
    dismissedRef.current.add(id);
    setFailedSends((prev) => prev.filter((f) => f.id !== id));
    void outboxStore.dropFailure(sid, id);
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
    await sendMessage(
      { text: failure.text, images: failure.images },
      failure.id,
    );
  }

  /*
    撤销排着的那一条：整条消息（字与图，原样）放回输入框（规格 2026-11-25 C 节）。

    输入框里此刻若已经有别的字（排队之后又写了一段），不盖掉它：纯文字接在后面
    （appendDraft：空行分隔），带图的把两份并成一份放回。「输入框此刻的那一份」取它
    最近一次报告的草稿（liveDraftOf），不取草稿库：库是防抖写的，刚敲的几个字还没
    落进去，存储不可用时更是什么都没有——拿它去 restoreDraft 会把它们盖掉。输入框
    挂上后还没报告过时，它的内容就是库里恢复出来的那份。够不着输入框时这一条留着
    不撤：撤了就没有地方能找回它。
  */
  async function putBackIntoComposer(message: ChatComposerSubmit) {
    const handle = composerHandleRef?.current;
    if (!handle) return;
    if (!message.images?.length) {
      handle.appendDraft(message.text);
      return;
    }
    const current =
      liveDraftOf(handle) ??
      (draftKey ? await draftStore.get(draftKey) : undefined);
    if (current && !isEmptyDraft(current)) {
      handle.restoreDraft(
        current.text.trim()
          ? `${current.text}\n\n${message.text}`
          : message.text,
        [...current.images, ...message.images],
      );
      return;
    }
    handle.restoreDraft(message.text, message.images);
  }

  function cancelPendingSend() {
    const queued = pendingSend;
    if (!queued) return;
    if (composerHandleRef && !composerHandleRef.current) return;
    setPendingSend(null);
    void outboxStore.unqueue(sid, queued.id);
    void putBackIntoComposer(queued);
  }

  return {
    sending,
    pendingSend,
    sendingMessage,
    awaitingRun: sendingMessage !== null && !sendingMessage.acknowledged,
    cancelPendingSend,
    failedSends,
    sendMessage,
    dropFailedSend,
    retryFailedSend,
  };
}
