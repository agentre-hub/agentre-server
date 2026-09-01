import { rpcMethods } from "@agentre-hub/agentre-wire";
import { decodeSessionPendingWaitersResult } from "@agentre-hub/agentre-wire";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { interactiveRequestIds } from "@agentre-hub/agentre-ui";
import type { TranscriptMessage } from "@agentre-hub/agentre-ui";

import type { DecisionPanelPorts } from "@/components/session/DecisionPanel";
import type {
  PendingAskQuestionShape,
  PendingToolPermissionShape,
} from "@/lib/waiterBlocks";
import type { RelayClient } from "@/lib/relayClient";
import { createServerTranscriptPorts } from "@/lib/transcriptPorts";

export interface Waiters {
  toolPermissions: PendingToolPermissionShape[];
  askUserQuestions: PendingAskQuestionShape[];
}

export interface SessionDecisionPortsParams {
  sid: string;
  clientRef: RefObject<RelayClient | null>;
  originRef: RefObject<string | undefined>;
}

/** 详情视图从这一族拿到的东西。 */
export interface SessionDecisionPorts {
  /** 那台机器此刻真正阻塞着的待决清单。 */
  waiters: Waiters;
  /** 刚刚发现已被别的端回答过的那一条（R10）。 */
  handledRequestId: string | null;
  /** 目标会话换了。由详情视图的渲染期重置调用。 */
  reset: () => void;
  /**
   * 重新问一次待决清单。返回 null = 这一次没问出来（不是「没有待决策」）。
   * 身份随 sid 变，可以直接进 effect 的依赖。
   */
  refreshWaiters: () => Promise<Waiters | null>;
  /**
   * 给实时回调用的稳定入口。中继那几个回调在 useRelayMachine 首次调用时就定了型，
   * 拿不到后来渲染的 refreshWaiters —— 这一只每次都读最新那个。
   */
  requestWaitersRefresh: () => void;
  /** 待决策面板注入的两个端口（带 R10 预检 + toast 收尾）。 */
  panelPorts: DecisionPanelPorts;
  /** 转录里那些能点的卡用的端口（不预检、不吞异常）。 */
  transcriptPorts: ReturnType<typeof createServerTranscriptPorts>;
}

/**
 * 待决策的两条提交路径与它们背后的那份清单。
 *
 * 面板与转录打的是同两个 RPC，却**不能**共用一个端口对象（见 panelPorts 与
 * transcriptPorts 各自的说明），所以两者与 waiters 一起整片归这里。
 */
export function useSessionDecisionPorts({
  sid,
  clientRef,
  originRef,
}: SessionDecisionPortsParams): SessionDecisionPorts {
  const { t } = useTranslation();
  const [waiters, setWaiters] = useState<Waiters>({
    toolPermissions: [],
    askUserQuestions: [],
  });
  /**
   * 刚刚发现已被别的端回答过的那一条（R10）。
   *
   * 它是**页面级**的，不是那张卡自己的错误态：预检要刷一次 waiters，而「已被别的
   * 端答过」的直接后果就是这条待决从清单里消失、卡片随之卸载。挂在卡上等于挂在
   * 一个正要消失的东西上。见 DecisionPanel 文件头。
   */
  const [handledRequestId, setHandledRequestId] = useState<string | null>(null);

  const refreshWaiters = useCallback(async (): Promise<Waiters | null> => {
    const c = clientRef.current;
    if (!c) return null;
    try {
      const raw = await c.request(rpcMethods.sessionPendingWaiters, {
        conversationId: sid,
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
      });
      const res = decodeSessionPendingWaitersResult(raw);
      const next: Waiters = {
        toolPermissions: (res.toolPermissions ??
          []) as PendingToolPermissionShape[],
        askUserQuestions: (res.askUserQuestions ??
          []) as PendingAskQuestionShape[],
      };
      setWaiters(next);
      // 「已被处理」是对**那一条**待决策的说明,不是页面的永久状态:新的待决策上来
      // 之后还挂着,就成了「已被处理」与一张真等着人批的卡并排自相矛盾。
      if (next.toolPermissions.length > 0 || next.askUserQuestions.length > 0) {
        setHandledRequestId(null);
      }
      return next;
    } catch {
      // 拉不到是「没问出来」,不是「没有待决策」:回 null 让调用方自己分辨,
      // 别把一次 RPC 失败当成待决策已经被处理。
      return null;
    }
    // 两只 ref 都是稳定引用，列进依赖只为如实交代读了什么。
  }, [sid, clientRef, originRef]);

  const refreshWaitersRef = useRef(refreshWaiters);
  // 每次渲染后把最新 refreshWaiters 收进 ref，供实时回调（onRunResultDone 等）调用。
  useEffect(() => {
    refreshWaitersRef.current = refreshWaiters;
  });

  /**
   * 待决策面板那些卡的提交路径。
   *
   * 它与转录里那些卡打的是同两个 RPC（见下面的 `transcriptPorts`），但**多做两件
   * 宿主该做的事**，而这两件正是它不能与转录共用一个端口对象的原因：
   *
   *  1. **R10 预检**：提交前先确认这条待决还在。已被别的端回答过 → 抛出那句话，
   *     由卡片就地显示，而不是让 daemon 回一句 "no waiting tool permission"
   *     原样漏到界面上。
   *  2. **决策 8**：提交**失败**走 toast + 重试，**不**在版面里长出一行红字。
   *     所以这一层吞掉异常、不再抛给卡片——包的契约是「包内不吞」，宿主怎么处理
   *     是宿主的产品决策，而这一条早已裁过。
   *
   * 转录里的卡不走这条：它的只读态由 `tool_permission_resolved` 回填，不需要预检；
   * 失败也该冒泡给它自己的错误态（那张卡在流里，toast 与它离得远）。
   */
  async function runPanelDecision(
    requestId: string,
    doSubmit: () => Promise<unknown>,
  ) {
    setHandledRequestId(null);
    const before = await refreshWaiters();
    // before 为 null = 预检这一次没问出来（RPC 失败），不是「已经被处理」。当成
    // 已处理收场会把这次决策静默丢掉，而那边的工具还阻塞着。问不出来就照常提交，
    // 重复提交由 daemon 的幂等收敛（R8）。
    const answered =
      before !== null &&
      !before.toolPermissions.some((w) => w.RequestID === requestId) &&
      !before.askUserQuestions.some((w) => w.RequestID === requestId);
    if (answered) {
      setHandledRequestId(requestId);
      return;
    }
    try {
      await doSubmit();
    } catch {
      /*
        提交没发出去（socket 刚断等）：**要出声**——按钮点下去什么都不发生会让用户
        以为批准生效了，而工具还阻塞在那台机器上。

        走 toast 而不是在版面里长出一行 11px 红字（规格 2026-08-21 决策 8）：
        这是对**刚才那一次点击**的回执，属于时间不属于版面。而且此前那行字出现时
        按钮还亮着，用户不确定该不该再点；toast 自带的「重试」把那件事说清楚。

        吞掉而不是继续抛：抛上去卡片会**再**把同一件事印在自己的错误态里，
        同一次失败说两遍，其中一遍正是决策 8 要去掉的那一行。
      */
      toast.error(t("session.decision.submitFailed"), {
        action: {
          label: t("session.decision.retry"),
          onClick: () => void runPanelDecision(requestId, doSubmit),
        },
      });
    } finally {
      await refreshWaiters();
    }
  }

  /**
   * 面板注入的两个端口。形状就是包的端口形状——`DecisionPanel` 不做转换，
   * 转换（camelCase → daemon 的 PascalCase）在下面 `submitAnswerPort` 同一处。
   */
  const panelPorts = useMemo<DecisionPanelPorts>(
    () => ({
      // 与 transcriptPorts 同一条理由：ref 只在**事件回调**里读，不在渲染期。
      async answerToolPermission(input) {
        await runPanelDecision(input.requestId, () =>
          clientRef.current!.request(rpcMethods.runtimeSubmitToolPermission, {
            conversationId: sid,
            ...(originRef.current
              ? { peerFingerprint: originRef.current }
              : {}),
            requestId: input.requestId,
            allow: input.allow,
            alwaysAllowSession: input.alwaysAllowSession ?? false,
            denyReason: input.denyReason,
          }),
        );
      },
      async answerUserQuestion(input) {
        await runPanelDecision(input.requestId, () =>
          clientRef.current!.request(rpcMethods.runtimeSubmitAnswer, {
            conversationId: sid,
            ...(originRef.current
              ? { peerFingerprint: originRef.current }
              : {}),
            requestId: input.requestId,
            answers: (input.answers ?? []).map((a) => ({
              questionIndex: a.questionIndex,
              labels: a.labels,
              otherText: a.otherText ?? "",
            })),
            skipped: input.skipped ?? false,
          }),
        );
      },
    }),
    // 依赖只留 sid，与 transcriptPorts 同一条理由：端口对象每次渲染都换新的话，
    // 包内 Provider 下游的 memo 会被白白打掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sid],
  );

  /**
   * 转录里那些**能点**的卡用的端口。
   *
   * 与上面 `panelPorts` 打的是同两个 RPC，但**不共用**它：那一层为待决策面板做了
   * R10 预检、并把失败收进 toast（决策 8）。这里两件都不该做 —— 卡片的只读态由
   * `tool_permission_resolved` 回填，不需要预检；失败要冒泡给它自己的错误态
   * （包的契约：「包内不吞异常、不做 toast，提示文案属于宿主的产品决策」），
   * 因为这张卡在转录流里，可能已经滚出视野，toast 与它离得远。
   *
   * 提交完照样刷一次 waiters：DecisionPanel 还在同屏，两边看的是同一份待决清单。
   *
   * 两个提交写成组件体里的普通函数、只把引用喂进 useMemo：ref 的读取因此发生在
   * 事件回调里而不是 useMemo 的工厂里（工厂是在**渲染期**跑的，
   * react-hooks 的「Cannot access refs during render」正是拦这个）。
   */
  async function submitToolPermissionPort(input: {
    requestId: string;
    allow: boolean;
    alwaysAllowSession?: boolean;
    denyReason?: string;
  }) {
    const res = await clientRef.current!.request(
      rpcMethods.runtimeSubmitToolPermission,
      {
        conversationId: sid,
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
        requestId: input.requestId,
        allow: input.allow,
        alwaysAllowSession: input.alwaysAllowSession,
        denyReason: input.denyReason,
      },
    );
    void refreshWaiters();
    return res;
  }

  async function submitAnswerPort(input: {
    requestId: string;
    answers?: { questionIndex: number; labels: string[]; otherText?: string }[];
    skipped?: boolean;
  }) {
    const res = await clientRef.current!.request(
      rpcMethods.runtimeSubmitAnswer,
      {
        conversationId: sid,
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
        requestId: input.requestId,
        // 包的端口用 camelCase，daemon 的 submitAnswer 收的是 PascalCase
        // （`AskAnswerSubmit`）。两边形状不同，所以这里显式搬字段而不是强转 ——
        // 强转能过 tsc，但发出去的是一份字段全是 undefined 的答案，表现是
        // 「提交成功了，那台机器上却还阻塞着」。
        answers: (input.answers ?? []).map((a) => ({
          questionIndex: a.questionIndex,
          labels: a.labels,
          otherText: a.otherText ?? "",
        })),
        skipped: input.skipped ?? false,
      },
    );
    void refreshWaiters();
    return res;
  }

  const transcriptPorts = useMemo(
    () =>
      // 两个提交只在**事件回调**里读 clientRef / originRef（用户点了审批卡的
      // 按钮才跑），不在渲染期。react-hooks/refs 是传递分析，看不穿这层间接，
      // 只看到「一个会读 ref 的函数被传进了渲染期跑的工厂」。

      createServerTranscriptPorts({
        submitToolPermission: (input) => submitToolPermissionPort(input),
        submitAnswer: (input) => submitAnswerPort(input),
      }),
    // 依赖只留 sid：两个提交的行为只随会话变。把函数本身放进依赖会让端口对象
    // 每次渲染都换一个新的，白白打掉包内 Provider 下游的 memo。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sid],
  );

  /** 目标会话换了：待决清单与「已被别的端处理」都属于**那一条**，跟着重来。 */
  const reset = useCallback(() => {
    setWaiters({ toolPermissions: [], askUserQuestions: [] });
    setHandledRequestId(null);
  }, []);

  const requestWaitersRefresh = useCallback(() => {
    void refreshWaitersRef.current();
  }, []);

  return {
    waiters,
    handledRequestId,
    reset,
    refreshWaiters,
    requestWaitersRefresh,
    panelPorts,
    transcriptPorts,
  };
}

/**
 * 交给 DecisionPanel 的，只剩**转录自己画不出来**的那些待决。
 *
 * 转录里的审批卡与提问卡现在是能点的（归约器产出 canonical 之后），所以两边
 * 都显示同一条待决 = 同一个审批在屏幕上出现两次。但 DecisionPanel 不能删：
 * 两份清单来源不同 —— 卡来自事件流（浏览器手上有那一帧才画得出来），waiters
 * 来自一次 RPC（那台机器此刻真正阻塞着的是哪些）。镜像日志被裁剪、或浏览器
 * 从中途接进来时会有「waiters 里有、事件流里没有」的待决，那种只有它兜得住。
 */
export function selectPanelWaiters(
  messages: TranscriptMessage[],
  waiters: Waiters,
): Waiters {
  const shown = interactiveRequestIds(messages);
  return {
    // RequestID 是 optional（daemon 的 omitempty）。没有 id 的待决对不上转录里
    // 任何一张卡，所以一律留给 DecisionPanel —— 去重的前提是认得出是同一条。
    toolPermissions: waiters.toolPermissions.filter(
      (w) => !w.RequestID || !shown.has(w.RequestID),
    ),
    askUserQuestions: waiters.askUserQuestions.filter(
      (w) => !w.RequestID || !shown.has(w.RequestID),
    ),
  };
}
