import { rpcMethods } from "@agentre-hub/agentre-wire";
import {
  decodeSessionListResult,
  SessionLifecycleRunning,
  type EventFrame,
  type SessionSummary,
} from "@agentre-hub/agentre-wire";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  MESSAGE_AVATAR_CLASS,
  tokenToCssColor,
  Alert,
  cn,
  createTranscriptProjector,
  opensAssistantMessage,
  reduceSessionState,
  type ModelTarget,
} from "@agentre-hub/agentre-ui";

import AppShell from "@/components/AppShell";
import SessionDetailHeader from "@/components/session/SessionDetailHeader";
import SessionComposerBand from "@/components/session/SessionComposerBand";
import SessionScrollBody from "@/components/session/SessionScrollBody";
import SessionModelControl from "@/components/session/SessionModelControl";
import {
  useReconnectProbe,
  useSessionTargetDevice,
} from "@/components/session/useSessionTargetDevice";
import { useAliveEffect } from "@/hooks/use-api-query";
import { useRelayMachine } from "@/hooks/use-relay";
import { api, ApiError } from "@/lib/api";
import {
  decodePermissionModeMeta,
  type PermissionModeMeta,
} from "@/lib/backendCapabilities";
import { useEngineCatalog } from "@/lib/engineCatalog";
import { deriveSessionViewStatus, sessionTitle } from "@/lib/sessionView";
import {
  loadMirrorTail,
  mirrorRowToSummary,
  resolveMirrorRow,
  writeModelTargetToOrigin,
} from "@/components/session/sessionMirror";
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

/** GET /v1/workspace/agents 里头部要的三列：身份、名字、调色板色。 */
interface WorkspaceAgent {
  sync_id: string;
  name: string;
  avatar_color?: string;
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
  /** 目标会话在 daemon 上的 id。 */
  sessionId: number;
  /**
   * 这条对话的**发起端**指纹 —— 镜像身份键的另一半（决策 17）。索引行直接知道它
   * （/v1/agent-sessions 的 peer_fingerprint），传进来就省掉一次认领；不传时本页
   * 按 (这台机器的指纹, 会话 id) 自己去账号镜像里认，认不出就不猜。
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
}

/**
 * 可复用真实会话详情视图：attach + 按 seq 游标补齐（origin 原样带回 R4/R6）、
 * 实时事件、待审批/提问决策（R10）、发新消息（R9）、七类不可达状态（R11）都在这
 * 一份实现里，路由页与桌面右栏共用，不回退。
 *
 * 详情头部对齐正式画板（X9Mjl/uqEha 的 DetailHeader）：标题 + 状态标记 + 机器 meta。
 * 画板中无协议支持的「分享链接 / more」按钮、文件改动面板、自动挂起倒计时、权限模式、
 * 会话轮次、快速提示词一律不渲染（规格「任务必要性 + 真实能力」双重判定）。
 */
export default function SessionDetailView({
  deviceId,
  sessionId,
  peerFingerprint,
  form = "page",
  initialModelNote,
}: SessionDetailViewProps) {
  const did = Number(deviceId);
  const sid = Number(sessionId);
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
  const [events, setEvents] = useState<EventFrame[]>([]);
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
   * 已经为哪一条对话记过「读到这里」了。键是 `<发起端指纹>:<会话号>` —— 与账号
   * 镜像的身份键同一组（决策 17）。同一条重渲染不再记一次；换一条才再记。
   */
  const markedReadRef = useRef<string | null>(null);
  /**
   * server 镜像的历史应用到的最后一个 seq。中继客户端可能晚于历史才出现（换 ticket
   * 是异步的），所以预置游标要落在 attach 之前那一刻，而不是历史刚读完的那一刻。
   */
  const mirrorSeqRef = useRef(0);
  /**
   * 首屏认出来的发起端指纹。往上滚续读时还要用它去问镜像 —— 那时候索引行给的
   * originProp 可能本来就没有（按会话号认出来的那条），重认一次是多余的一次取数。
   */
  const mirrorOriginRef = useRef<string | undefined>(undefined);

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
    mirrorOriginRef,
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
    setPinnedAgentredUnavailable(false);
    setReady(false);
    scrollback.reset();
    setCatchUpFailed(false);
  }

  // 目标机器与它的可达性（device / deviceError / machineOnline / meValid）整片
  // 归 useSessionTargetDevice；本组件只读它们。
  const target = useSessionTargetDevice(did);
  const { device, deviceError, machineOnline, meValid } = target;

  const { client, relayState, relayTicket, relayTicketError, reconnect } =
    useRelayMachine(device?.online ? device.fingerprint : null, {
      onEvent: (f) => {
        if (f.sessionId === sid) {
          setEvents((prev) => [...prev, f]);
          // 撤占位的判据是「助手真的开口了」,不是「又来帧了」:一轮的第一帧是
          // daemon 把用户自己那句话回声回来,拿它撤占位等于对端还没说话就把三点
          // 熄了,而这一轮再没有别的东西能重新点亮它。
          if (opensAssistantMessage(f, sid)) turn.setPendingAssistant(false);
        }
        // 审批/提问事件到达时刷新待决策:DecisionPanel 的数据源是 pendingWaiters,
        // 不是事件流 —— 不主动重拉,审批卡就永远不出现(fake runtime 阻塞在审批上,
        // run 不会结束,onRunResultDone 那一条刷新路径到不了;R10)。
        const kind = (f.event as { kind?: string } | undefined)?.kind;
        if (
          kind === "tool_permission_request" ||
          kind === "ask_user_question"
        ) {
          decisions.requestWaitersRefresh();
        }
      },
      onRunResultDone: () => {
        turn.markTurnActive(false);
        turn.setPendingAssistant(false);
        setEvents((prev) => [
          ...prev,
          { sessionId: sid, event: { kind: "done" }, seq: undefined },
        ]);
        // 「已排进这一轮」是对**那一轮**的说明:轮次结束后它已经过期(要么被消费、
        // 回复就在转录里,要么随轮次一起没了),留着就是在骗人。
        turn.setSendFeedback((prev) =>
          prev.kind === "queued" ? { kind: "none" } : prev,
        );
        decisions.requestWaitersRefresh();
      },
      onAutonomousTurnStarted: () => {
        turn.markTurnActive(true);
        turn.setPendingAssistant(true);
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
        })
        .catch(() => {
          // 报错与解不动是同一件事：这台机器此刻答不出档位。
          if (alive()) setPermissionModeMeta(null);
        });
    },
    [client, relayState, summary?.backendType],
  );

  /**
   * 历史从 server 镜像取 —— 机器在不在线都跑，这正是本轮的目的（规格「机器离线时
   * 只读」）。发起端指纹优先用索引行传下来的那个；没有就按 (这台机器的指纹, 会话 id)
   * 自己去账号镜像里认，认不出**不猜**。
   */
  useAliveEffect(
    (alive) => {
      if (history.settled) return;
      // 没有现成指纹时，得先有设备——认自己那一行要拿它的指纹去比。
      if (!originProp && !device) return;
      mirrorSeqRef.current = 0;
      void (async () => {
        try {
          // 两条路都把那一行整个取回来（不只是指纹）：标题与 Agent 身份在它上面，
          // 机器离线时中继给不出摘要，头部只认得动这一行。
          const row = await resolveMirrorRow(
            sid,
            originProp,
            device?.fingerprint,
          );
          if (!alive()) return;
          // 指纹仍以索引行传下来的那个为准：认领落空（端点抖动 / 账号里还没有这一行）
          // 时转录照读得到，只是头部少一份替补。
          const origin = originProp ?? row?.peer_fingerprint;
          if (row) setMirrorSummary(mirrorRowToSummary(row, sid));
          if (!origin) {
            setHistory({ settled: true, loaded: false });
            return;
          }
          mirrorOriginRef.current = origin;
          const tail = await loadMirrorTail(sid, origin, 0);
          if (!alive()) return;
          mirrorSeqRef.current = tail.lastSeq;
          // 历史落在最前面：这一段还没有经过中继客户端的游标去重，实时那一段由预置
          // 游标接在它后面（见下面的 attach effect）。
          setEvents((prev) => [...tail.events, ...prev]);
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
    [history.settled, originProp, device, sid],
  );

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
          const list = decodeSessionListResult(listRaw);
          const s = list.sessions.find((x) => x.sessionId === sid);
          // origin 在 attach 之前就得学到（下一行就要用它）。
          const origin = s?.peerFingerprint?.trim() || undefined;
          originRef.current = origin;
          // 打开即已读。身份用**发起端**指纹（承载连接的那台机器可能是另一台），
          // 时刻由服务端就地取——客户端的钟不可信。
          //
          // 记不上不影响读这条对话：它只让「未读」那一档多留一条，比拿一次失败去打断
          // 阅读要好。所以这里既不重试也不报错面。
          const readOrigin = origin ?? device?.fingerprint ?? "";
          const readKey = `${readOrigin}:${sid}`;
          if (readOrigin && markedReadRef.current !== readKey) {
            markedReadRef.current = readKey;
            void api("/v1/agent-sessions/read", {
              method: "POST",
              body: JSON.stringify({
                peer_fingerprint: readOrigin,
                session_id: String(sid),
              }),
            }).catch(() => {});
          }
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
          const attached = await client.attach(sid, origin);
          // 会话标识是各端本地自增、会被复用的：那条会话在执行端被删掉重排之后，它的
          // 日志高水位比镜像里这一段低。游标停在高水位上面的话，此后每一条实时帧都
          // 「不大于游标」被当成重复丢光——会话没有报错、也没有跳号地冻住。attach 交回
          // 来的 latestSeq 就是执行端此刻的高水位，据它复位（桌面端 reconnect.go 的
          // dropCursorAboveHighWater 同一条规则）。
          if (
            attached.latestSeq > 0 &&
            attached.latestSeq < client.getCursor(sid, origin)
          ) {
            client.setCursor(sid, attached.latestSeq, origin);
          }
          // 账号里没有这一份（未保存的对话，机器轴上的大多数）：内容只有中继给得出，
          // 而从游标 0 补齐就是把整份 journal 拉回来。按对端交回的高水位反推起点，
          // 只补最后那一段；更早的等用户往上滚时再要（pullBefore）。
          //
          // 这里只能用**帧数**当刻度：对端的 pull 只有 cursor + limit，没有服务端那套
          // 预算（轮次 / 字节）。所以「够不够一屏」全靠下面那条顶补兜着。
          const relayTail =
            mirrorSeqRef.current === 0 &&
            attached.latestSeq > RELAY_TAIL_FRAMES &&
            client.getCursor(sid, origin) === 0;
          if (relayTail) {
            client.setCursor(
              sid,
              attached.latestSeq - RELAY_TAIL_FRAMES,
              origin,
            );
          }
          await client.catchUp(sid, origin);
          if (alive() && mirrorSeqRef.current === 0) {
            // 这一段的最老一条就是游标的下一格；更早的还在对端那里。
            const from = relayTail ? attached.latestSeq - RELAY_TAIL_FRAMES : 0;
            scrollback.noteRelayHistory(from + 1, from > 0);
          }
          if (alive()) {
            // 选路标志的起点是清单快照，但必须落在**补齐之后**：补齐会把历史里的
            // runResultDone 也经 onRunResultDone 回放一遍，落在前面会被上一轮的终态
            // 清成 false。（镜像那一段不参与这件事：回放教不了「此刻在不在跑」，
            // 它只往转录里补一条轮次结束的标记。）
            turn.markTurnActive(s?.lifecycleState === SessionLifecycleRunning);
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
      turn,
    ],
  );

  // 断线重连后刷新待决策：补齐只负责转录事件，pendingWaiters 需要重新拉一次（R10）。
  // 取的是这一只函数而不是整只 decisions：后者每次渲染都是新对象，列进依赖会让这个
  // effect 每渲染跑一遍，待决清单被反复重拉。
  const { refreshWaiters } = decisions;
  useEffect(() => {
    if (relayState === "connected" && ready) void refreshWaiters();
  }, [relayState, ready, refreshWaiters]);

  const status = deriveSessionViewStatus({
    relayState,
    meValid:
      meValid &&
      !(
        relayTicketError instanceof ApiError && relayTicketError.status === 401
      ),
    machineOnline,
    targetKind: device?.kind,
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
  const projector = useMemo(() => createTranscriptProjector(sid), [sid]);
  const messages = useMemo(
    () => projector.project(events),
    [projector, events],
  );

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
  const effectivePermissionMode =
    permissionMode ||
    sessionRuntime.permissionMode ||
    engineBackend?.default_permission_mode ||
    permissionModeMeta?.defaultMode ||
    "";

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
        sessionId: BigInt(sid),
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
  });

  if (deviceError) {
    const alert = (
      <Alert variant="destructive">
        {deviceError instanceof ApiError
          ? deviceError.message
          : t("device.manage.loadError")}
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
      sessionId: sid,
      providerKey: next.providerKey,
      modelKey: next.modelKey,
    };
    // 承载者：就是此刻这条连接。带上 origin 让它解出是哪条会话。
    const writes: Promise<unknown>[] = [
      c.request(rpcMethods.setModelTarget, {
        ...params,
        sessionId: BigInt(params.sessionId),
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
   * `#<会话号>` 仍是**什么都还不知道**时的兜底（摘要两条来路都还没落地）：那一刻
   * 连后端和状态都拿不出来，退化式会摆成一行「— · — · 闲置」，比一个诚实的会话号
   * 更没有信息。
   */
  const displayTitle = identity ? sessionTitle(identity, t) : `#${sid}`;

  const agent = identity?.agentSyncId
    ? (agents.find((a) => a.sync_id === identity.agentSyncId) ?? null)
    : null;
  const agentColor = tokenToCssColor(agent?.avatar_color);

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
   * 头部与转录共用同一枚头像：agent 调色板底 + 白色首字母 + role="img"，
   * 与桌面端 primitives.tsx 的 AgentAvatar 同形。解不出 Agent 时不摆（不画一个
   * 没有身份的方块）。转录那一档尺寸套包的 MESSAGE_AVATAR_CLASS 与行排版对齐。
   */
  const agentAvatar = (size: "md" | "row") =>
    agent ? (
      <span
        role="img"
        aria-label={agent.name}
        className={cn(
          "inline-flex shrink-0 items-center justify-center font-semibold text-agent-foreground",
          size === "md" ? "size-8 rounded-lg text-sm" : MESSAGE_AVATAR_CLASS,
        )}
        style={agentColor ? { backgroundColor: agentColor } : undefined}
      >
        {agent.name.charAt(0)}
      </span>
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
      avatar={headerAvatar}
      displayTitle={displayTitle}
      machineName={device?.name}
      machineOnline={machineOnline}
      status={status}
      // 「这一轮在不在跑」这里仍只认 summary：停止要的是执行端此刻的实况，
      // 一份离线快照回答不了。
      running={summary?.lifecycleState === SessionLifecycleRunning}
      clientRef={clientRef}
      originRef={originRef}
    />
  );

  /** 滚的只有这一带。转录、状态横幅与审批卡都在里面，头部与 Composer 都不在。 */
  const scrollBody = (
    <SessionScrollBody
      sid={sid}
      scrollRef={scrollRef}
      onScroll={scrollback.onScroll}
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
      ready={ready}
      catchUpFailed={catchUpFailed}
      messages={messages}
      localFingerprint={relayTicket?.clientId}
      agentName={agent?.name}
      agentAvatar={rowAvatar}
      agentPending={agentPending}
      streaming={turn.turnActive}
      pendingAssistant={turn.pendingAssistant}
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
      onSubmit={(text, images) => void send.sendMessage({ text, images })}
      permissionMode={effectivePermissionMode}
      permissionModeMeta={permissionModeMeta}
      permissionError={permissionError}
      onPermissionModeChange={changePermissionMode}
      modelControl={modelControl}
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
