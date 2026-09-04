import { rpcMethods } from "@agentre-hub/agentre-wire";
import {
  EventUserMessage,
  sessionListFromProtobuf,
  SessionLifecycleInterrupted,
  SessionLifecycleRunning,
  type SessionSummary,
} from "@agentre-hub/agentre-wire";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import {
  AgentAvatar,
  MESSAGE_AVATAR_CLASS,
  Alert,
  AlertDescription,
  createTranscriptProjector,
  iconNode,
  indicatorHostMessageId,
  normalizePermissionMode,
  opensAssistantMessage,
  reduceSessionState,
  resolveProviderPillState,
  type ModelTarget,
  type ReasoningEffortValue,
} from "@agentre-hub/agentre-ui";

import AppShell from "@/components/AppShell";
import SessionDetailHeader from "@/components/session/SessionDetailHeader";
import SessionComposerBand from "@/components/session/SessionComposerBand";
import SessionScrollBody from "@/components/session/SessionScrollBody";
import SessionModelControl from "@/components/session/SessionModelControl";
import SessionReasoningEffortControl from "@/components/session/SessionReasoningEffortControl";
import { turnDoneFrames } from "@/components/session/turnDone";
import {
  useReconnectProbe,
  useSessionTargetDevice,
} from "@/components/session/useSessionTargetDevice";
import { useAliveEffect } from "@/hooks/use-api-query";
import { useRelayMachine } from "@/hooks/use-relay";
import {
  TranscriptSessionId,
  pendingUserMessage,
  toTranscriptFrame,
  type SessionEventFrame,
} from "@/components/session/transcriptFrame";
import { conversationTarget, machineTarget } from "@/lib/relayTarget";
import { api, ApiError } from "@/lib/api";
import {
  decodePermissionModeMeta,
  decodeReasoningEffortSupport,
  type PermissionModeMeta,
} from "@/lib/backendCapabilities";
import { useEngineCatalog } from "@/lib/engineCatalog";
import { fetchProjects, type ProjectNode } from "@/lib/projects";
import { deriveSessionViewStatus, sessionTitle } from "@/lib/sessionView";
import {
  loadMirrorTail,
  mirrorRowToSummary,
  fetchMirrorRow,
  type MirrorSessionItem,
  writeModelTargetToOrigin,
  writeReasoningEffortToOrigin,
} from "@/components/session/sessionMirror";
import { useLiveTurnTiming } from "@/components/session/useLiveTurnTiming";
import { useSessionDecisionPorts } from "@/components/session/useSessionDecisionPorts";
import {
  useSessionSend,
  useTurnActivity,
} from "@/components/session/useSessionSend";
import {
  RELAY_TAIL_FRAMES,
  useTranscriptScrollback,
} from "@/components/session/useTranscriptScrollback";

// 补齐的帧数上限与「更早的」续读是同一件事，常量随那一族一起搬走；这里再导出一次，
// 因为它本来就是从这个模块公开出去的。
export { RELAY_TAIL_FRAMES };

/** GET /v1/workspace/agents 里头部要的四列：身份、名字、调色板色、图标键。 */
interface WorkspaceAgent {
  sync_id: string;
  name: string;
  avatar_color?: string;
  /** 图标词表的 key；解成图标那一步走共享包的 `iconNode`，两端同一份词表。 */
  avatar_icon?: string;
  exec_targets?: {
    backend_sync_id?: string;
    current?: boolean;
  }[];
}

/** 设备状态里的「还在账号里」。撤销的设备仍会出现在清单上，只是 status 不再是它。 */
const DEVICE_ACTIVE = 1;

/**
 * 会话详情视图的导航形态（任务 5 重构边界）：
 *   - "page"：路由页形态。包 AppShell（TopBar 标题 + SideNav），带面包屑/移动返回
 *     （决策 16）。
 *   - "embedded"：桌面 Chat 右栏嵌入形态。不包 AppShell、无面包屑；只渲染真实详情
 *     （标题/状态/转录/审批/Composer），由外层容器给尺寸。移动路由流程仍走 page
 *     形态。保存 / 删除两端都不在这里——它们的入口在索引的行上（决策 5 / 11）。
 */
export type SessionDetailViewForm = "page" | "embedded";

export interface SessionDetailViewProps {
  /** 目标设备（agentred）在账号下的 id。 */
  deviceId: number;
  /** 这条对话的身份，全局唯一（决策 1）。URL、索引行与镜像都拿它寻址。 */
  conversationId: string;
  /**
   * 这条对话的**发起端**指纹。它不再是身份的一半，但仍是请求参数：wire 的
   * `ResolveSessionPeer` 省略它就是「调用方自己的对端」。索引行直接知道它
   * （/v1/agent-sessions 的 peer_fingerprint），传进来就省掉一次认领。
   */
  peerFingerprint?: string;
  form?: SessionDetailViewForm;
  /**
   * 打开这条对话时就该摆在模型控件旁边的一句话。
   *
   * 唯一来路是「刚刚从草稿页把它发起出来，用户选了模型，但那台机器没能把这个
   * 选择记下来」：第一轮确实按所选模型跑了，后续轮次会回到跟随 Agent 绑定 ——
   * 不说的话，这一屏会对着一条其实没钉住的对话显示「跟随 Agent 绑定」，而用户
   * 明明选过。用户改一次模型就被顶掉，它说的本来就是发起那一刻的事。
   */
  initialModelNote?: string | null;
  /**
   * 「力度没能钉住」那一句（与 initialModelNote 同一条来路：草稿页刚把这条对话派发
   * 出来，而那台机器没能把所选档位记下来）。
   */
  initialEffortNote?: string | null;
  /**
   * 摘要两条来路都还没落地时先摆的标题。
   *
   * 唯一的作用是**填掉冷启动那一段空窗**：`session.list`（中继票 + WS + attach）
   * 与账号镜像那一行（一次 HTTP）都要往返，期间头部只能退回 `#<会话号>` —— 一串
   * 十六位数字，用户认不出那是哪条对话，而这正是「消息发出去之后画面在闪」的那
   * 一段。宿主手上本来就有这个名字：左栏点行时是那一行的标题，草稿派发时是
   * `deriveTitle(第一句话)`，两者都不必再问一次。
   *
   * 只是**兜底**，不是覆盖：任一条来路落地后一律以它为准（见 displayTitle），
   * 所以这里给的是不是最新的并不要紧。给不出时照旧退回 `#<会话号>`。
   */
  initialTitle?: string;
  /**
   * 账号镜像里的**那一行**，由宿主直接递下来。
   *
   * 左栏点一行进右栏时，这一行就是索引取回来的那一行——标题、Agent 身份、发起端
   * 指纹、模型目标都在上面，正是本页认领那一趟要问回来的东西。递下来就省掉那次
   * `/v1/agent-sessions?session_id=`，而且头部不必等一个 HTTP 往返才认得出这是哪
   * 条对话。
   *
   * 给不出时（移动端从 URL 下钻、分享链接进来）照旧自己认，不猜。它与
   * `initialTitle` 的区别是**整行**与**一个名字**：给了整行就连替补摘要一起有了，
   * `initialTitle` 只填得了标题那一格。
   */
  initialRow?: MirrorSessionItem;
  /**
   * 这条对话的第一轮是**什么时候派发出去的**（`Date.now()`）。
   *
   * 唯一来路与 `initialModelNote` 同一条：草稿页刚把它发起出来。那一轮是这个浏览器
   * 几百毫秒前开的，可本页装载时 attach 只看得到「对端已经在跑」——而「接进来时
   * 已经在跑」本页一律不计时（那种轮次什么时候开的它不知道）。交出这个时刻，第一轮
   * 的耗时才不必等它跑完才出数。
   *
   * 过期的一律不作数（见 `useLiveTurnTiming` 的窗口）：导航 state 会跟着历史记录
   * 一直留着，十分钟后刷新页面它还在手上。
   */
  initialTurnStartedAt?: number;
  /**
   * 刚从草稿页发出去的**那一句**（`DispatchedSession.userText`）。
   *
   * 与 `initialTitle` 同一条来路、同一件事，只是它填的是转录那一带而不是头部：
   * 草稿页在派发在飞时已经把这句话与三点画出来了，而本视图从**空事件表**起手 ——
   * 转录的两条来路（账号镜像的一次 HTTP、中继的票 + WS + attach + 补齐）都要往返，
   * 期间那一带只剩一片骨架，用户刚说完话就眼看着自己的话消失、界面重搭一遍。
   *
   * 只是**接力**：转录一有内容（哪一条来路先到都算）它就整条让位，也从不进
   * `events` —— 那一份是对端说过的话，混进去会让下一次按 seq 拼接对不上号。
   */
  initialUserText?: string;
  /**
   * 宿主页面级的那簇控件，摆在详情头部的最右端（嵌入形态才有）。
   *
   * 桌面 Chat 把转录上方那两条带并成一条之后，壳不再画 52px 顶栏，连接态与
   * 语言/主题就落在这里 —— 详情头部本身**就是**那一页的顶带。路由页形态不传：
   * 壳的顶栏还在，那簇控件仍归它。
   */
  headerRight?: ReactNode;
  /**
   * 标记已读成功后通知拥有索引的宿主：**标在哪个身份上**，以及服务端记下的时刻。
   *
   * 递这两样而不是只喊一声：服务端专门把时刻回了出来（MarkSessionReadResponse
   * 「供客户端就地覆盖那一行」），宿主拿它改自己手里那一行就够了，不必为了一个
   * 已经知道的值再重取一遍整页索引。
   *
   * 交回的是这条对话的身份（`conversation_id`）：宿主手里那一行的键就是它，
   * 不必再凑一个。
   */
  onMarkedRead?: (conversationId: string, lastReadAt: number) => void;
}

/**
 * 可复用真实会话详情视图：attach + 按 seq 游标补齐（origin 原样带回 R4/R6）、
 * 实时事件、待审批/提问决策（R10）、发新消息（R9）、七类不可达状态（R11）都在这
 * 一份实现里，路由页与桌面右栏共用，不回退。
 *
 * 详情头部对齐正式画板（X9Mjl/uqEha 的 DetailHeader）：标题 + 状态标记 + 机器 meta。
 * 画板中无协议支持的「分享链接」、文件改动面板、自动挂起倒计时、权限模式、会话轮次、
 * 快速提示词一律不渲染（规格「任务必要性 + 真实能力」双重判定）。
 *
 * 「more」那颗按钮曾经也在这份不渲染的名单上，同一条理由：点开全是灰项不如不摆。
 * 现在它摆了 —— 因为菜单里终于有了一条不需要任何协议支持的真项目（复制会话号，
 * 见 SessionDetailHeader）。名单上其余几样仍然成立，判据没有松动。
 */
export default function SessionDetailView({
  deviceId,
  conversationId,
  peerFingerprint,
  form = "page",
  initialModelNote,
  initialEffortNote,
  initialTitle,
  initialTurnStartedAt,
  initialUserText,
  initialRow,
  headerRight,
  onMarkedRead,
}: SessionDetailViewProps) {
  const did = Number(deviceId);
  const sid = conversationId;
  const originProp = peerFingerprint?.trim() || undefined;
  const { t } = useTranslation();
  const isPage = form === "page";

  /** 这条会话所属 Agent 的名字与调色板色，按 summary.agentSyncId 解。 */
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  /**
   * Agent 清单问过了没有（成功或失败都算）。与「清单是不是空的」不是一回事：
   * 解不出名字在这两种情形下要说的话不同 —— 还没问到是空窗（等一下就有），
   * 问过了还解不出是终局（老会话没有 agentSyncId）。转录抬头据此决定要不要
   * 先摆中性名（见 agentPending）。
   */
  const [agentsSettled, setAgentsSettled] = useState(false);
  /**
   * 账号的项目树。头部要拿这条对话钉的 projectSyncId 换一个名字与调色板色 ——
   * 与 Agent 名同一种取法：解不出就不摆那一维，不拿标识本身顶上。
   */
  const [projects, setProjects] = useState<ProjectNode[]>([]);
  const { backends: engineBackends, catalog: pickerCatalog } =
    useEngineCatalog();
  const [permissionMode, setPermissionMode] = useState("");
  /**
   * 执行端报的权限档位元数据。三态见 SessionComposer 的 permissionModeMeta：
   * undefined = 还没问到 / null = 问不出 / 有值 = 那台机器的实话。
   */
  const [permissionModeMeta, setPermissionModeMeta] = useState<
    PermissionModeMeta | null | undefined
  >(undefined);
  /** 上一次切档失败的说明。 */
  const [permissionError, setPermissionError] = useState<string | null>(null);
  /**
   * 用户这一次选的 ModelTarget；null = 还没选过，按落库那一份显示。
   * 写入成功前就乐观反映，失败时回滚（见 changeModelTarget）。
   */
  const [modelTarget, setModelTarget] = useState<ModelTarget | null>(null);
  /** 上一次改模型失败 / 只写成一台的说明。 */
  const [modelTargetNote, setModelTargetNote] = useState<string | null>(
    initialModelNote ?? null,
  );
  /**
   * 这个后端支不支持会话级思考力度（执行端自报的能力位，规格 2026-09-01 决策 6）。
   * 为假时整颗控件不渲染 —— 不置灰、也不解释一个用户改不了的事实。
   */
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(false);
  /** 用户这一次选的力度；null = 还没选过，按落库那一份显示。 */
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  /** 只写成一台 / 派发时没钉住的说明——摆在控件旁边，不是错误。 */
  const [reasoningEffortNote, setReasoningEffortNote] = useState<string | null>(
    initialEffortNote ?? null,
  );
  /**
   * 两台都没写成时的原因。这才是控件自己的失败，交给共享 Picker 的
   * `errorText`，让它出现在弹层底部的错误行里（spec「失败与恢复」），
   * 不进旁边那条如实说明的 sibling note。
   */
  const [reasoningEffortError, setReasoningEffortError] = useState<
    string | null
  >(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  /**
   * 账号镜像那一行派生出来的摘要 —— 头部的**替补**来路。
   *
   * 与 summary 分开存，不合成一个：中继的摘要是执行端此刻的实况，镜像那一行是账号
   * 里记下的上一次。合成一个的话，两条 effect 谁后落地谁说了算，机器在线时头部会
   * 被一份旧快照盖回去。分开之后先后次序不再要紧 —— 渲染时永远实况优先（identity）。
   */
  const [mirrorSummary, setMirrorSummary] = useState<SessionSummary | null>(
    null,
  );
  const [events, setEvents] = useState<SessionEventFrame[]>([]);
  // 桌面端仍在场时写失败：表示该会话钉住的 agentred 当前不可用（历史可读、新写入停用）。
  const [pinnedAgentredUnavailable, setPinnedAgentredUnavailable] =
    useState(false);
  const [ready, setReady] = useState(false);
  /**
   * server 镜像里的历史读到哪一步：settled = 这个目标问过了（成功或失败都算），
   * loaded = 真读到了。两者分开，是因为「问过但账号里没有」与「还没问」在界面上
   * 是两回事：前者要如实说读不到，后者还在路上。
   */
  const [history, setHistory] = useState({ settled: false, loaded: false });
  /** 从这台机器补齐失败（此前是 catch {} 静默吞掉的）。 */
  const [catchUpFailed, setCatchUpFailed] = useState(false);
  /**
   * 已经看着几轮落定了。0 = 装载之后还没有过轮次边界。
   *
   * 「摘要重取」与「已读补记」两件事都挂在它上面：它们的触发时机是同一个（一轮跑
   * 完），而两件事的收尾都要有 alive() 守着——异步应答不能落到已经换掉的目标上。
   * 所以它是一个由回调点火、由 effect 消费的计数，而不是在回调里直接 await
   * （回调里没有地方拿 alive()）。
   */
  const [turnEpoch, setTurnEpoch] = useState(0);

  const clientRef = useRef<import("@/lib/relayClient").RelayClient | null>(
    null,
  );
  /**
   * 别的对端发起的会话（R4：清单列的是这台机器上的**全部**会话）在 daemon 上的键是
   * (发起端指纹, 会话 id)。清单在 summary.peerFingerprint 上交出这个 origin，此后
   * 每一次 attach / pull / 控制请求与 runtime.run 都要原样带回 —— 省略即
   * 「调用方自己的对端」，操作的会是本浏览器名下那条同号空会话。
   */
  const originRef = useRef<string | undefined>(undefined);
  /**
   * 已经为哪一条对话记过「读到这里」了。键就是 `conversation_id`（决策 1）。
   * 同一条重渲染不再记一次；换一条才再记。
   */
  const markedReadRef = useRef<string | null>(null);
  /**
   * server 镜像的历史应用到的最后一个 seq。中继客户端可能晚于历史才出现（换 ticket
   * 是异步的），所以预置游标要落在 attach 之前那一刻，而不是历史刚读完的那一刻。
   */
  const mirrorSeqRef = useRef(0);
  /**
   * 转录的滚动、钉底、前插补偿与「更早的」续读整片归 useTranscriptScrollback；
   * 本组件只读它交出来的那几样，不碰 pinRef / 前插补偿那些内部账。
   */
  const scrollback = useTranscriptScrollback({
    did,
    sid,
    originProp,
    events,
    setEvents,
    clientRef,
    originRef,
  });
  /**
   * 待决清单与那两条提交路径（面板 / 转录里的卡）整片归 useSessionDecisionPorts。
   */
  // 解出来单放一格：`ref={scrollback.scrollRef}` 这种成员表达式过不了
  // react-hooks/refs —— 规则看不出成员访问取到的是 ref 对象本身还是它的值。
  const { scrollRef } = scrollback;
  const decisions = useSessionDecisionPorts({ sid, clientRef, originRef });
  /**
   * 轮次状态与发送反馈（转录的三点、占位、「已排进这一轮」）整片归 useTurnActivity。
   * 它排在中继之前：onRunResultDone / onAutonomousTurnStarted 与 attach 都要写它。
   */
  const turn = useTurnActivity();
  /**
   * 这一轮跑到第几秒。共享包那条 meta 靠它才开表 —— 耗时 / 首字 / tok/s 在 wire 上
   * 只出现在终态帧（见 turnDone），不自己数的话，跑的那几十秒里那一格是死的。
   *
   * 排在中继之前的理由与上面那只一样：实时回调要往里写。
   */
  const liveTurn = useLiveTurnTiming(initialTurnStartedAt);
  // 已装载的目标会话标识：桌面 Chat 右栏点行 A 再点行 B 时是同实例换 props（无
  // key 强制重挂），会话级状态必须随 (did, sid) 变化重置，否则右栏残留上一条会话的
  // 标题/转录/决策，发消息也落在上一条的 origin 上。用 React 官方的「prop 变化时
  // 重置 state」渲染期调整模式（不能在 effect 里裸调 setState —— lint 禁止）。
  // 设备/账号级状态（machineOnline / meValid）不在此列，由各自 effect 随
  // did 刷新。originRef 由 attach effect 每次重新推导，不需要在这里清；镜像历史
  // 的进度（history / mirrorSeqRef）随目标一起重来，否则 B 会接着 A 的游标读。
  const [lastTarget, setLastTarget] = useState({ did, sid, originProp });
  if (
    lastTarget.did !== did ||
    lastTarget.sid !== sid ||
    lastTarget.originProp !== originProp
  ) {
    setLastTarget({ did, sid, originProp });
    setHistory({ settled: false, loaded: false });
    setSummary(null);
    setMirrorSummary(null);
    setEvents([]);
    decisions.reset();
    turn.reset();
    liveTurn.reset();
    setPinnedAgentredUnavailable(false);
    // 力度那三格同属会话级：不清的话，B 的控件会摆着 A 刚选的那一档，而能力位
    // 要等新摘要落地才重问（此刻摆的是上一条会话那个后端的答案）。
    setReasoningEffort(null);
    setReasoningEffortNote(null);
    setReasoningEffortError(null);
    setSupportsReasoningEffort(false);
    setReady(false);
    scrollback.reset();
    setCatchUpFailed(false);
    // 不清的话，切过去那一瞬 effect 会带着上一条对话攒下的序号立刻跑一遍。
    setTurnEpoch(0);
  }

  // 目标机器与它的可达性（device / deviceError / machineOnline / meValid）整片
  // 归 useSessionTargetDevice；本组件只读它们。
  const target = useSessionTargetDevice(did);
  const { device, deviceError, machineOnline, meValid } = target;

  /**
   * 这条通道声明的目标（决策 11 的入口分流）。
   *
   * 账号里**有**这条对话（宿主递下来那一行，或本页自己认出来的那一行）时按对话寻址
   * ——服务端查名单解析出承载它的机器，这一页全程不需要知道那是哪一台。账号里没有
   * （机器轴上那些还没保存的对话是大多数，服务端解析不出它们）时按机器寻址，而那时
   * 机器正是用户刚点进来的这一台，本来就在上下文里。
   *
   * 认领落定之前**不开通道**：分流一旦选错就是一条通道级错误，而账号那一行本页无论
   * 如何都要问一次，等它一个往返比猜一次再改口干净。
   */
  const savedInAccount = initialRow !== undefined || mirrorSummary !== null;
  const relayTarget = !history.settled
    ? null
    : savedInAccount
      ? conversationTarget(sid)
      : device?.online
        ? machineTarget(device.fingerprint)
        : null;

  const { client, relayState, relayTicket, relayTicketError, reconnect } =
    useRelayMachine(relayTarget, {
      onEvent: (f, at) => {
        const kind = (f.event as { kind?: string } | undefined)?.kind;
        if (f.conversationId === sid) {
          setEvents((prev) => [...prev, toTranscriptFrame(f, at)]);
          // 计时也吃这条流:首字什么时候到、工具在跑的那几段不算生成,都只有帧说得清。
          liveTurn.noteFrame(kind);
          /*
            回声 = 一轮开起来了。`user_message` 是 daemon 在「开新一轮」事件流开头
            注入的发起方标记(R18),不是转录里随便一条用户消息。

            这一屏未必是发送方:同一个账号的两个窗口(或桌面与手机)都上过这条会话
            时,daemon 把这一轮的事件**扇给两边**,而「有一轮跑起来了」此前只有发送
            方自己知道 —— `turnActive` 转真的另外两条路都不成立:起始通知只在**自主
            续轮**时发(daemon 的 forwardAutonomousTurn),别人一次普通的 runtime.run
            什么都不发;attach 那一刻的清单快照说的是打开这一屏的那一瞬。于是旁观的
            那个窗口从按下发送到回复到齐全程一动不动,回复就那么突然冒出来。

            **只认实时帧**(ready 之后):补齐会把历史里的每一轮都回放一遍,拿回放去
            点亮等于刚打开一条闲置会话就闪一下 Running。ready 之前那一段自有归宿 ——
            attach 收尾处按清单快照 markTurnActive,它本来就排在补齐之后。

            不开表(`liveTurn.beginTurn`):这一轮的起点这一屏观察不到 —— 回放来的回声
            与实时的长得一样,而从半路起的表会给出一个偏小、却看着与真的一样的数
            (与「接进来时对端已经在跑」同一档,见 useLiveTurnTiming)。三点不依赖它。
          */
          if (kind === EventUserMessage && ready) {
            turn.markTurnActive(true);
            turn.setPendingAssistant(true);
          }
          // 撤占位的判据是「助手真的开口了」,不是「又来帧了」:一轮的第一帧是
          // daemon 把用户自己那句话回声回来,拿它撤占位等于对端还没说话就把三点
          // 熄了,而这一轮再没有别的东西能重新点亮它。
          if (
            opensAssistantMessage(toTranscriptFrame(f, at), TranscriptSessionId)
          )
            turn.setPendingAssistant(false);
        }
        // 审批/提问事件到达时刷新待决策:DecisionPanel 的数据源是 pendingWaiters,
        // 不是事件流 —— 不主动重拉,审批卡就永远不出现(fake runtime 阻塞在审批上,
        // run 不会结束,onRunResultDone 那一条刷新路径到不了;R10)。
        if (
          kind === "tool_permission_request" ||
          kind === "ask_user_question"
        ) {
          decisions.requestWaitersRefresh();
        }
      },
      onRunResultDone: (frame) => {
        turn.markTurnActive(false);
        // 收表:终态帧自带的那几个数是 agentred 就着自己扇出的事件流量的,比浏览器
        // 这边隔着一条中继数出来的准,接下来画的是它们。
        liveTurn.endTurn();
        turn.setPendingAssistant(false);
        setEvents((prev) => [...prev, ...turnDoneFrames(sid, frame)]);
        // 「已排进这一轮」是对**那一轮**的说明:轮次结束后它已经过期(要么被消费、
        // 回复就在转录里,要么随轮次一起没了),留着就是在骗人。
        turn.setSendFeedback((prev) =>
          prev.kind === "queued" ? { kind: "none" } : prev,
        );
        decisions.requestWaitersRefresh();
        // 这一轮落定了 → 摘要重取 + 已读补记（见下面那只 effect 的说明）。
        //
        // 只认**实时**的那一遍（ready 之后）：补齐会把历史里的每一个终态帧都从这里
        // 回放一遍，跟着走就是打开一条 40 轮的对话时连发 40 次 POST，而那 40 轮
        // 用户一轮都没有「刚看着它跑完」。
        if (ready) setTurnEpoch((n) => n + 1);
      },
      onAutonomousTurnStarted: () => {
        turn.markTurnActive(true);
        turn.setPendingAssistant(true);
        // 这一轮是后台任务替用户开起来的,起点就是此刻 —— 与自己发送开轮同一档。
        liveTurn.beginTurn(Date.now());
        decisions.requestWaitersRefresh();
      },
      onTurnStarted: () => {
        // 客户端要的那一轮开始了(wire 2026-09-02 新增)。此前这一路一个信号都没有:
        // **别的端**在这条会话上发消息时,这一屏只看得到轮次结束,整轮里头部都是
        // 灰的、「停止」也摆不出来。
        //
        // daemon 把它扇给这条会话的**全部**订阅者,发起方自己也在里面,而补齐还会
        // 把历史里的这一帧重放一遍。已经知道在跑就什么都不做:重开表会把自己发送
        // 那一刻起的计时抹掉(回声隔着一个往返才回来),重设占位则会在助手已经开口
        // 之后又点亮一次三点。
        if (turn.turnActiveRef.current) return;
        turn.markTurnActive(true);
        turn.setPendingAssistant(true);
        liveTurn.beginTurn(Date.now());
        decisions.requestWaitersRefresh();
      },
    });

  // 断线原因探测排在中继之后：它看的正是中继吐出来的 relayState。
  useReconnectProbe(target.probe, did, relayState);

  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  // Agent 清单（头部要「是哪个 Agent 在跑」）。锦上添花：取不到就退回状态文字，
  // 不阻塞详情渲染，也不伪造名字。
  useAliveEffect((alive) => {
    api<{ agents?: WorkspaceAgent[] }>("/v1/workspace/agents")
      .then((res) => alive() && setAgents(res.agents ?? []))
      .catch(() => {})
      // 取不到也算问过：转录抬头不能为了一次失败永远吊着不写名字。
      .finally(() => alive() && setAgentsSettled(true));
  }, []);

  // 项目树（头部要「这条对话在动哪个项目」）。同样是锦上添花：取不到就少一维，
  // 不阻塞详情渲染。这里不设 settled 那一格 —— 项目名解不开时整段不摆，没有
  // 「先摆个中性的、等一下换掉」这种中间态要区分。
  useAliveEffect((alive) => {
    fetchProjects()
      .then((got) => alive() && setProjects(got))
      .catch(() => {});
  }, []);

  /**
   * 问执行端「这个后端支持哪几档权限模式」。
   *
   * 不按 backendType 在这一侧猜：runtime 自己报的才是实话，加新后端时这里一行都
   * 不用改。问不到时落到 null 而不是空清单——空清单在契约里是「这个后端没有权限
   * 门」这句肯定的话，两者在界面上是两句不同的措辞。
   *
   * 只在连上之后问一次（按会话与后端类型），断线重连时会随 client 变化重来。
   */
  useAliveEffect(
    (alive) => {
      const backendType = summary?.backendType;
      if (!client || relayState !== "connected" || !backendType) return;
      void client
        .request(rpcMethods.runtimeCapabilities, { backendType })
        .then((raw) => {
          if (!alive()) return;
          setPermissionModeMeta(decodePermissionModeMeta(raw));
          // 力度那一格在同一份应答的 capabilities 上（见 reasoningEffortSupport）。
          setSupportsReasoningEffort(decodeReasoningEffortSupport(raw));
        })
        .catch(() => {
          // 报错与解不动是同一件事：这台机器此刻答不出档位。
          if (!alive()) return;
          setPermissionModeMeta(null);
          setSupportsReasoningEffort(false);
        });
    },
    [client, relayState, summary?.backendType],
  );

  /**
   * 历史从 server 镜像取 —— 机器在不在线都跑，这正是本轮的目的（规格「机器离线时
   * 只读」）。
   *
   * 从前这里还要**认发起端**：镜像的身份键是 (发起端指纹, 那一端的会话号)，而 URL
   * 上只有会话号，于是要逐级退让地猜。`conversation_id` 全局唯一之后这一整段没有
   * 了——URL、索引行与镜像三处是同一个值，转录按它直取。
   */
  useAliveEffect(
    (alive) => {
      if (history.settled) return;
      mirrorSeqRef.current = 0;
      void (async () => {
        try {
          // 那一行要整个拿到手（不只是指纹）：标题与 Agent 身份在它上面，机器离线时
          // 中继给不出摘要，头部只认得动这一行。
          //
          // 宿主给得出就不再去问：左栏点一行进右栏时，这一行**就是**索引取回来的那
          // 一行，回头再向服务端要一遍是一条纯重复的请求，而且头部要等它往返回来才
          // 认得出这是哪条对话。从 URL 直接进来（移动端下钻、分享链接）没有这一行，
          // 那时照旧自己认。
          const row = initialRow ?? (await fetchMirrorRow(sid));
          if (!alive()) return;
          // 认领落空（端点抖动 / 账号里还没有这一行）不挡住读转录：那两件事现在
          // 各走各的，头部只是少一份替补摘要。
          if (row) setMirrorSummary(mirrorRowToSummary(row));
          const tail = await loadMirrorTail(sid, 0);
          if (!alive()) return;
          mirrorSeqRef.current = tail.lastSeq;
          // 历史落在最前面：这一段还没有经过中继客户端的游标去重，实时那一段由预置
          // 游标接在它后面（见下面的 attach effect）。
          //
          // 但「后面」不能靠假设——手上已经有的帧要按 seq **就地让位**给这一段：
          // 桌面右栏切走再切回是同实例换 props，渲染期重置把 events 清空、
          // history.settled 打回 false，可**中继客户端没换也没 detach**（同一台机器
          // 就是同一个 client，这条会话仍在它的关注名单上）。于是一条正在输出的对话，
          // 实时帧会在这一趟 HTTP 还没回来时就落进刚清空的列表里，而镜像这一段覆盖的
          // 正是同一截 seq——原样前插就是同一句话说两遍。预置游标只管得住往后的帧，
          // 管不住已经进来的。
          //
          // 判据用 lastSeq（这一页最新那条**原始行**的 seq，与预置给中继的游标同一个
          // 数）而不是逐帧比对：服务端会把连续的 delta 合成一条，合出来那条的 seq 是
          // 该段最后一帧的，逐帧比对会漏掉被合掉的那些。没有 seq 的帧（轮次结束标记）
          // 留着——它不占游标，也无从判断归属哪一段。
          setEvents((prev) => [
            ...tail.events,
            ...prev.filter((f) => f.seq === undefined || f.seq > tail.lastSeq),
          ]);
          // loaded 说的是「账号里**有**这一份」，不是「问过了」。镜像如实回 0 帧时
          // （未保存的对话，机器轴上的大多数）它必须是假：当成读到了，页面就会摆一条
          // 空转录说「还没有消息」——那是在说这条对话是空的，而事实是还没读到。
          setHistory({ settled: true, loaded: tail.frameCount > 0 });
          if (tail.frameCount > 0) {
            scrollback.noteMirrorHistory(tail.oldestSeq, tail.hasBefore);
          }
        } catch {
          // 账号里读不到这条对话的历史（端点失败 / 没有这一行）：如实收场，机器在线
          // 时中继照样能把转录补齐，离线时界面会说读不到，而不是假装是空对话。
          if (alive()) setHistory({ settled: true, loaded: false });
        }
      })();
    },
    [history.settled, initialRow, sid],
  );

  /**
   * 装载那一遍只用得上 `markTurnActive`，而它是 `useCallback([])` 出来的定值。
   *
   * 取这一只、而不是整只 `turn`，与下面 `refreshWaiters` 同一个理由，只是代价更大：
   * `useTurnActivity()` 每次渲染都返回**新对象**，把它列进依赖，装载 effect 就每渲染
   * 重挂一次。而这只 effect 自己会 `setSummary` —— 真实的 session.list 每次都解出新
   * 摘要对象（`sessionListFromProtobuf` 按调用生成），于是必然重渲染、必然重挂，
   * 上一轮的 `alive()` 随之为假，末尾的 `setReady(true)` 一次都执行不到：attach 与
   * 补齐在中继上无限重跑，转录永远停在「正在从这台机器读取这条对话…」。
   */
  const { markTurnActive } = turn;
  // 同上：装载那一遍只用得上这一只，它同样是稳定的。
  const { noteAttachedTurn } = liveTurn;

  /**
   * 把「这个账号读到这条对话为止」记到服务端，并把服务端盖回来的时刻交给宿主
   * （索引那一行的未读徽标在它手上）。
   *
   * 身份就是 conversation_id 一个值（决策 1）——从前这里要按「索引行给的 → 机器
   * 报的 → 镜像认出来的 → 这台机器」四格去凑发起端指纹，凑错就把已读记在一条账号
   * 里不存在的对话上。时刻由服务端就地取，客户端的钟不可信。
   *
   * 记不上不影响读这条对话：它只让「未读」那一档多留一条，比拿一次失败去打断阅读
   * 要好。所以这里既不重试也不报错面。
   *
   * 两个调用方（装载那一遍、每一轮落定）都在这里过一趟，而不是各写一遍 POST：
   * 「已读记在哪个身份上、失败怎么办」只有这一处说法。
   */
  const markRead = useCallback(
    (conversationId: string) => {
      void api<{ last_read_at: number }>("/v1/agent-sessions/read", {
        method: "POST",
        body: JSON.stringify({ conversation_id: conversationId }),
      })
        .then((res) => onMarkedRead?.(conversationId, res.last_read_at))
        .catch(() => {});
    },
    [onMarkedRead],
  );

  /**
   * 打开即已读，**与中继无关**。
   *
   * 这一发从前埋在下面那只 attach effect 里：门是 `relayState === "connected"`，而且
   * 还排在一次 `session.list` 往返**后面**。两道门都是那台机器的事，而已读只是 server
   * 上的一次写（身份是 conversation_id，时刻由服务端就地取）——机器离线时转录照样从
   * 账号镜像读得到，已读却记不上：那条对话读完了仍一直亮着未读，刷新还在，侧栏那颗
   * 角标里也一直垫着它。机器在线但这一次 `session.list` 失败（超时、会话已不在它那儿）
   * 时同样漏记。
   *
   * 所以只跟着 `sid` 走：这一屏认得出是哪条对话，就够记这一笔了。同一条只记第一次
   * （`markedReadRef`），此后每一轮落定时再补一次，见下面那只轮次边界的 effect。
   */
  useEffect(() => {
    if (!sid || markedReadRef.current === sid) return;
    markedReadRef.current = sid;
    markRead(sid);
  }, [sid, markRead]);

  // 已连接 → 取会话摘要 → attach（显式接管）→ 按 seq 游标补齐转录（R6）。
  useAliveEffect(
    (alive) => {
      // 镜像历史先落地：它不走客户端的游标去重，补齐若抢在前面，同一段转录会被两条
      // 路各交付一遍。
      if (!client || relayState !== "connected" || ready || !history.settled) {
        return;
      }
      (async () => {
        try {
          const listRaw = await client.request(rpcMethods.sessionList, {});
          const list = sessionListFromProtobuf(listRaw);
          const s = list.sessions.find((x) => x.conversationId === sid);
          // origin 在 attach 之前就得学到（下一行就要用它）。
          const origin = s?.peerFingerprint?.trim() || undefined;
          originRef.current = origin;
          if (alive()) {
            setSummary(s ?? null);
          }
          // 补齐从镜像那一段的末尾接上：server 已经交出来的不再向执行端要一遍，而真
          // 跳了号的那一段仍由客户端回执行端补洞（applyDedup）。
          //
          // 三处游标调用都要带上 origin：中继客户端按 (发起端指纹, 会话 id) 记游标
          // （会话标识各端本地自增，一台机器上同号的两条对话是常态）。少带一半就是
          // 往「调用方自己的对端」那一格里预置，而 attach / catchUp 读的是这条对话
          // 自己那一格——等于没预置，server 已经有的那一段会再从执行端拉一遍。
          if (
            mirrorSeqRef.current > 0 &&
            client.getCursor(sid, origin) < mirrorSeqRef.current
          ) {
            client.setCursor(sid, mirrorSeqRef.current, origin);
          }
          // attach（接回实时流）与补齐（读历史）是两件事，**接不回不等于读不到**。
          //
          // daemon 对 interrupted 的会话一律回 ErrNoActiveTurn（那一轮的子进程随上一个
          // daemon 进程消亡了），而它同一处也写明「历史仍可 Pull」。agentred 每次重启
          // 都会把非终态会话标成 interrupted，存量因此会整批沉淀到这一档——把 attach 的
          // 失败当成整条读不到，这些对话就再也打不开，而机器在线、历史也确实在那里。
          //
          // 形状照搬同仓库的 mirror_svc.catchUp：interrupted 不去问，问了失败也只是
          // 少一次实时接管，高水位退回清单快照那一份，补齐照走。
          let latestSeq = s?.latestSeq ?? 0;
          if (s?.lifecycleState !== SessionLifecycleInterrupted) {
            try {
              latestSeq = (await client.attach(sid, origin)).latestSeq;
            } catch {
              // 清单与接入之间它刚被中断，或这条会话已经不在这台机器上。真正断掉的
              // 连接会让紧接着的 catchUp 一并失败，那时才是「读不到」。
            }
          }
          // 会话标识是各端本地自增、会被复用的：那条会话在执行端被删掉重排之后，它的
          // 日志高水位比镜像里这一段低。游标停在高水位上面的话，此后每一条实时帧都
          // 「不大于游标」被当成重复丢光——会话没有报错、也没有跳号地冻住。attach 交回
          // 来的 latestSeq 就是执行端此刻的高水位，据它复位（桌面端 reconnect.go 的
          // dropCursorAboveHighWater 同一条规则）。
          if (latestSeq > 0 && latestSeq < client.getCursor(sid, origin)) {
            client.setCursor(sid, latestSeq, origin);
          }
          // 账号里没有这一份（未保存的对话，机器轴上的大多数）：内容只有中继给得出，
          // 而从游标 0 补齐就是把整份 journal 拉回来。按对端交回的高水位反推起点，
          // 只补最后那一段；更早的等用户往上滚时再要（pullBefore）。
          //
          // 这里只能用**帧数**当刻度：对端的 pull 只有 cursor + limit，没有服务端那套
          // 预算（轮次 / 字节）。所以「够不够一屏」全靠下面那条顶补兜着。
          const relayTail =
            mirrorSeqRef.current === 0 &&
            latestSeq > RELAY_TAIL_FRAMES &&
            client.getCursor(sid, origin) === 0;
          if (relayTail) {
            client.setCursor(sid, latestSeq - RELAY_TAIL_FRAMES, origin);
          }
          await client.catchUp(sid, origin);
          if (alive() && mirrorSeqRef.current === 0) {
            // 这一段的最老一条就是游标的下一格；更早的还在对端那里。
            const from = relayTail ? latestSeq - RELAY_TAIL_FRAMES : 0;
            scrollback.noteRelayHistory(from + 1, from > 0);
          }
          if (alive()) {
            // 选路标志的起点是清单快照，但必须落在**补齐之后**：补齐会把历史里的
            // runResultDone 也经 onRunResultDone 回放一遍，落在前面会被上一轮的终态
            // 清成 false。（镜像那一段不参与这件事：回放教不了「此刻在不在跑」，
            // 它只往转录里补一条轮次结束的标记。）
            const running = s?.lifecycleState === SessionLifecycleRunning;
            markTurnActive(running);
            // 计时同理排在补齐之后:草稿页刚派发过来的那一条要在这里开表,落在前面
            // 会被回放的终态帧收掉。
            noteAttachedTurn(running);
            setReady(true);
            // 待决策刷新交给下面的「connected && ready」effect，避免重复拉取。
          }
        } catch {
          // 补齐失败不打断重连（重连后会自动再走一遍 attach + catchUp），但**要出声**：
          // 此前这里是空的 catch，页面就停在一条空转录上，用户读到的是「这条对话没说过
          // 话」，而事实是没读到。
          if (alive()) setCatchUpFailed(true);
        }
      })();
      // ready 之后不再重复跑（重连时的补齐由 RelayClient.reconnect 对 watched 会话负责）；
      // ready / did / sid 也必须是依赖：切换会话时上面的渲染期重置把 ready 置 false，
      // 这里要重新 attach 到新会话；只按 [client, relayState] 的话重置后不会重跑。
      // device?.fingerprint 是「打开即已读」在认不出发起端时的兜底身份。
    },
    [
      client,
      relayState,
      ready,
      history.settled,
      did,
      sid,
      device?.fingerprint,
      originProp,
      initialRow,
      markTurnActive,
      noteAttachedTurn,
    ],
  );

  /**
   * 一轮落定之后：把摘要重取一遍，并把已读推到这一轮之后。
   *
   * **摘要**从前只在 attach 那一刻取一次、此后永不刷新，头部于是只有「在不在跑」
   * 这一维是活的，其余各维停在打开那一瞬。而 agentred 每次重启都会把非终态会话整批
   * 标成 interrupted，于是一条打开时是中断态的对话，你在它上面跑完一轮之后头部又退
   * 回红点的「已中断」，而账号镜像那一行早就是 idle 了 —— 同一条对话在左栏与头部同
   * 时摆出两种颜色，而两边说的都是自己那份事实。
   *
   * **已读**同理只在装载那一遍记过一次，而「未读」的判据是
   * `last_message_at > last_read_at`：你正盯着它跑完的这一轮把活动时刻推到了那次已读
   * 之后，左栏那一行于是当着你的面重新亮起「未读」。桌面端同一处的做法是 lastMessageAt
   * 每推进一次就补记一次（`chat-panel` 的 mark-read effect），这一端缺的就是这一档。
   *
   * 跟着轮次边界走而不是开一条定时轮询：这几维真变的时刻就是它 —— 生命周期落定、
   * 待决清单结算、标题在首轮之后才有。
   *
   * 重取不到就留着上一份：一次失败的往返不该把头部打回「还不知道这是哪条对话」。
   */
  useAliveEffect(
    (alive) => {
      if (turnEpoch === 0 || !client || relayState !== "connected") return;
      markRead(sid);
      void (async () => {
        try {
          const list = sessionListFromProtobuf(
            await client.request(rpcMethods.sessionList, {}),
          );
          const fresh = list.sessions.find((x) => x.conversationId === sid);
          if (fresh && alive()) setSummary(fresh);
        } catch {
          // 见上：留着上一份。
        }
      })();
    },
    [turnEpoch, client, relayState, sid, markRead],
  );

  // 断线重连后刷新待决策：补齐只负责转录事件，pendingWaiters 需要重新拉一次（R10）。
  // 取的是这一只函数而不是整只 decisions：后者每次渲染都是新对象，列进依赖会让这个
  // effect 每渲染跑一遍，待决清单被反复重拉。
  const { refreshWaiters } = decisions;
  useEffect(() => {
    if (relayState === "connected" && ready) void refreshWaiters();
  }, [relayState, ready, refreshWaiters]);

  /**
   * 有待决的审批 / 提问挡在那里 —— 头部状态那一维的**实时**来路。
   *
   * 与摘要上那面 `waitingForInput` 旗是**同一个**事实，不是另一份判定：daemon 的
   * `waitingForInput` 就写作 `len(pendingWaiters) > 0`（`session_catchup.go`，而且
   * 明说了它永不落库、每次现算）。差别只在新鲜度 —— 这一份跟着待决清单走，事件一到
   * 就重拉，而摘要那一份是上一次往返时的答案。
   */
  const decisionPending =
    decisions.waiters.toolPermissions.length > 0 ||
    decisions.waiters.askUserQuestions.length > 0;

  const status = deriveSessionViewStatus({
    relayState,
    meValid:
      meValid &&
      !(
        relayTicketError instanceof ApiError && relayTicketError.status === 401
      ),
    machineOnline,
    targetKind: device?.kind,
    // 认领落定之前 relayTarget 是 null，中继手上没有目标、状态停在「没连」。换对话
    // 时这一段会重来一遍，而 machineOnline 属于设备轴不跟着重置（切的是同一台机器
    // 上的另一条对话时它一直是 true）—— 不把这件事说出来，那一帧就会被读成
    // 「连过又放弃了」，每切一次对话都先闪一条红色的「已经不再自动重试」。
    relayTargetResolved: relayTarget !== null,
    pinnedAgentredUnavailable,
    // 被撤销的设备仍留在清单上（status 不再是 ACTIVE）：它与「机器离线」是两回事，
    // 离线随时会结束，撤销是永久的（决策 7）。两者的分类在 deriveSessionViewStatus
    // 里，这里只把事实喂进去。
    deviceRevoked: device ? device.status !== DEVICE_ACTIVE : false,
  });

  // 增量投影:只归约新到的那几帧,并且只给被改到的那条消息换新身份。
  //
  // 整段重算会让每个 token 都换掉**全部**消息对象,而共享包的行缓存正是以
  // TranscriptMessage 为键的 WeakMap——那等于每帧全表 miss,整段行组件跟着重渲染。
  // projector 按会话建一次;换会话时 sid 变,自然换一个新的。
  const projector = useMemo(
    () => createTranscriptProjector(TranscriptSessionId),
    // 换对话时重新建一个：投影器是增量累积的，接着上一条的状态往下投就是两条对话
    // 的转录拼在一起。身份那一格恒为常量（见 transcriptFrame），因此这条依赖对
    // 工厂本身是多余的——留着它才是这个 memo 的意义。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sid],
  );
  const projected = useMemo(
    () => projector.project(events),
    [projector, events],
  );
  /**
   * 屏幕上那一份转录：一帧都还没有、而宿主交了草稿页刚发出去的那句话时，先摆它。
   *
   * 让位的判据是「投影出来的转录有内容了」而不是「哪条来路落地了」：镜像与中继
   * 各有各的往返，谁先到都算，而这一句本来就在两者之中 —— 再摆一次就是同一句话
   * 说两遍。
   */
  const messages = useMemo(
    () =>
      projected.length === 0 && initialUserText
        ? [pendingUserMessage(initialUserText, TranscriptSessionId)]
        : projected,
    [projected, initialUserText],
  );
  /** 此刻画的是那条接力消息，不是投影出来的转录。 */
  const seeded = projected.length === 0 && messages.length > 0;
  /**
   * 这一轮在不在跑。
   *
   * `turn.turnActive` 的起点是 attach 那一刻的 `lifecycleState`，而接力那一段
   * **还没 attach** —— 可那一轮正是这个浏览器几百毫秒前亲手开起来的，这件事没有比
   * 此刻更确定的时候。不把它算进去，草稿页上转着的三点与头上那颗绿点会在交接那
   * 一拍一起熄掉，等 attach 回来再亮 —— 又是一次「界面重搭」。
   */
  const running = turn.turnActive || seeded;

  /**
   * 要不要为这一轮摆一枚空的助手占位（三点挂在它上面）。
   *
   * 两个判据是**或**的关系，各自补另一个够不着的那一半：
   *
   *   - `turn.pendingAssistant` —— 本轮刚由**这个浏览器**开起来（发送 / 自主续轮），
   *     而转录末条还是上一轮那条已经说完的助手消息。只看转录的话三点会挂回那条上，
   *     等于说「上面那段还在写」。这一半只有开轮的那一刻知道。
   *
   *   - 转录里**根本没有能挂三点的宿主**（`indicatorHostMessageId` 返回 null =
   *     末条是用户消息）。轮次不是这个浏览器开起来的时候只有这一半算数：从草稿页
   *     交接过来的那一条（DraftSession 自己派发了 run，右栏换成详情时这一轮已经在
   *     跑）、以及轮次中途刷新页面 —— 两种情形下 attach 只把 `turnActive` 按
   *     session.list 的 lifecycleState 接回来，占位没有任何东西会去设。少了这一半，
   *     用户对着自己刚发的那句话干等到助手开口为止（联调机上实测 88 秒）。
   *
   * 助手一开口两半同时落下：`opensAssistantMessage` 撤掉前者，后者的宿主变成那条
   * 助手消息。转录只在 `streaming` 也为真时才用它（见 Transcript 的 displayMessages）。
   */
  const pendingAssistant =
    turn.pendingAssistant || indicatorHostMessageId(messages) === null;

  // 会话级状态（上下文窗口 / 权限模式）不进转录正文，单独归约一遍。
  const sessionRuntime = useMemo(() => reduceSessionState(events), [events]);

  /**
   * 头部认这条对话用的摘要：中继的实况优先，没有时退到账号镜像那一行。
   *
   * 此前头部只认 summary，而它只有 session.list 一条来路 —— 机器一离线就永远是
   * null，于是标题退成 `#<会话号>`、Agent 名与头像一并消失，转录明明就在下面。
   * 账号镜像那一行本来就带着标题与 Agent 身份，不该丢在半路上。
   *
   * 只有「这条对话是谁」这一类用它。**控制**（停止那一轮）与**发送**照旧只认
   * summary：那两件事要的是执行端此刻的实况，一份离线快照回答不了。
   */
  const identity = summary ?? mirrorSummary;
  const sessionAgent = agents.find(
    (item) => item.sync_id === identity?.agentSyncId,
  );
  const backendSyncID = sessionAgent?.exec_targets?.find(
    (target) => target.current,
  )?.backend_sync_id;
  const engineBackend = engineBackends.find(
    (backend) => backend.sync_id === backendSyncID,
  );
  /**
   * 起手值的归一化用共享包那一份（与草稿页、与桌面端 usePermissionMode 同一个
   * 实现）：用户这次选的 → 执行端报过的当前档 → 账号侧那一档的预设 → 执行端报的
   * 默认档，且账号侧那一档必须在这台机器报的集合里才算数。
   *
   * 那道集合校验不是装饰：`engineBackend` 是 Agent **当前执行目标**上的那一行，
   * 而这条对话跑在它当初派发到的那一档上，两者的后端种类可以不同（claudecode 四档
   * / codex 两档）。不校验的话，一条 codex 对话会顶着一颗 claudecode 才有的
   * Bypass，而这一档每一轮都随 runtime.run 过线（useSessionSend），执行端
   * ApplyRequested 会拿 ChatPermissionModeInvalid 把这一轮直接顶回来。
   */
  const rawPermissionMode = permissionMode || sessionRuntime.permissionMode;
  const effectivePermissionMode = permissionModeMeta
    ? normalizePermissionMode(
        rawPermissionMode,
        permissionModeMeta.allowedModes,
        permissionModeMeta.defaultMode,
        engineBackend?.default_permission_mode,
      )
    : rawPermissionMode;

  /**
   * 切档：先乐观反映，再设到执行端；失败回滚到上一次成功的那一档并如实说明。
   *
   * 不做「看起来成功了」的乐观留存 —— 用户会以为下一轮用的是新档位。形状与桌面端
   * usePermissionMode 一致。落库与下发的语义全在执行端那一侧，这里不重写。
   */
  function changePermissionMode(next: string) {
    const previous = effectivePermissionMode;
    if (next === previous) return;
    setPermissionMode(next);
    setPermissionError(null);
    const c = clientRef.current;
    if (!c) return;
    void c
      .request(rpcMethods.runtimeSetPermissionMode, {
        conversationId: sid,
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
        mode: next,
      })
      .catch((e: unknown) => {
        setPermissionMode(previous);
        setPermissionError(
          t("session.composerControls.permissionSetFailed", {
            reason: e instanceof Error ? e.message : String(e),
          }),
        );
      });
  }
  /**
   * 这条对话钉的 ModelTarget。三态与设备侧 chat_sessions 的两列逐字同义：
   * 两者皆空 = **跟随 Agent 绑定**、provider 非空 + model 空 = 该供应商当前默认、
   * 两者都非空 = 固定模型。
   *
   * 此前这里在用户没选时**静默回落**到 engineBackend 的 provider/model，界面上与
   * 「用户显式选了那个模型」完全一样——「继承」根本表达不出来。现在不回落：空就是
   * 空，而空是一个用户可以主动选回去的显式项。
   *
   * 两台机器都报了值且不一致时以**发起端**为准：identity 就是「实况优先、否则镜像」，
   * 而镜像那一行的身份键本来就是 (账号, 发起端指纹, 会话 id)。
   */
  const persistedTarget = {
    providerKey: identity?.providerKey ?? "",
    modelKey: identity?.modelKey ?? "",
  };
  const effectiveTarget = modelTarget ?? persistedTarget;

  /**
   * 发送那一族（选路、`/compact` 的分叉、重连排队、没发出去的字）整片归
   * useSessionSend。它排在这里而不是上面：run 的参数要 `effectiveTarget` 与
   * `effectivePermissionMode`，排队与回落要 `status`，三样都在上面才算得出来。
   */
  const send = useSessionSend({
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
    // 自己开的这一轮，起点就是此刻 —— 那条 meta 的耗时从这里开始走。
    onOwnTurnStarted: () => liveTurn.beginTurn(Date.now()),
  });

  if (deviceError) {
    const alert = (
      <Alert variant="destructive">
        <AlertDescription>
          {deviceError instanceof ApiError
            ? deviceError.message
            : t("device.manage.loadError")}
        </AlertDescription>
      </Alert>
    );
    // 页面形态连壳一起报错；嵌入形态直接就地报错（外层容器给尺寸）。
    return isPage ? <AppShell>{alert}</AppShell> : alert;
  }

  /**
   * 改这条对话钉的模型。
   *
   * **两台都写**：同一条对话可以在桌面端与 agentred 上各有一份，而承载连接的那台
   * 未必是发起它的那台。只写承载者，用户在桌面端打开会看到另一个值；只写发起端，
   * 承载者下一轮解析不到它。
   *
   * 只写成一台**仍算成功**——那一次选择确实生效了，下一轮就用它——但要如实说出
   * 另一台没跟上。两台都没写成才回滚控件并说明原因。
   */
  function changeModelTarget(next: ModelTarget) {
    const previous = effectiveTarget;
    setModelTarget(next);
    setModelTargetNote(null);

    const c = clientRef.current;
    if (!c) return;
    const origin = originRef.current;
    const params = {
      conversationId: sid,
      providerKey: next.providerKey,
      modelKey: next.modelKey,
    };
    // 承载者：就是此刻这条连接。带上 origin 让它解出是哪条会话。
    const writes: Promise<unknown>[] = [
      c.request(rpcMethods.setModelTarget, {
        ...params,
        conversationId: params.conversationId,
        ...(origin ? { peerFingerprint: origin } : {}),
      }),
    ];
    // 发起端是另一台时再拨一条过去。够不着（离线 / 太老）就落在下面的「只成一台」。
    if (origin && origin !== device?.fingerprint) {
      writes.push(writeModelTargetToOrigin(origin, params));
    }
    void Promise.allSettled(writes).then((results) => {
      const ok = results.filter((r) => r.status === "fulfilled").length;
      if (ok === 0) {
        setModelTarget(previous);
        const reason = results.find((r) => r.status === "rejected")?.reason;
        setModelTargetNote(
          t("session.composerControls.modelSetFailed", {
            reason: reason instanceof Error ? reason.message : String(reason),
          }),
        );
        return;
      }
      setModelTargetNote(
        ok < results.length
          ? t("session.composerControls.modelPartiallySynced")
          : null,
      );
    });
  }

  /**
   * 会话行上钉的力度（空串 = 跟随后端配置）。来路与模型目标那两格同一条：执行端
   * 的会话摘要，那正是本页刚才双写过去的那一格。
   *
   * 它**不是**「有效档位」：有效档位由控件自己合成（会话值优先、否则后端配置），
   * 宿主这里不合成第二次。写入与回滚认的都是这一格 —— 会话行为空而后端配的是 high
   * 时，用户显式选 high 是一次真实写入，不是空操作。
   */
  const sessionReasoningEffort =
    reasoningEffort ?? identity?.reasoningEffort ?? "";
  /** 后端配置的那一档，会话行为空时由控件用它兜底显示（空 = 后端也没配）。 */
  const backendReasoningEffort = engineBackend?.reasoning_effort ?? "";

  /**
   * 改这条会话的思考力度（规格 2026-09-01「agentre-server 宿主」）。
   *
   * 与改模型逐条同构：**两台都写**（承载者是此刻这条连接，发起端另借一条），
   * 只写成一台仍算成功但要如实说出另一台没跟上，两台都没写成才回滚控件。
   * 不回滚的理由不是省事：那一次写入在承载者上真真切切生效了，下一轮就按它跑。
   */
  function changeReasoningEffort(next: ReasoningEffortValue) {
    const previous = sessionReasoningEffort;
    setReasoningEffort(next);
    setReasoningEffortNote(null);
    setReasoningEffortError(null);

    const c = clientRef.current;
    if (!c) return;
    const origin = originRef.current;
    const params = { conversationId: sid, reasoningEffort: next };
    const writes: Promise<unknown>[] = [
      c.request(rpcMethods.setSessionReasoningEffort, {
        ...params,
        ...(origin ? { peerFingerprint: origin } : {}),
      }),
    ];
    if (origin && origin !== device?.fingerprint) {
      writes.push(writeReasoningEffortToOrigin(origin, params));
    }
    void Promise.allSettled(writes).then((results) => {
      const ok = results.filter((r) => r.status === "fulfilled").length;
      if (ok === 0) {
        setReasoningEffort(previous);
        const reason = results.find((r) => r.status === "rejected")?.reason;
        setReasoningEffortError(
          t("session.composerControls.effortSetFailed", {
            reason: reason instanceof Error ? reason.message : String(reason),
          }),
        );
        return;
      }
      setReasoningEffortNote(
        ok < results.length
          ? t("session.composerControls.effortPartiallySynced")
          : null,
      );
    });
  }

  /**
   * 一轮还没跑完时，meta 栏的模型退到这一个 —— 就是底栏那颗 pill 此刻显示的名字。
   *
   * 消息自己的 `model` 只有终态帧一条来路（wire 上的 usage 帧没有这个字段），
   * 而那一帧要等一轮跑完才来。四态推导仍归共享包的 `resolveProviderPillState`
   * （pill 自己也调它），这里只取它算出来的那一格；失效（invalid）时留空：那时
   * pill 显示的就不是一个能用的模型，把它当成「这一轮用的是它」是在撒谎。
   */
  const modelPill = resolveProviderPillState({
    boundProviderKey: engineBackend?.provider_key,
    boundModelKey: engineBackend?.model_key,
    catalog: pickerCatalog,
    target: effectiveTarget,
  });
  const fallbackModel =
    modelPill.mode === "invalid" ? "" : modelPill.modelLabel;

  const reasoningEffortControl = supportsReasoningEffort ? (
    <SessionReasoningEffortControl
      value={sessionReasoningEffort}
      backendValue={backendReasoningEffort}
      onChange={changeReasoningEffort}
      note={reasoningEffortNote}
      errorText={reasoningEffortError}
    />
  ) : null;

  const modelControl = (
    <SessionModelControl
      backendType={summary?.backendType ?? ""}
      catalog={pickerCatalog}
      boundProviderKey={engineBackend?.provider_key}
      boundModelKey={engineBackend?.model_key}
      target={effectiveTarget}
      onChange={changeModelTarget}
      note={modelTargetNote}
    />
  );

  /**
   * 这条对话叫什么。派生走 lib/sessionView 的 sessionTitle —— 索引与总览都走那一处，
   * 详情页不另立一套：没有标题的老会话在索引上退化为「工作目录 · 后端 · 状态」，
   * 这里此前却写死 `#<会话号>`，同一条对话于是在列表里叫一个名字、点进去叫另一个。
   *
   * 摘要两条来路都还没落地时先用宿主给的那个名字（`initialTitle`：左栏那一行的
   * 标题、或草稿刚派发出去的第一句）—— 那一刻连后端和状态都拿不出来，退化式会摆
   * 成一行「— · — · 闲置」，而这个名字是现成的、也是对的。宿主也给不出时才退回
   * `#<身份前 8 位>`：那一刻确实什么都还不知道，一个诚实的短号好过编一个名字。
   * 只摆前 8 位——整串 uuid 是 36 个字符，摆进标题里既认不出也放不下。
   */
  const displayTitle = identity
    ? sessionTitle(identity, t)
    : (initialTitle?.trim() ?? "") || `#${sid.slice(0, 8)}`;

  const agent = identity?.agentSyncId
    ? (agents.find((a) => a.sync_id === identity.agentSyncId) ?? null)
    : null;

  /**
   * 这条对话归哪个项目。
   *
   * 两条来路各答各的，所以不是简单地跟着 identity 走：中继摘要上那一格是**发起端
   * 自己报的**（桌面端开的对话有，agentred 开的多半没有），镜像那一行上的是**服务端
   * 按 cwd 与项目树就地判定的**（决策 12）。实况优先、空了退到镜像 —— 两边都空才是
   * 「这条对话不属于任何项目」。
   *
   * 解不出名字（项目树还没落地、或那个项目已不在账号里）时不摆这一维：拿 sync id
   * 顶上去只会在头部留一串谁也认不出的标识。
   */
  const projectSyncId =
    identity?.projectSyncId || mirrorSummary?.projectSyncId || "";
  const project = projectSyncId
    ? (projects.find((p) => p.syncId === projectSyncId) ?? null)
    : null;

  /**
   * 名字还在路上：**已知**这条对话有 Agent（agentSyncId 在手），只是账号的 Agent
   * 清单还没落地。转录只要有消息就先铺出来，不等这个名字（内容比抬头重要），所以
   * 这段空窗真实存在 —— 期间摆中性抬头就会闪一下再换成真名。
   *
   * 清单问过之后仍解不出（老会话、或那个 Agent 已不在账号里）不算空窗：那是终局，
   * 照旧退回中性抬头。
   */
  const agentPending = Boolean(identity?.agentSyncId) && !agentsSettled;

  /**
   * 头部与转录共用同一枚头像，走共享包的 AgentAvatar（与桌面端 chat.tsx 同一枚
   * 记号）。解不出 Agent 时不摆（不画一个没有身份的方块）。转录那一档尺寸套包的
   * MESSAGE_AVATAR_CLASS 与行排版对齐。
   *
   * 此前这里是就地手搓的一枚方块，缺的正是包里那条兜底：**没设过颜色**的 Agent
   * （同步载荷里根本没有 avatar_color，桌面端不逼用户选色）拿不到 backgroundColor，
   * 方块透明、白字落在深色底上 —— 看着就是一枚黑方块，而同一个 Agent 在左栏索引
   * 里是蓝的（那边一直走 AgentAvatar，缺色退回 agent-1）。
   */
  const agentAvatar = (size: "md" | "row") =>
    agent ? (
      <AgentAvatar
        name={agent.name}
        // 首字母原样取（不大写）：中文名没有大小写，拉丁名这里也与桌面端一致。
        initials={agent.name.charAt(0)}
        color={agent.avatar_color}
        icon={iconNode(agent.avatar_icon)}
        size="md"
        className={size === "row" ? MESSAGE_AVATAR_CLASS : undefined}
      />
    ) : size === "md" ? (
      /* 认不出 Agent（账号名单还没回来、或这条老会话上根本没有 agentSyncId）时
         头部那一格**照样占住**——与桌面端 chat-panel-header 同一条。整格不渲染的
         话标题会横向跳一格（32px + 12px 间距），同一条对话打开的头一瞬和之后长得
         不是一个样。转录里的那一档没有这个问题：那里本来就按有没有头像排版。 */
      <div
        aria-hidden="true"
        data-testid="session-detail-avatar"
        className="size-8 shrink-0 rounded-lg bg-muted"
      />
    ) : null;

  // 在 JSX 之外先算好：i18next/no-literal-string 会把 JSX 里的 agentAvatar("md")
  // 当成一段裸文案报出来。
  const headerAvatar = agentAvatar("md");
  const rowAvatar = agentAvatar("row");

  /*
    三带：头部 / 转录 / Composer。

    此前是一整块滚动区，头部、转录、审批、Composer 依次排下来共用一个
    `overflow-y-auto`——转录一长，Composer 就跟着被卷出屏幕（量下来页面高 2145px、
    视口 900px，输入框在折线以下 1245px）。要回复得先滚到底，而转录还在往下长，
    等于永远追不上。现在头部与 Composer 各自 shrink-0 钉住，只有中间那一带滚。
  */
  const header = (
    <SessionDetailHeader
      isPage={isPage}
      did={did}
      sid={sid}
      identity={identity}
      agent={agent}
      project={
        project && {
          name: project.name,
          color: project.color,
          icon: project.icon,
        }
      }
      avatar={headerAvatar}
      displayTitle={displayTitle}
      machineName={device?.name}
      machineOnline={machineOnline}
      status={status}
      // 「这一轮在不在跑」认 `turnActive`：它的起点就是 attach 那一刻的
      // `lifecycleState`（见上面 markTurnActive 那处），此后每一个轮次边界都往里
      // 写 —— 自己发送 / 别的端的自主续轮开起来、终态帧收掉。`summary` 相反只在装载
      // 与每一轮**落定**时各取一份，轮次进行中它答不出「此刻在不在跑」。
      running={running}
      decisionPending={decisionPending}
      headerRight={headerRight}
      clientRef={clientRef}
      originRef={originRef}
    />
  );

  /** 滚的只有这一带。转录、状态横幅与审批卡都在里面，头部与 Composer 都不在。 */
  const scrollBody = (
    <SessionScrollBody
      sid={sid}
      scrollRef={scrollRef}
      contentRef={scrollback.contentRef}
      onScroll={scrollback.onScroll}
      onUserScroll={scrollback.noteUserScroll}
      getScrollElement={scrollback.getScrollElement}
      atBottom={scrollback.atBottom}
      bottomVisibleId={scrollback.bottomVisibleId}
      jumpToBottom={scrollback.jumpToBottom}
      earlier={scrollback.earlier}
      onLoadEarlier={scrollback.retryEarlier}
      status={status}
      machineName={device?.name}
      machineLastSeenMs={device?.last_seen_at}
      onReconnect={reconnect}
      relayState={relayState}
      history={history}
      seeded={seeded}
      ready={ready}
      catchUpFailed={catchUpFailed}
      messages={messages}
      localFingerprint={relayTicket?.clientId}
      agentName={agent?.name}
      agentAvatar={rowAvatar}
      agentPending={agentPending}
      fallbackModel={fallbackModel}
      liveTurnTiming={liveTurn.timing}
      streaming={running}
      pendingAssistant={pendingAssistant}
      decisions={decisions}
      send={send}
    />
  );

  const composerBand = (
    <SessionComposerBand
      did={did}
      sid={sid}
      status={status}
      atBottom={scrollback.atBottom}
      machineName={device?.name}
      backendType={summary?.backendType}
      agents={agents}
      messages={messages}
      contextWindow={sessionRuntime.contextWindow}
      sending={send.sending}
      // 自己按下的发送把视口带回底部：他要看的东西（排队气泡、这条消息本身、
      // 助手的三个点）全落在最底下。往回翻着看时不被**对端**拽走那条规矩不受
      // 影响 —— 那一条防的是别人说话，这一下是他自己说话。
      onSubmit={(text, images) => {
        scrollback.pinToBottom();
        void send.sendMessage({ text, images });
      }}
      permissionMode={effectivePermissionMode}
      permissionModeMeta={permissionModeMeta}
      permissionError={permissionError}
      onPermissionModeChange={changePermissionMode}
      modelControl={modelControl}
      reasoningEffortControl={reasoningEffortControl}
      sendFeedback={turn.sendFeedback}
    />
  );

  const bands = (
    <div
      data-testid="session-detail-view"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {header}
      {scrollBody}
      {composerBand}
    </div>
  );

  // 路由页形态：壳交出整块主区（flush），三带自己铺满它。
  if (isPage) {
    return (
      <AppShell title={displayTitle} flush>
        {bands}
      </AppShell>
    );
  }

  // 嵌入形态（桌面 Chat 右栏）：无壳，垂直填满外层容器。
  return bands;
}
