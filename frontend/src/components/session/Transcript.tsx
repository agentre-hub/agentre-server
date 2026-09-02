import {
  applyLiveTranscriptRows,
  buildSettledTranscriptRows,
  buildSourceByMessageId,
  estimateRowSizeWithSpacing,
  indicatorHostMessageId,
  transcriptRowPadClass,
  MESSAGE_AVATAR_CLASS,
  TranscriptPortsProvider,
  TranscriptRenderContext,
  TranscriptRowView,
  TranscriptUIStateProvider,
  type LiveTurnInput,
  type TranscriptMessage,
  type TranscriptRow,
  type TranscriptPorts,
  type TranscriptRenderContextValue,
  cn,
} from "@agentre-hub/agentre-ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LiveTurnTiming } from "@/components/session/liveTurnTiming";
import { createServerTranscriptPorts } from "@/lib/transcriptPorts";

/**
 * R8 转录渲染。**整条路径与桌面端同源**：消息经 `buildSettledTranscriptRows`
 * 排成行、`TranscriptRowView` 渲染，与桌面端是同一批组件、同一个函数。
 *
 * 输入是包的 `TranscriptMessage[]`，由共享包 `@agentre-hub/agentre-ui` 的
 * `reduceFrames()` 从 wire 事件帧归约而来 —— 桌面端喂进来的是 Go 侧 chat_svc
 * 落库后的块，两边形状对上了，组件就通用。
 *
 * 这里因此**没有**本站自己的渲染分支。此前有一整套：本站先归约成一个自造的扁平
 * `TranscriptItem`，再把包认不出的形态「切段交还本站」自己画（raw JSON 卡、决策
 * 条、孤儿工具结果、轮次分隔线）。那些块不在包的对话列里（包 720px、本站 768px），
 * 而且每切一段就重开一条消息 —— 一轮助手被劈成好几条，各自长出一个头像抬头。
 * 归约目标换成包的 DTO 之后，这两件事一起没了，不是分别修好的。
 *
 * 中转事件流是「到一条画一条」，没有桌面端那种「已落库 / 未落库」的分界，所以
 * `liveBlocks` / `liveRetry` 恒为空值 —— 那两样表达的正是那条分界。
 *
 * 但 `liveTail` 是接的：包只在 liveTail 那一段上标 `streaming`，而只有标了
 * `streaming` 的文本才走 `StreamingMarkdown`（增量切分 + 分段 memo）。不接，
 * 每来一个 token 就要把整段 markdown 连同 highlight.js 的语言探测重跑一遍。
 * 尾巴由下面那个 useMemo 从仍在生长的那条消息上摘下来，再由叠加原样接回去。
 *
 * 但**指示器**是另一回事。三点说的是「对端还在生成」，与正文是不是一帧一帧长出来
 * 无关：一轮跑起来到第一帧回来之间可以隔很久，少了它用户对着一段不动的转录分不清
 * 是在跑还是发丢了。所以 `showIndicator` / `reconnecting` 由宿主给（见下面两个
 * prop），`compacting` 仍恒为 false —— 中转流里的 `runtime_status` 帧本站还没归约
 * （包的 `reduceFrames`），编一个出来等于对用户撒谎。
 */
export default function Transcript({
  messages,
  sessionId,
  localFingerprint,
  ports = READ_ONLY_PORTS,
  agentName,
  agentAvatar,
  agentPending = false,
  fallbackModel = "",
  liveTurnTiming = null,
  streaming = false,
  pendingAssistant = false,
  reconnecting = false,
  getScrollElement,
}: {
  messages: TranscriptMessage[];
  sessionId: number;
  /**
   * 卡片按下去会发生什么。缺省是一组**如实抛错**的桩：转录本身是只读的，
   * 能点的卡才需要动作，而「忘了接线」必须当场炸出来而不是点了没反应。
   */
  ports?: TranscriptPorts;
  /**
   * 这台浏览器在中继上的标识。用来判断一条用户消息是不是**别的**设备发的 ——
   * 只有别的设备发的才标来源（「From iPhone」）。给不出时保守不标。
   */
  localFingerprint?: string;
  /**
   * 这条会话所属 Agent 的名字与头像节点。由宿主给：包不认识任何一端的身份模型，
   * 而「哪个 Agent」这件事住在 SessionSummary 的 agentSyncId 上、要另取一次
   * 清单才解得开——那是详情页的活，不是转录的。
   *
   * 解不出来时（老会话没有 agentSyncId、或清单取不到）退回中性的抬头与方块，
   * 不猜名字。
   */
  agentName?: string;
  agentAvatar?: React.ReactNode;
  /**
   * 这条对话**已知**有 Agent，但名字还没解开（账号的 Agent 清单还在路上）。
   *
   * 为 true 时不退回中性抬头：退回去的那个名字注定要被换掉，用户看到的是抬头和
   * 头像闪一下（「助手」→ 真名）。此时改摆一枚不写字的占位方块 —— 位置照留（不
   * 抖版），但一个字都不说，等解开了一次到位地填进去。
   *
   * 名字**解不出来**是另一回事（老会话没有 agentSyncId、或清单取不到）：那不是
   * 空窗而是终局，照旧退回中性抬头。
   */
  agentPending?: boolean;
  /**
   * 这条对话此刻钉的模型名，用在还没收到终态帧的那一轮上。
   *
   * 消息自己的 `model` 只有 `runtime.runResultDone` 这一条来路（wire 上的 usage 帧
   * 没有这个字段），而那一帧要等一轮跑完才来。不给这个回退，流式期间模型那一格
   * 是空的，等 done 到了再「跳」出一个名字 —— 而底栏那颗 pill 从头到尾都在显示它。
   * 与桌面端 `chat.tsx` 交给行渲染器的是同一样东西。
   */
  fallbackModel?: string;
  /**
   * 还在跑的这一轮的计时（宿主从帧流上攒的，见 `useLiveTurnTiming`）。
   *
   * 给了它，包里那条 meta 才会开表：耗时自己走、首帧没回来时说「已经等了多久」、
   * tok/s 现算。不给（历史转录、以及接进来时对端已经在跑的那种轮次）就只画终态帧
   * 上的那几个数 —— 那正是此前的样子：一轮跑完才出数。
   *
   * 只是计时那一半。token 列从消息自己身上取（`usage` 帧逐跳喂进来的那一列），
   * 正在长的正文取 `liveTail`：两样这里都有，不必让宿主再送一遍。
   */
  liveTurnTiming?: LiveTurnTiming | null;
  /**
   * 这条会话此刻有没有一轮在跑。为 true 时最后一条助手消息末尾出三点。
   *
   * 缺省 false：「只读转录」是一个合法形态（共享包 `live-state` 的注释点名说了
   * 这件事），历史会话不该无缘无故永远转着三个点。
   */
  streaming?: boolean;
  /** 新一轮尚未收到首帧时，把指示器放进独立的 assistant 占位消息。 */
  pendingAssistant?: boolean;
  /**
   * 中继通道断了、正在重连。与 `streaming` 一起为 true 时，三点换成断连形态。
   *
   * 顺序是共享包定的契约：通道断了就先说通道 —— 此刻「还在不在生成」根本观察
   * 不到，继续转三个点是在替远端撒谎。
   */
  reconnecting?: boolean;
  /**
   * 取转录所在的那条滚动带。行虚拟化拿它当滚动容器与视口。
   *
   * 是取值函数而不是元素本身：宿主把元素放进 state 会在挂载时多打一次渲染，
   * 而右栏正在切换时那一次会把刚挂上的详情掀掉（见 SessionDetailView 那侧的注释）。
   *
   * 取不到时整列渲染 —— 见下面 `windowed` 那段。
   */
  getScrollElement?: () => HTMLElement | null;
}) {
  const { t } = useTranslation();

  const fallbackName = t("session.transcript.assistant");
  const renderCtx = useMemo<TranscriptRenderContextValue>(
    () => ({
      // 空串是包认得的「这一行不写抬头」（transcript-row-view 的 author ?? ""）。
      agentName: agentName ?? (agentPending ? "" : fallbackName),
      agentAvatar: agentAvatar ?? (
        <span
          aria-hidden="true"
          className={cn(
            MESSAGE_AVATAR_CLASS,
            "inline-flex shrink-0 items-center justify-center bg-muted font-semibold text-muted-foreground",
          )}
        >
          {agentPending ? "" : fallbackName.charAt(0)}
        </span>
      ),
      sessionId,
    }),
    [sessionId, fallbackName, agentName, agentAvatar, agentPending],
  );

  const displayMessages = useMemo(() => {
    const last = messages.at(-1);
    if (!streaming || !pendingAssistant) return messages;
    const nextId =
      messages.reduce((max, message) => Math.max(max, message.id), 0) + 1;
    return [
      ...messages,
      {
        id: nextId,
        sessionId,
        role: "assistant",
        blocks: [],
        model: "",
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalInputTokens: 0,
        durationMs: 0,
        errorText: "",
        seq: last?.seq ?? 0,
        createtime: last?.createtime ?? 0,
      },
    ];
  }, [messages, pendingAssistant, sessionId, streaming]);

  /**
   * 三点的宿主。规则归共享包所有 —— 桌面端 `chat.tsx` 挂的是同一条，此前两端各写
   * 一份，而本站这份已经漂开过：它「从后往前找最后一条助手消息」，会越过中间的
   * 用户消息挂到**上一轮**的回复上。判据见包里 `generating-indicator.ts`。
   *
   * 喂进去的是 `displayMessages` 而不是 `messages`：末条是用户消息时该出现的是
   * 新一轮的占位（`pendingAssistant`），而占位只在前者里。
   */
  const lastAssistantId = useMemo(
    () => indicatorHostMessageId(displayMessages),
    [displayMessages],
  );

  /**
   * 行缓存。包里 `TranscriptRowView` 是 `React.memo`，它成立的前提写在
   * `transcript-rows.d.ts` 的 `cache` 字段上：「persisted 消息的 blocks 引用稳定 →
   * 缓存命中返回同一 row 对象数组 → 行组件 React.memo 恒命中」。
   *
   * 不传它，每次重渲染都是全部行现场重建，memo 一次也命中不了；每渲染新建一个
   * 也一样。引用稳定那一半由 `createTranscriptProjector` 负责（没被这一批帧改到
   * 的消息保持同一个引用），两半缺一不可。
   */
  // 用 useState 的惰性初始化而不是 useRef:ref 不该在 render 期读(react-hooks 的
  // no-access-ref-during-render),而 useState 的初值只跑一次、跨渲染稳定,正合适。
  const [rowCache] = useState(
    () => new WeakMap<TranscriptMessage, TranscriptRow[]>(),
  );

  // 从前这张表是在下面的 useMemo 里现建的，于是每次渲染都是新引用，settled 的
  // memo 等于没设。
  const sourceByMessageId = useMemo(
    () => buildSourceByMessageId(messages, localFingerprint),
    [messages, localFingerprint],
  );

  /**
   * 仍在生长的那条助手消息，以及从它身上摘下来的尾巴文本。
   *
   * 包里的分流在 `transcript-row-view` 上：`item.streaming ? <StreamingMarkdown/>
   * : <MessageBody/>`，而 `streaming` 只由 `liveTail` 那一段标出来
   * （`transcript-rows` 的 `appendText(liveTail, true)`）。不把尾巴单独交出去，
   * 这条路径就永远走不到 —— 每来一个 token 都要把整段 markdown 连同 highlight.js
   * 的语言探测重跑一遍，开销 O(n²)。`StreamingMarkdown` 把它切成「已定稿的若干段
   * + 还在长的尾巴」，各段各自 memo，单 chunk 的开销因此降到 O(Δ)。
   *
   * 摘的是**末尾那个 text 块**，再由叠加原样接回去（包的 appendText 会并回同一段
   * 文本项），所以画面上一个字不多也不少。轮次结束后 `streaming` 转假，这条消息
   * 走回普通的整段渲染 —— 包的注释也说了，切分的近似会在那一刻自愈。
   */
  const liveMessageId = streaming ? lastAssistantId : null;
  const { settledMessages, liveByMessageId } = useMemo(() => {
    const target =
      liveMessageId == null
        ? undefined
        : displayMessages.find((message) => message.id === liveMessageId);
    const tail = target?.blocks.at(-1);
    if (!target || tail?.type !== "text" || !tail.text) {
      return { settledMessages: displayMessages, liveByMessageId: EMPTY_LIVE };
    }
    return {
      settledMessages: displayMessages.map((message) =>
        message === target
          ? { ...message, blocks: message.blocks.slice(0, -1) }
          : message,
      ),
      liveByMessageId: new Map([[target.id, { liveTail: tail.text }]]),
    };
  }, [displayMessages, liveMessageId]);

  /**
   * 交给包的那份「这一轮此刻是什么样」。
   *
   * 计时由宿主攒（帧流是它的），token 列与正在长的正文从这条消息自己身上取 ——
   * 前者是 `usage` 帧逐跳喂进来的那一列，后者就是上面摘下来的尾巴，两样这里都有，
   * 不必让宿主再送一遍。
   *
   * `model` 刻意留空：一轮跑完之前 wire 上根本没有这个字段，包会自己退到行渲染器的
   * `fallbackModel`（桌面端交出去的也是空串，同一条路）。
   */
  const liveTurn = useMemo<LiveTurnInput | null>(() => {
    if (!liveTurnTiming || liveMessageId == null) return null;
    const target = displayMessages.find(
      (message) => message.id === liveMessageId,
    );
    if (!target) return null;
    return {
      ...liveTurnTiming,
      promptTokens: target.promptTokens,
      completionTokens: target.completionTokens,
      cachedTokens: target.cachedTokens,
      cacheCreationTokens: target.cacheCreationTokens,
      reasoningTokens: target.reasoningTokens,
      model: "",
      liveText: liveByMessageId.get(liveMessageId)?.liveTail ?? "",
    };
  }, [displayMessages, liveByMessageId, liveMessageId, liveTurnTiming]);

  const settled = useMemo(
    () =>
      buildSettledTranscriptRows({
        displayMessages: settledMessages,
        // 自主续轮是桌面端才有的形态（后台任务完成后 CLI 自己接着跑），
        // 中转流里不存在。
        autonomousIds: EMPTY_IDS,
        sourceByMessageId,
        cache: rowCache,
      }),
    [settledMessages, sourceByMessageId, rowCache],
  );

  const rows = useMemo(
    () =>
      applyLiveTranscriptRows(settled, {
        displayMessages: settledMessages,
        autonomousIds: EMPTY_IDS,
        liveByMessageId,
        sourceByMessageId,
        cache: rowCache,
      }).rows,
    [settled, settledMessages, liveByMessageId, sourceByMessageId, rowCache],
  );

  /**
   * 行虚拟化。一条长对话有上千行，此前全部常驻 DOM —— 内存与每次强制同步布局
   * （详情页的钉底 effect 每帧要读一次 scrollHeight）都按行数线性增长。
   *
   * 两条与滚动相关的配置都不是可选项：
   *
   * - `anchorTo: "end"` + `scrollEndThreshold`：流式贴底交给虚拟器自己的测量回路。
   *   详情页那条「pin 时 scrollTop = scrollHeight」的 effect 读的是**复测之前**的
   *   getTotalSize，虚拟化之后它会永远慢一帧（最新输出被压到折叠线以下）。阈值取
   *   与详情页 AT_BOTTOM_SLACK 同一个数，两边对「在不在底部」的判断才一致。
   * 往回翻加载更早的内容时，新插进来的行先按估算高度占位、随后才被实测，落在视口
   * 上方的那些行一改高就会把用户正在看的那一行推走。这件事**不用自己接**：
   * virtual-core 的缺省判据已经分了两档 —— 首次测量补偿所有顶边在视口之上的行
   * （正是前插这一档），复测则只补偿**整行都在视口之上**的，且反向滚动时不补。
   * 覆写成「一律补偿」反而会让流式增长时视口被一路往下拽（上游 #1218）。
   *
   * `getItemKey` 取行的 key 而不是下标：前插之后同一行的下标全变了，按下标缓存
   * 测量结果会让每一行都拿到别人的高度。
   */
  // 豁免理由:虚拟器的测量回调本来就是可变的(measureElement / getVirtualItems
  // 每次测量之后都换),React Compiler 把它 memo 掉会交出过期的行窗口。
  // 桌面端 chat.tsx 在同一处挂的是同一条豁免。
  //
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) => estimateRowSizeWithSpacing(rows, index),
    getItemKey: (index) => rows[index]?.key ?? index,
    getScrollElement: () => getScrollElement?.() ?? null,
    overscan: TRANSCRIPT_OVERSCAN,
    anchorTo: "end",
    scrollEndThreshold: AT_BOTTOM_SLACK_PX,
  });

  /**
   * 量不出视口高度时整列渲染。
   *
   * 这与详情页「够不够一屏」那条 effect 是同一条原则：量不出高度是**「不知道」而
   * 不是「视口为零」**——判成后者会一行都画不出来（容器此刻是折叠的、还没布局、
   * 或者根本在 jsdom 里）。渲染的是同一段 JSX，区别只在「取哪些下标、要不要绝对
   * 定位」。
   *
   * 量的是 `offsetHeight` 而不是 `clientHeight`：virtual-core 的 observeElementRect
   * 读的就是它。两处量不同的属性时，会出现「这里判定开窗、虚拟器却算出零个可见行」
   * ——转录整个变空。
   */
  const windowed = (getScrollElement?.()?.offsetHeight ?? 0) > 0;
  const placements = windowed
    ? virtualizer
        .getVirtualItems()
        .map((item) => ({ index: item.index, offset: item.start }))
    : rows.map((_, index) => ({ index, offset: null as number | null }));

  // 判空看的是 `displayMessages` 而不是 `messages`：一条刚开的对话在第一帧回来
  // 之前 `messages` 就是空的，而此刻正是最该出三点的时候。看 `messages` 的话
  // 占位消息根本走不到渲染，用户发完第一句面对的是「还没说过话」。
  if (displayMessages.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t("session.transcript.empty")}
      </p>
    );
  }

  return (
    // 三个 Provider 是包内组件的前置：端口（宿主能力）、转录局部 UI 态
    // （折叠/展开，按 uiStateKey 存活过重渲染）、会话级静态渲染依赖。
    <TranscriptPortsProvider ports={ports}>
      <TranscriptUIStateProvider>
        <TranscriptRenderContext.Provider value={renderCtx}>
          <div
            data-testid="session-detail-transcript"
            data-transcript-spacer={windowed ? "" : undefined}
            style={
              windowed
                ? { height: virtualizer.getTotalSize(), position: "relative" }
                : undefined
            }
          >
            {placements.map(({ index, offset }) => {
              const row = rows[index];
              return (
                <div
                  key={row.key}
                  // 虚拟器的 measureElement 靠 data-index 认行（virtual-core 的
                  // indexAttribute 缺省就是它）。
                  data-index={index}
                  ref={windowed ? virtualizer.measureElement : undefined}
                  data-row-pad=""
                  // 「回到底部」药丸靠它定位视口下沿那条消息，据此数出「下面还有
                  // N 轮」（共享包的 computeBottomVisibleMessageId）。桌面端的行外层
                  // 挂的是同一个属性。
                  data-message-id={row.messageId}
                  // 间距必须打在**被测量的这一层**上：estimateRowSizeWithSpacing
                  // 算的就是「内容高度 + 这个 padding」，分开两层会让估算与实测
                  // 各差一个间距。
                  className={transcriptRowPadClass(rows, index)}
                  style={
                    offset == null
                      ? undefined
                      : {
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${offset}px)`,
                        }
                  }
                >
                  <TranscriptRowView
                    row={row}
                    // 只有 live 消息的**末行**承载还在长的尾巴;其余行一律收敛到
                    // 稳定空值,让 TranscriptRowView 的 memo 浅比较恒命中。
                    liveTail={liveTailOf(liveByMessageId, row)}
                    liveBlocks={undefined}
                    liveRetry={null}
                    // 同上：只有正在跑的那条消息的**末行**画 meta，其余行收敛到
                    // 稳定空值。
                    liveTurn={
                      row.isLastOfMessage && row.messageId === liveMessageId
                        ? liveTurn
                        : null
                    }
                    showIndicator={
                      row.isLastOfMessage &&
                      streaming &&
                      row.messageId === lastAssistantId
                    }
                    compacting={false}
                    reconnecting={reconnecting}
                    fallbackModel={fallbackModel}
                  />
                </div>
              );
            })}
          </div>
        </TranscriptRenderContext.Provider>
      </TranscriptUIStateProvider>
    </TranscriptPortsProvider>
  );
}

/** 视口上下各多挂几行，滚动时不至于滚到空白再补。 */
const TRANSCRIPT_OVERSCAN = 6;

/**
 * 「算在底部」的容差，取与 SessionDetailView 的 AT_BOTTOM_SLACK 同一个数：
 * 虚拟器的贴底判断与详情页的 pin 判断必须说同一件事，否则会出现「药丸说不在底部、
 * 内容却被钉着往下走」这种自相矛盾的形态。
 */
const AT_BOTTOM_SLACK_PX = 24;

const EMPTY_IDS: ReadonlySet<number> = new Set<number>();

function liveTailOf(
  liveByMessageId: ReadonlyMap<number, { liveTail: string }>,
  row: { messageId: number; isLastOfMessage: boolean },
): string {
  if (!row.isLastOfMessage) return "";
  return liveByMessageId.get(row.messageId)?.liveTail ?? "";
}

/**
 * 「没有任何流在跑」的稳定空表。每次渲染新建一个空 Map 会让下游的 memo 全部
 * 失效——而绝大多数时间正是没有流在跑的时候。
 */
const EMPTY_LIVE: ReadonlyMap<number, { liveTail: string }> = new Map();

/**
 * 没接动作时的缺省端口。模块级常量而不是每次渲染新建 —— 换一个新对象会让
 * TranscriptPortsProvider 下游的 memo 每次都失效。
 */
const READ_ONLY_PORTS: TranscriptPorts = createServerTranscriptPorts({
  submitToolPermission: () => {
    throw new Error("Transcript rendered read-only: no submit action wired");
  },
  submitAnswer: () => {
    throw new Error("Transcript rendered read-only: no submit action wired");
  },
});
