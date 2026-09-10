import { useMemo, type ReactNode, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import {
  Alert,
  AlertDescription,
  Button,
  countTurnsAfterMessage,
  TranscriptJumpControl,
  TranscriptSkeleton,
  type TranscriptMessage,
} from "@agentre-hub/agentre-ui";

import DecisionPanel from "@/components/session/DecisionPanel";
import PendingSendBubble from "@/components/session/PendingSendBubble";
import SendFailureBubble from "@/components/session/SendFailureBubble";
import SessionStatusBanner from "@/components/session/SessionStatusBanner";
import { TranscriptSessionId } from "@/components/session/transcriptFrame";
import Transcript from "@/components/session/Transcript";
import {
  selectPanelWaiters,
  type SessionDecisionPorts,
} from "@/components/session/useSessionDecisionPorts";
import type { LiveTurnTiming } from "@/components/session/liveTurnTiming";
import type { SessionSend } from "@/components/session/useSessionSend";
import type { EarlierState } from "@/components/session/useTranscriptScrollback";
import type { SessionViewStatus } from "@/lib/sessionView";

export interface SessionScrollBodyProps {
  sid: string;
  /** 这条滚动带本身。滚动位置、前插补偿与续读触发都由 useTranscriptScrollback 量。 */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 滚动带里面那一层内容。跟随期间它一长高就得跟着钉底，见 useTranscriptScrollback。 */
  contentRef: (node: HTMLDivElement | null) => void;
  onScroll: () => void;
  /**
   * 用户对这条带子动手了。滚动事件本身说不出这个：虚拟器复测行高时自己就会把位置
   * 往回挪，和上滚在位置上同形（见 useTranscriptScrollback 的 userIntentUntilRef）。
   */
  onUserScroll: () => void;
  getScrollElement: () => HTMLDivElement | null;
  atBottom: boolean;
  /** 视口下沿那条消息；「下面还有 N 轮」从它之后数起。 */
  bottomVisibleId: number | null;
  jumpToBottom: () => void;
  earlier: EarlierState;
  /** 撞上顶补封顶之后那个能点的入口。 */
  onLoadEarlier: () => void;

  status: SessionViewStatus;
  machineName: string | undefined;
  machineLastSeenMs: number | undefined;
  /** 对端拒绝握手时它自己那句说明，见 SessionStatusBanner。 */
  protocolMismatchDetail: string | undefined;
  onReconnect: () => void;
  /** 中继此刻的连线状态。转录的三点要它才知道该不该继续转。 */
  relayState: string;
  /** server 镜像里的历史读到哪一步。 */
  history: { settled: boolean; loaded: boolean };
  /**
   * 转录里那一条是**草稿页刚发出去的接力消息**，不是投影出来的（见
   * SessionDetailView 的 `initialUserText`）。
   *
   * 它算「有东西可画」：骨架说的是「什么都还没有」，而这里手上正拿着用户几百毫秒前
   * 说的那句话。「正在从这台机器读取…」那句同样让位 —— 三点已经在说在等了。
   */
  seeded: boolean;
  ready: boolean;
  catchUpFailed: boolean;

  messages: TranscriptMessage[];
  /** 这个浏览器自己的指纹，用来分辨「哪条是我发的」。 */
  localFingerprint: string | undefined;
  agentName: string | undefined;
  /** 转录行那一档头像。在 JSX 之外算好，见 SessionDetailView 的 rowAvatar。 */
  agentAvatar: ReactNode;
  agentPending: boolean;
  /** 还没收到终态帧的那一轮，模型退到这一个（见 Transcript 的同名 prop）。 */
  fallbackModel: string;
  /** 还在跑的这一轮的计时。同上，见 Transcript 的同名 prop。 */
  liveTurnTiming: LiveTurnTiming | null;
  streaming: boolean;
  pendingAssistant: boolean;

  decisions: SessionDecisionPorts;
  send: SessionSend;
}

/**
 * 滚的只有这一带。转录、状态横幅与审批卡都在里面，头部与 Composer 都不在。
 *
 * 「有没有内容可读、在等谁、要不要摆骨架」这几档也整片归它：除了这一带没有别的
 * 读者，摊在详情视图里只会让那边多出四个只用一次的派生值。
 */
export default function SessionScrollBody({
  scrollRef,
  contentRef,
  onScroll,
  onUserScroll,
  getScrollElement,
  atBottom,
  bottomVisibleId,
  jumpToBottom,
  earlier,
  onLoadEarlier,
  status,
  machineName,
  machineLastSeenMs,
  protocolMismatchDetail,
  onReconnect,
  relayState,
  history,
  seeded,
  ready,
  catchUpFailed,
  messages,
  localFingerprint,
  agentName,
  agentAvatar,
  agentPending,
  fallbackModel,
  liveTurnTiming,
  streaming,
  pendingAssistant,
  decisions,
  send,
}: SessionScrollBodyProps) {
  const { t } = useTranslation();
  const nav = useNavigate();

  /**
   * 视口下沿之后还开了几轮 —— 药丸靠它说出「你落后多少」，而不是只说「下面还有」。
   *
   * 判轮归共享包（`countTurnsAfterMessage`）：一条用户消息开一轮，紧跟的助手回复
   * 属于同一轮，只承载供应商切换 notice 的旁白行透明。桌面端读的是同一份 —— 两处
   * 各拼各的必然在边角上分家。
   *
   * 贴底时药丸根本不渲染，不必白算。
   */
  const turnsBelow = useMemo(
    () => (atBottom ? 0 : countTurnsAfterMessage(messages, bottomVisibleId)),
    [atBottom, bottomVisibleId, messages],
  );

  const panelWaiters = useMemo(
    () => selectPanelWaiters(messages, decisions.waiters),
    [messages, decisions.waiters],
  );

  /** 这条对话钉着的那台机器**够不着**：这几档下转录不会来了（见下面两句各自的话）。 */
  const unreachable =
    status === "machineOffline" ||
    status === "desktopAppNotRunning" ||
    status === "deviceRevoked";

  // 转录有两个来源：server 镜像里的历史（机器离线照样有——本轮的目的），与中继接上
  // 之后的实时补齐。账号登出时两者都不算数：那时页面只剩重新登录这一条路。
  //
  // 那条接力消息排在两者之前：它就在手上，不必等任何一条来路。但只在机器还够得着
  // 时算数 —— 挂着它就是挂着三点，而对着一台没人在的机器转三点是在替远端撒谎
  // （与转录那边「通道断了就先说通道」同一条规矩）。派发成功后机器随即掉线正是
  // 这一档。
  const showTranscript =
    status !== "loggedOut" &&
    ((seeded && !unreachable) ||
      history.loaded ||
      (ready &&
        (status === "connected" ||
          status === "pinnedAgentredUnavailable" ||
          relayState === "reconnecting")));

  // 账号里没有这条对话的历史（没认出发起端 / 端点取不到），而机器又不在线：如实说
  // 读不到，不摆一条空转录冒充「这条对话没说过话」。
  /**
   * 账号里没有这一份，而承载它的机器还没把内容答出来 —— 在等，不是空。
   *
   * 判据要的是「机器有希望答」：离线 / 撤销那几档由 historyUnavailable 承接，
   * 那句说的是读不到，不是在读。
   */
  const readingFromMachine =
    history.settled &&
    !history.loaded &&
    !showTranscript &&
    !catchUpFailed &&
    (status === "connecting" ||
      status === "connected" ||
      status === "reconnecting");

  const historyUnavailable =
    history.settled && !history.loaded && !showTranscript && unreachable;

  /**
   * 还没有内容、但**有理由认为它会来**：这一段摆骨架（决策 2）。
   *
   * 读不到的那几档（离线 / 撤销）不在其中——它们由 `historyUnavailable` 那句如实
   * 说明，摆骨架等于承诺一个不会到的东西。账号登出同理：那一屏只剩重新登录。
   */
  const awaitingTranscript =
    !showTranscript && !historyUnavailable && status !== "loggedOut";

  /** 滚的只有这一带。转录、状态横幅与审批卡都在里面，头部与 Composer 都不在。 */
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      // 这四件事就是「他动的手」的全部证人：滚轮、触摸、按键，以及摁在滚动条上拖。
      onWheel={onUserScroll}
      onTouchMove={onUserScroll}
      onKeyDown={onUserScroll}
      onPointerDown={onUserScroll}
      data-testid="session-detail-scroll"
      // 「下面还会变」由这一条说，读屏据此不必把半截内容当成全部（决策 17）。
      aria-busy={awaitingTranscript || undefined}
      className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-2"
    >
      <div
        ref={contentRef}
        className="mx-auto flex w-full max-w-measure flex-col gap-4"
      >
        <SessionStatusBanner
          status={status}
          machineName={machineName}
          machineLastSeenMs={machineLastSeenMs}
          protocolMismatchDetail={protocolMismatchDetail}
          // 「lost」说的是「已经不再自动重试」——一句终局的话，那就必须配一个
          // 出路，否则用户只能刷新整页而界面没说。这里给的是重开一条连接
          // （见 useRelayMachine.reconnect：已经 close 的 client 上没有可重试的东西）。
          onReconnect={onReconnect}
          /**
           * 「机器离线」那一档的出口（两端统一）：那台机器够不着、续轮又不会
           * 改派，唯一走得通的路是另起一条。
           *
           * 走 URL 而不是回调：本视图有两种形态，路由页那一种压根不在 `/chat`
           * 里（移动端下钻、`/devices/:did/sessions/:sid` 都是），没有回调递得
           * 过来。嵌入形态下 Chat 本来就挂着，参数一变它就开挑 Agent 那一屏。
           */
          onStartNew={() => nav("/chat?compose=1")}
        />

        {/* 补齐失败：此前是静默吞掉的，页面停在一条空转录上不出声。 */}
        {catchUpFailed && (
          <Alert
            role="status"
            variant="destructive"
            data-testid="session-catchup-failed"
          >
            <AlertDescription>
              {t("session.transcript.catchUpFailed")}
            </AlertDescription>
          </Alert>
        )}

        {showTranscript && (
          <>
            {/*
              往回读的那一带。滚动够不着时（内容填不满一屏）这个按钮是唯一的入口，
              所以它挂在转录**上方**，与用户往上找的方向一致。
            */}
            {earlier.loading && (
              <p
                data-testid="session-loading-earlier"
                className="py-1 text-center text-xs text-muted-foreground"
              >
                {t("session.transcript.loadingEarlier")}
              </p>
            )}
            {!earlier.loading && earlier.failed && (
              // 说出来并给一条回程。这一档与「补到封顶」互斥地摆在同一带上：
              // 两者都是「更早的还在，只是这一下没读到」。
              <div
                data-testid="session-earlier-failed"
                className="flex flex-wrap items-center justify-center gap-2 py-1 text-xs text-muted-foreground"
              >
                <span>{t("session.transcript.earlierFailed")}</span>
                <Button variant="outline" size="sm" onClick={onLoadEarlier}>
                  {t("common.retry")}
                </Button>
              </div>
            )}
            {!earlier.loading &&
              !earlier.failed &&
              earlier.capped &&
              earlier.hasBefore && (
                <div className="flex justify-center py-1">
                  <Button variant="outline" size="sm" onClick={onLoadEarlier}>
                    {t("session.transcript.loadEarlier")}
                  </Button>
                </div>
              )}
            <Transcript
              messages={messages}
              // 共享包的转录消息仍带一格旧身份 sessionId:number，本宿主一律填同一个
              // 常量（见 transcriptFrame）。对话的真身份是上面那条 sid。
              sessionId={TranscriptSessionId}
              localFingerprint={localFingerprint}
              ports={decisions.transcriptPorts}
              agentName={agentName}
              agentAvatar={agentAvatar}
              agentPending={agentPending}
              fallbackModel={fallbackModel}
              liveTurnTiming={liveTurnTiming}
              streaming={streaming}
              pendingAssistant={pendingAssistant}
              // 通道断了就先说通道：此刻「还在不在生成」根本观察不到，继续转三个点
              // 是在替远端撒谎。这个顺序由共享包保证，本站只把两个事实交上去。
              reconnecting={relayState === "reconnecting"}
              // 行虚拟化的滚动容器。取不到时转录整列渲染（见 Transcript 里那段
              // 「量不出视口高度就不开窗」的注释）。
              getScrollElement={getScrollElement}
            />
            {/*
              可见性交给面板自己判：三个入参它全都有，同一个三段条件在这里再写
              一遍只会让两处慢慢漂开。空态由它 return null。
            */}
            <DecisionPanel
              sessionId={TranscriptSessionId}
              toolPermissions={panelWaiters.toolPermissions}
              askUserQuestions={panelWaiters.askUserQuestions}
              handledRequestId={decisions.handledRequestId}
              ports={decisions.panelPorts}
            />
          </>
        )}
        {/*
          用户自己写的那两类气泡——没发出去的（决策 7）与排着队的（决策 6）。

          它们在 `showTranscript` **之外**：转录读不读得出来是另一件事，而这两条
          是这个人刚刚敲进去的字。转录没加载出来就把它们一起藏掉，等于把人写的话
          弄丢了。也**不进** events —— 那一份是对端说过的话，混进去会让下一次按
          seq 拼接对不上号。
        */}
        {send.failedSends.map((failure) => (
          <SendFailureBubble
            key={failure.id}
            failure={failure}
            machineName={machineName}
            busy={send.sending}
            onRetry={() => void send.retryFailedSend(failure)}
            onDiscard={() => send.dropFailedSend(failure.id)}
          />
        ))}
        {send.pendingSend && (
          <PendingSendBubble
            text={send.pendingSend}
            onCancel={send.cancelPendingSend}
          />
        )}
        {historyUnavailable && (
          <p
            data-testid="session-history-unavailable"
            className="text-sm text-muted-foreground"
          >
            {t("session.historyUnavailableOffline")}
          </p>
        )}
        {/*
          账号里没有这一份、机器又还没答话：如实说在等它，**不**摆一条空转录。
          「还没有消息」此后只对确实读到了、而它就是空的那种情形说。
        */}
        {readingFromMachine && (
          <p
            data-testid="session-reading-from-machine"
            className="text-sm text-muted-foreground"
          >
            {t("session.transcript.readingFromMachine")}
          </p>
        )}
        {/* 在等内容：摆骨架，不摆一行「正在加载转录…」。那行字与此前头上那条红色的
            「连接中…」横幅说的是同一件事，而且不占位置——内容落地时版面整块下跳。
            上面 readingFromMachine 那句留着：它说的是**在等哪台机器**，骨架说不出。 */}
        {awaitingTranscript && <TranscriptSkeleton />}
        {/* 往回翻之后的出口（2026-08-24）。这一端此前根本没有它：长对话滚上去只能
            自己拖回来。控件与桌面端同一个实现，形状只有药丸一种。
            这一端没有「补齐」那套账，因此不传 catchUp，药丸就写「回到底部」。 */}
        {atBottom ? null : (
          <TranscriptJumpControl
            onJump={jumpToBottom}
            turnsBelow={turnsBelow}
          />
        )}
      </div>
    </div>
  );
}
