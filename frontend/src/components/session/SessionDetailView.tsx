import { rpcMethods } from "@agentre-hub/agentre-wire";
import {
  EventSteerConsumed,
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
  type ChatComposerHandle,
  type ModelTarget,
  type PreviewAnchor,
  type ReasoningEffortValue,
} from "@agentre-hub/agentre-ui";

import AppShell from "@/components/AppShell";
import SessionDetailHeader from "@/components/session/SessionDetailHeader";
import SessionComposerBand from "@/components/session/SessionComposerBand";
import SessionFilePreviewColumn from "@/components/session/SessionFilePreviewColumn";
import SessionScrollBody from "@/components/session/SessionScrollBody";
import { useFilePreviewTabs } from "@/components/session/useFilePreviewTabs";
import SessionModelControl from "@/components/session/SessionModelControl";
import SessionReasoningEffortControl from "@/components/session/SessionReasoningEffortControl";
import { turnDoneFrames } from "@/components/session/turnDone";
import {
  useReconnectProbe,
  useSessionTargetDevice,
} from "@/components/session/useSessionTargetDevice";
import { useAliveEffect } from "@/hooks/use-api-query";
import { useRelayChannel } from "@/hooks/use-relay";
import {
  TranscriptSessionId,
  appendFrames,
  pendingUserMessage,
  toTranscriptFrame,
  type SessionEventFrame,
} from "@/components/session/transcriptFrame";
import { nextPreviewTail } from "@/components/session/previewTail";
import { conversationTarget, machineTarget } from "@/lib/relayTarget";
import { api, ApiError } from "@/lib/api";
import {
  decodePermissionModeMeta,
  decodeReasoningEffortSupport,
  type PermissionModeMeta,
} from "@/lib/backendCapabilities";
import { useEngineCatalog } from "@/lib/engineCatalog";
import { fetchProjects, type ProjectNode } from "@/lib/projects";
import {
  classifySendFailure,
  deriveSessionViewStatus,
  sessionTitle,
} from "@/lib/sessionView";
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
  consumedSteerRefs,
  useSteerQueue,
} from "@/components/session/useSteerQueue";
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
   * 这条对话属于哪个 Agent —— **宿主已经知道的那一份**（草稿页刚挑的那个）。
   *
   * 与 `initialTitle` / `initialUserText` 同一条路子：那一屏手里现成的东西，没有理由
   * 让用户在这里再等一圈网络。名字要两条链式的异步才解得开（先由镜像行 / `session.list`
   * 认出 agentSyncId，再拿它去账号清单换名字与头像），期间抬头一个字都说不出。
   *
   * 只是**种子**，不改判定：身份一落地就以实况为准（见下面 `agent` 那处的取舍）。
   * 给不出时（点左栏一行、从 URL 直接进来）照旧自己解，不猜。
   */
  initialAgent?: {
    sync_id: string;
    name: string;
    avatar_color?: string;
    avatar_icon?: string;
  };
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
  initialAgent,
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
  /**
   * 预览尾巴：这一刻还没定稿、只用于逐 token 呈现的那几帧（协议 0.2.0 的预览帧）。
   *
   * 它与 `events` 分开存，因为两者的寿命不同：`events` 是转录本身、只增不减；尾巴在
   * 每个持久帧到达时清空。规则与理由都在 previewTail.ts。
   */
  const [previewTail, setPreviewTail] = useState<SessionEventFrame[]>([]);
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
   * 输入框的整条草稿句柄。眼下只有一个用途：轮末没被取走的那几条，用户点「恢复为
   * 草稿」时把那段字放回输入框（草稿页的「快捷开头」用的是同一只句柄）。
   */
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
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
  /**
   * 转录里点开的文件预览（规格 2026-09-08）。标签状态住在宿主，取数经中继。
   *
   * `previewFileRef` 让端口对象不必随 cwd / 连接状态重建：能不能预览是**点下去
   * 那一刻**的事实，由 ref 后面这个函数当场回答。答 false 时包不会开面板。
   */
  const preview = useFilePreviewTabs();
  const previewCwdRef = useRef("");
  const previewFileRef = useRef<
    (path: string, anchor?: PreviewAnchor) => boolean
  >(() => false);
  /**
   * 两个 ref 在**提交之后**同步，不在渲染期写（react-hooks/refs：渲染期读写 ref
   * 会让 React 的一致性假设失效）。这对语义没有损失：链接点下去那一刻已经过了
   * 提交，读到的就是当下这一版 cwd。
   */
  useEffect(() => {
    previewCwdRef.current = summary?.cwd ?? "";
    previewFileRef.current = (path: string, anchor?: PreviewAnchor) => {
      // 没有实况 cwd 就没有工作根可读 —— 答 false，包据此不出入口。
      if (!previewCwdRef.current) return false;
      // 定位目标（链接里写的 `:311-330`）跟着一起进标签：这一层不解释它，面板
      // 拿到之后才去滚编辑器。
      preview.open(path, anchor);
      return true;
    };
  });

  const decisions = useSessionDecisionPorts({
    sid,
    clientRef,
    originRef,
    previewFileRef,
  });

  /**
   * 轮次状态（转录的三点、占位）整片归 useTurnActivity。
   * 它排在中继之前：onRunResultDone / onAutonomousTurnStarted 与 attach 都要写它。
   */
  const turn = useTurnActivity(sid);
  /**
   * 这一轮里排着的那几条插话（规格 2026-09-08-console-steer-queue）。它排在发送
   * 那一族之前：走 steer 的那条路要往里挂条目，中继回调要从里面消费。
   */
  const steerQueue = useSteerQueue();
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
    setPreviewTail([]);
    decisions.reset();
    // 换目标就是换了一批文件：上一条开着的预览标签不能漏到下一条里。它跟着这
    // 一族一起清，而不是自己再开一格按 sid 判定的状态 —— 会话标识是各端本地自
    // 增的（见 relayClient 的游标注释），(did=A, sid=42) 与 (did=B, sid=42) 是
    // 两条不同机器上的对话；只看 sid 的话切过去时标签留着、cwd 却已清空，右栏
    // 当场拿一个空 root 去读，等 B 的摘要落地又把 A 的 relPath 读成 B 的文件。
    preview.reset();
    turn.reset();
    // 排着的那几条属于**那一条**会话（而且只是这一屏本地的乐观状态）：跟着重来。
    steerQueue.reset();
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
   *
   * 但「认领落定」说的是**这条对话在不在账号里**有了答案，不是「转录读回来了」。
   * 这两件事此前共用 `history.settled` 一格，而它要等 `/v1/agent-sessions/transcript`
   * 整趟回来才翻真 —— 账号那一行早在这之前就到手了（宿主直接递下来的话渲染期就有）。
   * 于是每切一条对话都白等一趟 HTTP 才开始连，而 `deriveSessionViewStatus` 把「目标
   * 还没定下来」读作 connecting，头部整段摆着一枚转圈的芯片和一条扫过底边的进度条，
   * 说着一件此刻根本没在发生的事（联调机上实测 120ms）。所以答得出的时候就走：
   * 账号里有这一行是**肯定**的答案，不会再被那一趟转录改口。
   *
   * 排序因此翻了过来 —— 只有「按机器寻址」那一支还等 `history.settled`：它是**否定**
   * 的答案（账号里没有这一行），而否定要等那一趟真的问完才成立。
   *
   * 补齐的先后不受影响：attach 那只 effect 自己也守着 `history.settled`（镜像那一段
   * 不走客户端的游标去重，必须先落地）。这里提前的只是**把通道开出来**。
   */
  const savedInAccount = initialRow !== undefined || mirrorSummary !== null;
  const relayTarget = savedInAccount
    ? conversationTarget(sid)
    : !history.settled
      ? null
      : device?.online
        ? machineTarget(device.fingerprint)
        : null;

  /**
   * 这条会话来了一帧 —— **两级帧共有**的那一半。
   *
   * 协议 0.2.0 把同一段正文发两次:逐 token 的预览帧在前,块定稿之后才是那份带 seq
   * 的持久帧(见 `previewTail.ts`)。两级的分工只在「进不进转录的定稿部分」;下面这
   * 两件事对两级是同一件事,因此只写一遍:
   *
   *   - **计时吃这一帧**。首字什么时候到、工具在跑的那几段不算生成,都只有帧说得清;
   *     首字更是只有逐 token 那一路说得准 —— 块边界那一路量出来的是整块**写完**的
   *     时刻。
   *   - **撤掉助手占位**。判据是「助手真的开口了」,不是「又来帧了」:一轮的第一帧是
   *     daemon 把用户自己那句话回声回来,拿它撤占位等于对端还没说话就把三点熄了,而
   *     这一轮再没有别的东西能重新点亮它。
   *
   * 后者此前只接在持久那一路上,而助手开口的第一帧**几乎总是预览帧** —— 一段两千多
   * 字的思考,从第一个 token 到那一块定稿隔着十几秒。这十几秒里屏幕上是**两条**助手
   * 消息:上面那条正逐字长出思考,下面那条空占位转着三点、还挂着这一轮的耗时。用户
   * 看到的就是「一次回复分成了两个气泡,而上面那个好像还在写」。
   *
   * 转录本来就把两级喂进同一个投影器(`framesForProjection`),这里只是让判据接到
   * 同一份输入上,而不是各认各的一路。
   */
  const noteFrameArrived = (frame: SessionEventFrame) => {
    liveTurn.noteFrame((frame.event as { kind?: string } | undefined)?.kind);
    if (opensAssistantMessage(frame, TranscriptSessionId))
      turn.setPendingAssistant(false);
  };

  const {
    client,
    relayState,
    relayTicket,
    relayTicketError,
    handshakeRejection,
    reconnect,
  } = useRelayChannel(relayTarget, {
    onEvent: (f, at) => {
      const kind = (f.event as { kind?: string } | undefined)?.kind;
      if (f.conversationId === sid) {
        const frame = toTranscriptFrame(f, at);
        // 经 appendFrames 而不是裸追加：这一趟的游标要与镜像末尾对齐（见下面 attach
        // 那一段），压回去之后补齐会把已经实时收到的那几帧再送一遍。
        setEvents((prev) => appendFrames(prev, [frame]));
        // 这一段正文定稿了：尾巴里攒着的预览此刻已经被它覆盖，留着就是渲染两遍。
        setPreviewTail((prev) => nextPreviewTail(prev, false));
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
        noteFrameArrived(frame);
      }
      // 审批/提问事件到达时刷新待决策:DecisionPanel 的数据源是 pendingWaiters,
      // 不是事件流 —— 不主动重拉,审批卡就永远不出现(fake runtime 阻塞在审批上,
      // run 不会结束,onRunResultDone 那一条刷新路径到不了;R10)。
      // 后端取走了排着的那几条:它们此刻已经进转录了,chip 该消失。按句柄消费,
      // 对不上的(别的端排的)归约会原样放过。同一帧可能以预览与持久两种形态各到
      // 一次,重复消费是空操作。
      if (kind === EventSteerConsumed && f.conversationId === sid) {
        steerQueue.consume(consumedSteerRefs(f.event));
      }
      if (kind === "tool_permission_request" || kind === "ask_user_question") {
        decisions.requestWaitersRefresh();
      }
    },
    /**
     * 预览帧：逐 token 呈现的那一路（协议 0.2.0）。
     *
     * 它不进 `events` —— 转录与游标的唯一来源是持久帧。它只进尾巴，随下一个持久帧
     * 一起消失。计时也吃它：首字到底什么时候到，只有逐 token 这一路说得清；块边界
     * 那一路量出来的「首字」是整块写完的时刻。轮末的权威数字仍由终态帧覆盖。
     */
    onPreviewEvent: (f, at) => {
      if (f.conversationId !== sid) return;
      const frame = toTranscriptFrame(f, at);
      setPreviewTail((prev) => nextPreviewTail(prev, true, frame));
      noteFrameArrived(frame);
    },
    onRunResultDone: (frame) => {
      turn.markTurnActive(false);
      // 收表:终态帧自带的那几个数是 agentred 就着自己扇出的事件流量的,比浏览器
      // 这边隔着一条中继数出来的准,接下来画的是它们。
      liveTurn.endTurn();
      turn.setPendingAssistant(false);
      setEvents((prev) => [...prev, ...turnDoneFrames(sid, frame)]);
      // 这一轮结束时还排着的那几条:不静默清掉。它们要么被 drain 成下一轮(那时
      // steer_consumed 会把 chip 清掉),要么就是真的没被任何人取走 —— 后一种把
      // 用户刚敲的字悄悄抹掉、且无从补救(规格决策 4)。
      steerQueue.endTurn();
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
          // 点名要这一条,而不是把整台机器的清单翻一遍去找它:那台机器上可能有
          // 几千条对话,而这里从头到尾只关心一条。
          const listRaw = await client.request(rpcMethods.sessionList, {
            conversationIds: [sid],
          });
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
          //
          // 对齐而不是抬高。游标是**客户端**的账，而客户端是池子里共用的那一个
          // （空闲宽限 30s，切走再切回借到的正是它）：离开期间没有任何监听者，它
          // 照样在消费这条会话的帧、游标一路往前走。切回来时右栏那次重置只清得掉
          // `events`，历史从镜像重读，而镜像落库慢一拍——游标于是停在镜像末尾**前面**
          // 的位置，「镜像末尾 → 游标」那一段谁都不再交付：补齐只拉游标之后的。
          // 屏幕上就是几条消息凭空少了，只有刷新页面（新客户端游标从 0 起）才回来。
          //
          // 所以这一趟画的转录起点是哪儿，游标就该在哪儿：高了是洞，低了是重复，
          // 而重复由 `appendFrames` 按 seq 挡掉，洞没有任何东西补得上。
          if (
            mirrorSeqRef.current > 0 &&
            client.getCursor(sid, origin) !== mirrorSeqRef.current
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
          // 帧高水位比镜像里这一段低。游标停在高水位上面的话，此后每一条实时帧都
          // 「不大于游标」被当成重复丢光——会话没有报错、也没有跳号地冻住。attach 交回
          // 来的 latestSeq 就是执行端此刻的高水位，据它复位（桌面端 reconnect.go 的
          // dropCursorAboveHighWater 同一条规则）。
          if (latestSeq > 0 && latestSeq < client.getCursor(sid, origin)) {
            client.setCursor(sid, latestSeq, origin);
          }
          // 账号里没有这一份（未保存的对话，机器轴上的大多数）：内容只有中继给得出，
          // 而从游标 0 补齐就是把整份转录拉回来。按对端交回的高水位反推起点，
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
            // 清单快照那一档：说得出「此刻在不在跑」，说不出「刚有动静」——
            // 左栏因此只点亮、不改这一行的时间与位置（见 seedLiveTurn）。
            markTurnActive(running, true);
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
          // 同上:每跑完一轮刷新摘要,点名要这一条 —— 此前这里每轮都把整台机器的
          // 清单拉一遍,是这条路上最频繁的一次搬运。
          const list = sessionListFromProtobuf(
            await client.request(rpcMethods.sessionList, {
              conversationIds: [sid],
            }),
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
    // 对端按协议版本拒了握手：中继那一侧已经不再重试，所以这一屏不能再按 relayState
    // 说话——否则就是拿「连接断了 + 重新连接」去讲一件重拨一万次也不会变的事。
    protocolMismatch: handshakeRejection !== null,
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
  /**
   * 喂给投影器的帧序列：定稿的转录 + 还没定稿的预览尾巴。
   *
   * 尾巴清空时数组会**变短**，投影器据此退回整段重算（见共享包 project 的 extended
   * 判据）—— 正是要的：那一批预览帧不该留在增量状态里。逐 token 期间数组只增长，
   * 仍走增量，所以每个 token 不会引发全表重算。
   */
  const framesForProjection = useMemo(
    () => (previewTail.length === 0 ? events : [...events, ...previewTail]),
    [events, previewTail],
  );
  const projected = useMemo(
    () => projector.project(framesForProjection),
    [projector, framesForProjection],
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
  /**
   * attach 把这条会话的实况接回来了 —— 交接那一段到此为止。
   *
   * 「实况」不等于「读到了内容」：清单快照、补齐、以及据此定下的 `turnActive` 全在
   * 那条 effect 的末尾一起落地（见上面 markTurnActive 那处）。在它之前，这一屏关于
   * 这条会话唯一确定的事就是宿主刚交接过来的那两样。
   *
   * 失败也算落定：补齐失败时 `ready` 永远不为真，只认它的话交接那一段会一直挂着，
   * 而那时页面已经在说读不到了。
   */
  const attachSettled = ready || catchUpFailed;
  /**
   * 宿主交接过来的那句话，在 attach 落定之前一直算数。
   *
   * 与 `seeded` 的差别正是这个 bug：`seeded` 说的是「此刻画的是不是那条接力消息」，
   * 它在第一帧落地那一刻就到期 —— 而第一帧（daemon 把用户那句话回声回来）恒早于
   * 补齐结束。拿它当「转录有东西可摆」的判据，回声一到整段转录就被换成读取骨架，
   * 一拍之后 `ready` 到了再换回来。
   */
  const handedOverText = initialUserText != null && !attachSettled;
  /**
   * 这一轮在不在跑。
   *
   * 两条来路各管一段时间，说的不是同一件事：
   *
   *   - `turn.turnActive` —— attach 把实况接回来**之后**的权威判据（起点是清单快照
   *     的 `lifecycleState`，此后每个轮次边界往里写）。补齐会回放历史里的终态帧，
   *     所以它刻意排在补齐之后（见上面 markTurnActive 那处）—— 也就是说，在 attach
   *     落定之前它答不出这一格。
   *   - `handedOverTurn` —— 在那之前唯一说得出话的：这一轮正是这个浏览器几百毫秒前
   *     亲手派发的（草稿页交出 `turnStartedAt` 的那一刻），这件事没有比此刻更确定
   *     的时候。
   *
   * 交接那一段**必须**由后者一路兜到 attach 落定为止。此前这里兜底的是 `seeded`，
   * 而它是个**渲染**判据（「投影出来的转录还是空的」）：第一帧一落地它就到期，而
   * 第一帧恒早于补齐结束 —— daemon 把用户那句话回声回来是这一轮的第一帧，补齐还在
   * 往返。中间那段空窗谁都不认账，于是三点、头上那颗点与「停止」一起熄掉再亮：
   * 用户看到的就是「AI 生成中」闪了一下。
   *
   * 落定认 `ready || catchUpFailed` 而不只是 `ready`：补齐失败时 `ready` 永远不为真，
   * 只认它的话这一格会一直亮着，而那时页面已经在说读不到了。
   *
   * 不校验交接时刻的新鲜度（计时那一只要校验，见 useLiveTurnTiming 的
   * SEEDED_START_MAX_AGE_MS）：那一只画的是**一个数**，拿过期时刻开表会画出
   * 「已经跑了十分钟」；这一格只是个布尔、只活到 attach 落定为止，判错的代价是几百
   * 毫秒的一颗点，紧接着就被实况纠正。渲染期也读不了 `Date.now()`。
   */
  const handedOverTurn = initialTurnStartedAt != null && !attachSettled;
  const running = turn.turnActive || handedOverTurn;

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

  // 会话级状态（上下文窗口 / 权限模式 / 上游重试）不进转录正文，单独归约一遍。
  // 落点不止底栏：前两样归 Composer，retry 归转录末行那张卡。
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
   * 撤回一条排着的插话（空句柄 = 清空整条队列）。
   *
   * 撤掉了哪几条**由对端说了算**：按它返回的 removed 移除，不点一下就乐观清掉 ——
   * 它可能刚好在这一瞬被后端取走了。撤不掉时那条留在原位、转成锁住，并把对端那句
   * 已本地化的原话挂上去（规格 2026-09-08「撤销」）：撤不动最常见的原因就是它已经
   * 被取走，而那时紧接着的 steer_consumed 会把它清掉。
   *
   * 目标会话在途中换了也无所谓：换会话会把整份队列重置，而句柄是随机的，落在新
   * 队列上不会误伤任何一条。
   */
  const cancelQueued = useCallback(
    async (queuedId: string) => {
      const c = clientRef.current;
      if (!c) return;
      try {
        const result = (await c.request(rpcMethods.runtimeCancelSteer, {
          conversationId: sid,
          ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
          queuedId,
        })) as { removed?: string[] } | undefined;
        steerQueue.drop(result?.removed ?? []);
      } catch (err) {
        const detail = classifySendFailure(err).detail;
        if (queuedId) {
          steerQueue.refuseCancel(queuedId, detail);
          return;
        }
        // 清空整条队列被拒：这一条命令说的是所有条目，逐条标记。
        for (const item of steerQueue.items) {
          steerQueue.refuseCancel(item.id, detail);
        }
      }
    },
    [sid, steerQueue],
  );

  /**
   * 轮末没被取走的那几条，用户选择领回去：把文本放回输入框草稿。
   *
   * 与桌面端那一颗同名键落点不同（那边放回队列），因为这一轮已经结束了——放回队列
   * 的话没有任何人会来取（规格决策 5）。多条按排队顺序拼接，中间空行分隔。
   */
  const restoreDropped = useCallback(() => {
    const text = steerQueue.dropped.map((q) => q.text).join("\n\n");
    if (text) composerHandleRef.current?.restoreDraft(text, []);
    steerQueue.clearDropped();
  }, [steerQueue]);

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
    steerQueue,
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

  /**
   * 底栏那颗模型 pill。**这条对话是谁还没解开时不摆**（`identity` 为 null）：
   * 它认的是 identity 上的 providerKey / modelKey，而「两格皆空」在这套三态里是一个
   * 有名字的态（跟随 Agent 绑定，脸上那枚 👤）—— 空窗里两格当然是空的，摆出去就是
   * 拿「还不知道」冒充一次配置事实，等真钉的模型到了再换掉。
   *
   * 与头部的项目那一格同一条规矩（解不出就不摆这一维）。少的那一段里也没什么可做：
   * 发送本来就要 `summary` 才走得动，而那一刻 identity 必然已经非空。还顺带堵掉一处
   * 不只是好看不好看的事 —— 那一段里改模型写失败要回滚，回滚的落点正是这份假的
   * 「跟随绑定」。
   */
  const modelControl = identity ? (
    <SessionModelControl
      backendType={summary?.backendType ?? ""}
      catalog={pickerCatalog}
      boundProviderKey={engineBackend?.provider_key}
      boundModelKey={engineBackend?.model_key}
      target={effectiveTarget}
      onChange={changeModelTarget}
      note={modelTargetNote}
    />
  ) : null;

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

  /**
   * 这条对话的 Agent。**实况优先、宿主那份种子垫底**（与 `identity` 同一条规矩）。
   *
   * 种子只在这条对话还没自己说出它属于谁、或说出来的正是同一个时才算数：身份落地
   * 后若指向另一个 Agent（或明说没有），那是实况，种子让位 —— 它是为了填掉空窗，
   * 不是为了盖住答案。
   */
  const resolvedAgent = identity?.agentSyncId
    ? (agents.find((a) => a.sync_id === identity.agentSyncId) ?? null)
    : null;
  const seededAgent =
    initialAgent &&
    (!identity?.agentSyncId || identity.agentSyncId === initialAgent.sync_id)
      ? initialAgent
      : null;
  const agent = resolvedAgent ?? seededAgent;

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
   * 名字还在路上。转录只要有消息就先铺出来，不等这个名字（内容比抬头重要），所以
   * 这段空窗真实存在 —— 期间摆中性抬头就会闪一下再换成真名。
   *
   * 两条异步各自到齐才解得开，因此空窗有两半：
   *
   *   - **已知**这条对话有 Agent（agentSyncId 在手），只是账号的 Agent 清单还没落地。
   *   - 这条对话**是谁**还没解开（`identity` 为 null）：账号镜像那一行还没认领回来、
   *     中继的 `session.list` 也还没回来。此刻 `agentSyncId` 取不出，不是因为这条
   *     对话没有 Agent，而是因为什么都还不知道 —— 把这两件事当成一件，交接那一拍
   *     （草稿页递过来 `initialUserText`，就地铺出用户那句话与三点）抬头
   *     就顶着「Assistant」和一枚「A」方块，等身份解开再换成真名与真头像。
   *
   * 问过之后仍解不出不算空窗，那是终局，照旧退回中性抬头：老会话的镜像行上根本没有
   * agentSyncId（identity 在手而那一格是空的），或清单落地后那个 Agent 已不在账号里。
   */
  const agentPending = identity
    ? Boolean(identity.agentSyncId) && !agentsSettled
    : true;

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
      agentPending={agentPending}
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
      // 「这一轮在不在跑」认 `running`（见上面它那处：attach 落定之后是 `turnActive`，
      // 之前是宿主交接过来的那一轮）。`summary` 答不出这一格 —— 它只在装载与每一轮
      // **落定**时各取一份，轮次进行中它说的是上一次落定时的事。
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
      cwd={summary?.cwd}
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
      protocolMismatchDetail={handshakeRejection ?? undefined}
      onReconnect={reconnect}
      relayState={relayState}
      history={history}
      handedOver={handedOverText}
      ready={ready}
      catchUpFailed={catchUpFailed}
      messages={messages}
      localFingerprint={relayTicket?.peerFingerprint}
      agentName={agent?.name}
      agentAvatar={rowAvatar}
      agentPending={agentPending}
      fallbackModel={fallbackModel}
      liveTurnTiming={liveTurn.timing}
      liveRetry={sessionRuntime.retry}
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
      // Skill 补全要问的三样事实。`identity` 而不是 `summary`：镜像先于实时清单
      // 落地，输入框不必等那一趟往返才拿得到补全。
      agentSyncId={identity?.agentSyncId}
      targetFingerprint={device?.fingerprint}
      cwd={identity?.cwd}
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
      queued={steerQueue.items}
      droppedQueue={steerQueue.dropped}
      onCancelQueued={(id) => void cancelQueued(id)}
      onClearQueued={() => void cancelQueued("")}
      onRestoreDropped={restoreDropped}
      onDiscardDropped={steerQueue.clearDropped}
      composerHandleRef={composerHandleRef}
    />
  );

  const bands = (
    <div
      data-testid="session-detail-view"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {header}
      {/*
        分栏切在头带**之下**（设计源 agentre.pen 的 B1）：头带横跨整列，转录与
        输入带一起留在左栏，预览栏定宽 420 贴右。没有当前标签时右栏整个不渲染，
        转录自动回到全宽 —— 不另设一个「收起」状态。
      */}
      <div className="flex min-h-0 flex-1 flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {scrollBody}
          {composerBand}
        </div>
        <SessionFilePreviewColumn
          sid={sid}
          cwd={summary?.cwd ?? ""}
          client={client}
          deviceName={device?.name}
          /*
           * 这枚点目前**只能**取账号侧那条设备记录，而它是慢节奏的。
           *
           * 运行期实测（2026-09-08，把那台机器的 agentred 停掉）：内容区已经写着
           * 「这台机器现在够不着」，这枚点仍然绿着，`machineOnline` 同样 90 秒没翻
           * —— 两个候选来源都不反映「此刻读得到读不到」。唯一当场知道这件事的是
           * 面板自己那次 offline 失败，而那个事实在包内部，宿主拿不到。
           *
           * 真正的修法是让共享面板用它自己的失败态点亮这枚点（跨仓一轮）；在那之前
           * 这里如实保留账号视角，并把偏离记在验证报告里。
           */
          deviceOnline={device?.online}
          tabs={preview.tabs}
          activePath={preview.activePath}
          segment={preview.activeSegment}
          // 轮次一落定就重读：预览的正是 agent 刚改过的那些文件（桌面端接的
          // doneTick 同一条口径）。turnEpoch 只认实时那一遍，补齐不点火。
          refreshToken={turnEpoch}
          revealTarget={preview.activeReveal ?? undefined}
          onActivate={preview.open}
          onPromote={preview.promote}
          onTogglePin={preview.togglePin}
          onSegmentChange={preview.setSegment}
          onClose={preview.close}
          onCloseOthers={preview.closeOthers}
          onCloseAll={preview.closeAll}
        />
      </div>
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
