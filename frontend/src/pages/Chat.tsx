import { type SessionSummary } from "@agentre-hub/agentre-wire";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessageCirclePlus, PenLine, Plus } from "lucide-react";

import AppControls from "@/components/AppControls";
import { EmptyState } from "@/components/console";
import {
  Button,
  DialogShell,
  DialogShellBody,
  DialogShellFooter,
  DialogShellHeader,
  DialogShellSubmit,
} from "@agentre-hub/agentre-ui";
import AppShell from "@/components/AppShell";
import DeleteSessionDialog from "@/components/session/DeleteSessionDialog";
import { DraftSession } from "@/components/session/newconv/DraftSession";
import { NewConversationPane } from "@/components/session/newconv/NewConversationPane";
import { NewConversationSheet } from "@/components/session/newconv/NewConversationSheet";
import { ProjectAgentPane } from "@/components/session/newconv/ProjectAgentPane";
import type {
  NewConvAgent,
  NewConvProject,
} from "@/components/session/newconv/types";
import { useAliveEffect } from "@/hooks/use-api-query";
import { fetchDevices, type DeviceItem } from "@/lib/devices";
import type { DispatchedSession } from "@/lib/dispatch";
import { readRecentAgents } from "@/lib/recentAgents";
import SessionDetailView from "@/components/session/SessionDetailView";
import SessionListSkeleton from "@/components/session/SessionListSkeleton";
import { useIsMobile } from "@/components/use-is-mobile";
import { UserMenu } from "@/components/UserMenu";
import { useMe } from "@/hooks/use-me";
import { useAccountChannel } from "@/hooks/use-account-channel";
import {
  AccountChannelDevicePresence,
  AccountChannelSyncVersion,
} from "@/lib/accountChannel";
import { api } from "@/lib/api";
import { fetchProjects, type ProjectNode as ApiProject } from "@/lib/projects";
import {
  buildGroupTotals,
  buildMachineRows,
  buildView,
  findSelectedKey,
  toMachineRow,
  toMirrorRow,
  type MirroredSession,
  type MirrorIndexRow,
} from "@/pages/chat/chatRows";
import {
  ChatFreshIndicator,
  ChatIndexPanel,
  ChatSearchField,
  indexSettled,
  isAccountEmpty,
} from "@/pages/chat/ChatIndexPanel";
import { ProjectDialogs } from "@/pages/chat/ProjectDialogs";
import { useMachineReachability } from "@/pages/chat/useMachineReachability";
import { useProjectManagement } from "@/pages/chat/useProjectManagement";
import { useSessionIndex } from "@/pages/chat/useSessionIndex";
import {
  INDEX_AXES,
  type IndexAxis,
  type IndexRow,
  type ProjectNode,
} from "@/lib/sessionAxes";
import { type SessionFilter } from "@/lib/sessionView";

/**
 * 「对话」页 = 这一端**唯一**的会话索引（规格 2026-08-17 决策 1），行来自账号镜像
 * （规格 2026-08-18 决策 9）。
 *
 * 范围就是**账号里保存过的对话**：从 web 发起的（发起即保存）与用户显式保存的。
 * 它们的摘要（标题 / 状态 / Agent 与项目归属 / 最后活动时间）住在 server 上，
 * 因此这一页一个请求就列得出来——不再逐台机器经中继实时解析、不再有「关注名单
 * 只有指向」那条链路，首屏也不等中继。项目归属由服务端就地判定（决策 12），
 * 浏览器不再上送 (机器指纹, cwd) 探针，响应里一条路径都没有（R19）。
 *
 * 机器离线只是行上的一个状态（第二行末尾的「离线」，决策 10）：本体在 server 上，
 * 读它跟机器在不在没关系，所以不再有「暂时看不到」那一类灰行。
 *
 * 机器轴**选中一台在线机器**时，索引额外列出那台机器上有、账号里还没保存的对话
 * （决策 11）：那要问机器本身，因此只有这一档才连中继。行尾是「保存」——这是
 * 「发现一条对话并把它收进账号」唯一的去处，也是 `/devices/:id/sessions` 重定向
 * 过来之后要落在的形态。
 */
/** 轴与选中的机器都在 URL 上：设备下钻靠它重定向，链接也因此可分享。 */
function readAxis(raw: string | null): IndexAxis {
  return INDEX_AXES.includes(raw as IndexAxis) ? (raw as IndexAxis) : "project";
}

/**
 * 这个账号**第一次**保存时的说明（规格「隐私与承诺的变更」）。
 *
 * 「保存」这个动作同时是同意的表达：它把整条对话的内容存到 server 上。这件事得
 * 让用户看得懂，而不是藏在一个图标里，所以第一次按下它时先把发生了什么说完整。
 * 判据是「账号里一条都还没保存过」——那正是「还没同意过」这件事在数据上的形态，
 * 不另存一个本地标记（换台电脑、换个浏览器就说不出话了）。
 */
function FirstSaveDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} size="md">
      <DialogShellHeader
        title={t("sessionIndex.save.title")}
        onClose={() => onOpenChange(false)}
      />
      <DialogShellBody className="space-y-3">
        <p className="text-aux leading-relaxed text-foreground">
          {t("sessionIndex.save.body")}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-muted-foreground">
          <li>{t("sessionIndex.save.point1")}</li>
          <li>{t("sessionIndex.save.point2")}</li>
          <li>{t("sessionIndex.save.point3")}</li>
        </ul>
      </DialogShellBody>
      <DialogShellFooter>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          {t("chat.cancel")}
        </Button>
        <DialogShellSubmit
          size="sm"
          data-testid="first-save-confirm"
          onClick={onConfirm}
        >
          {t("sessionIndex.save.confirm")}
        </DialogShellSubmit>
      </DialogShellFooter>
    </DialogShell>
  );
}

export default function Chat() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const isMobile = useIsMobile();
  // 移动端账号进页面自己的顶栏：壳那一条已经让位（ownHeader）。
  const { me } = useMe();
  const [searchParams, setSearchParams] = useSearchParams();

  const axis = readAxis(searchParams.get("axis"));

  const [filter, setFilter] = useState<SessionFilter>("all");
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [agents, setAgents] = useState<NewConvAgent[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  /**
   * 「新对话」这一路走到哪了。null = 没在开新对话。
   *
   * 它**不落进会话列表**：draft 还不是一条会话，左栏凭空多一行会让人以为已经
   * 开出来了。派发成功之后才重取索引，那时它作为一条真会话出现。
   */
  const [compose, setCompose] = useState<
    | null
    | { step: "pick" }
    | { step: "project" }
    // projectSyncId 只有从项目组头进来时才有：那颗 ＋ 问的是「在这个项目里开对话」。
    | { step: "draft"; agent: NewConvAgent; projectSyncId?: string }
  >(null);
  // 桌面右栏：当前选中的真实会话（未选中 = kpP7A 空态）。发起端指纹一起记着：
  // 详情按镜像的身份（发起端指纹 + 会话标识）取历史。
  const [selected, setSelected] = useState<{
    deviceId: number;
    sessionId: number;
    peerFingerprint: string;
    /**
     * 右栏冷启动那一段先摆的标题（见 SessionDetailView 的 initialTitle）。两个
     * 入口都拿得到：点行时是那一行的标题，草稿派发时是刚发出去那一句。
     */
    title?: string;
    /**
     * 账号镜像里的那一行（见 SessionDetailView 的 initialRow）。点左栏一行进来时
     * 就是索引取回来的那一行，递下去详情就不必回头再认领一次。草稿刚派发出来的
     * 那条账号里还没有这一行，那时留空。
     */
    row?: MirroredSession;
    /** 刚从草稿页发起、而模型没能钉住时要说的那一句（见 initialModelNote）。 */
    modelNote?: string;
  } | null>(null);
  // 「最近用过」只在打开这一路时读一次：读它是为了排个序，不值得每次渲染都碰
  // 一次 localStorage。
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const openCompose = useCallback(() => {
    setRecentIds(readRecentAgents());
    setCompose({ step: "pick" });
  }, []);
  /** 删掉一条之后：右栏归这一页管，因此这一步借给索引数据层。 */
  const onSessionDeleted = useCallback((row: IndexRow) => {
    // 右栏正开着这一条时一并收起：它已经不存在了，留在那里等于让用户对着一份
    // 已经删掉的转录继续读。身份按（发起端指纹, 会话标识）比，与行的键同一套。
    setSelected((prev) =>
      prev &&
      prev.peerFingerprint === row.fingerprint &&
      prev.sessionId === row.sessionId
        ? null
        : prev,
    );
  }, []);
  /**
   * 索引的数据层整族住在 useSessionIndex 里：取数、分页、计数，以及保存 / 删除那两个
   * 乐观动作。轴与筛选是**范围**、因此借给它；删掉之后右栏怎么收由这一页说了算。
   */
  const sessionIndex = useSessionIndex({
    axis,
    devices,
    filter,
    onDeleted: onSessionDeleted,
  });
  // 这两个（连同下面 reach 的 forgetResolved）单独拎出来：整个 hook 结果每次渲染都是
  // 新对象，把它整个钉进依赖数组会让下面几个 useCallback 每渲染换一次引用，索引里的
  // 行因此整片重造（见 sessionDetailPath 上那一段）。它们本身是 useCallback，稳定。
  const { refetch, fetchGroupPage, markRead, mirrorRowOf } = sessionIndex;
  /**
   * 从别处进来的「新建一个会话」。目前唯一的来源是会话详情的「机器离线」横幅：
   * 那条对话钉在一台够不着的机器上、续轮不会改派，唯一走得通的路是另起一条。
   *
   * 走 URL 而不是回调，因为详情在路由页形态下压根不在这一页里（移动端下钻、
   * `/devices/:did/sessions/:sid` 都是），没有回调递得过来。
   *
   * 参数进来就消掉：它说的是「刚才要新建」这件一次性的事，不是页面此刻的范围。
   * 留着的话，之后每一次刷新与前进后退都会把人重新丢回挑 Agent 那一屏。
   */
  useEffect(() => {
    if (searchParams.get("compose") !== "1") return;
    // 状态更新推到 effect 之后：`react-hooks/set-state-in-effect` 禁止在 effect 体里
    // 裸调 setState（同一条规矩在 SessionDetailView 的 pendingSend 那处也绕过一次）。
    void Promise.resolve().then(() => {
      openCompose();
      const params = new URLSearchParams(searchParams);
      params.delete("compose");
      setSearchParams(params, { replace: true });
    });
  }, [searchParams, setSearchParams, openCompose]);
  /**
   * 派发成功：这条对话已经进账号，直接去读它的实时流；compose 到此结束。
   *
   * 桌面端**不换页**。挑 Agent / 选项目 / 草稿这三步本来就都在右栏里走完，最后
   * 一步跳去 `/devices/:did/sessions/:sid` 会把两栏连同左栏那份上下文一起掀掉；
   * 而这条新对话从此与左栏里点开的任何一条没有分别，落地形态因此与 `onSelect`
   * 同一套：右栏就地嵌入它的真实详情。
   *
   * 移动端仍旧下钻：单列没有第二栏可落，而下钻正是它读一条已有对话的形态。
   *
   * 身份的另一半用 `peerFingerprint`——从控制台派发出去的对话，**发起端是这个浏览器**，
   * 承载它的才是那台 agentred，两者不是同一个值（dispatch 那一步的保存也正是这么
   * 分开报的）。这里若用 `deviceFingerprint`，右栏一落地就拿机器指纹去问镜像的历史
   * 与「已读」，而账号里这条对话的身份键是 (浏览器标识, 会话号)：转录一帧都读不回来，
   * 屏上只剩「正在从这台机器读取这条对话…」。
   */
  const onDraftStarted = useCallback(
    ({
      deviceId,
      sessionId,
      peerFingerprint,
      title,
      modelPinned,
    }: DispatchedSession) => {
      setCompose(null);
      // 钉不住不影响这条对话开起来（第一轮就是按所选模型跑的），但后续轮次会回到
      // 跟随 Agent 绑定 —— 详情页必须如实说出来，否则它会显示成「跟随绑定」而
      // 用户明明选过。
      const modelNote = modelPinned
        ? undefined
        : t("session.composerControls.modelNotPinnedOnStart");
      if (isMobile) {
        nav(`/devices/${deviceId}/sessions/${sessionId}`, {
          state: { title, ...(modelNote ? { modelNote } : {}) },
        });
        return;
      }
      setSelected({
        deviceId,
        sessionId,
        peerFingerprint,
        title,
        modelNote,
      });
      // 左栏还是派发之前那一份，里面没有这条刚写进账号的对话：右栏开着它、左栏
      // 却列不出来，看上去就像它没进账号。重取一次让它落成一行。
      refetch();
    },
    [refetch, isMobile, nav, t],
  );
  /**
   * 右栏「打开即已读」回来了：把左栏那一行就地改掉。
   *
   * 此前这里是 refetch()——为了一个服务端刚刚告诉过我们的时刻，重取一遍当前范围的
   * 索引外加一次完整集合上的未读数探测。这条路每点开一条对话就走一遍。
   */
  const onMarkedRead = useCallback(
    (peerFingerprint: string, lastReadAt: number) => {
      if (!selected) return;
      markRead(peerFingerprint, String(selected.sessionId), lastReadAt);
    },
    [markRead, selected],
  );

  /** 机器与 Agent 名单只喂组头与行上的另外两维，不随**范围**重取。 */
  useAliveEffect((alive) => {
    Promise.all([
      fetchDevices(),
      api<{ agents: NewConvAgent[] }>("/v1/workspace/agents"),
    ])
      .then(([d, a]) => {
        if (!alive()) return;
        setDevices(d);
        setAgents(a.agents);
      })
      .catch((e: unknown) => {
        if (alive()) sessionIndex.setLoadError(e);
      });
  }, []);

  useAccountChannel([AccountChannelDevicePresence], () => {
    fetchDevices()
      .then(setDevices)
      // 名单取不到时保持原样：组头少一维好过把用户正在看的一列清空。
      .catch(() => {});
  });

  // 项目树单独取：它只喂项目轴的组头，取不到时会话照常列出（都进「未归项目」），
  // 不该把整页拖成一条错误横幅。写完之后要重取，因此单拎成一个函数。
  const reloadProjects = useCallback(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => {});
  }, []);
  useEffect(() => {
    reloadProjects();
  }, [reloadProjects]);

  // 同步版本推进：行上的 Agent 名与项目轴的组头都来自 sync_objects。放在这里而不是
  // 跟另外两条信号挤在一起，只因为它要用到上面这个 reloadProjects。
  useAccountChannel([AccountChannelSyncVersion], () => {
    api<{ agents: NewConvAgent[] }>("/v1/workspace/agents")
      .then((a) => setAgents(a.agents))
      .catch(() => {});
    reloadProjects();
  });

  /**
   * 机器可达性整族住在 useMachineReachability 里：中继连接、每台的解析状态、重试，
   * 以及由设备名单派生的那几份表。它与索引只在设备名单这一份数据上碰头。
   */
  const reach = useMachineReachability({ devices, axis });
  const { forgetResolved } = reach;

  const projectNodes = useMemo<ProjectNode[]>(
    () =>
      projects.map((p) => ({
        syncId: p.syncId,
        name: p.name,
        color: p.color,
        icon: p.icon,
        parentSyncId: p.parentSyncId,
        sortOrder: p.sortOrder,
      })),
    [projects],
  );

  /**
   * 「新对话」那一族要的是**线上载荷的形状**（下划线键），项目面读的是这一页的
   * 领域模型（驼峰键）。两边各取一次会取回同一份树，因此在这里转一道而不是再发
   * 一次请求——项目只有一个来源。
   */
  const newConvProjects = useMemo<NewConvProject[]>(
    () =>
      projects.map((p) => ({
        sync_id: p.syncId,
        name: p.name,
        color: p.color,
        icon: p.icon,
        parent_sync_id: p.parentSyncId,
        sort_order: p.sortOrder,
      })),
    [projects],
  );

  /**
   * 项目的增删改整族住在 useProjectManagement 里：它与索引只在项目树、Agent 名单
   * 这两份数据上碰头，因此借走它们，另外借一条「挑定 Agent 之后去哪」。
   */
  const onProjectNewChat = useCallback(
    (agent: NewConvAgent, projectSyncId: string) =>
      setCompose({ step: "draft", agent, projectSyncId }),
    [],
  );
  const projectManagement = useProjectManagement({
    projects,
    agents,
    newConvProjects,
    reloadProjects,
    onNewChat: onProjectNewChat,
  });

  const agentInfos = useMemo(
    () =>
      agents.map((a) => ({
        syncId: a.sync_id,
        name: a.name,
        color: a.avatar_color,
      })),
    [agents],
  );

  const setAxis = useCallback(
    (next: IndexAxis) => {
      if (axis === "machine" && next !== "machine") forgetResolved();
      const params = new URLSearchParams(searchParams);
      params.set("axis", next);
      // 「选中一台机器」这回事已经不存在了（规格 2026-08-21 决策 5）：旧地址上
      // 带着的那个参数顺手清掉，免得它看起来还有用。
      params.delete("machine");
      setSearchParams(params, { replace: true });
    },
    [axis, searchParams, setSearchParams, forgetResolved],
  );

  // 桌面点行 / 选中一条真实会话 → 右栏嵌入真实详情视图。
  const onSelect = useCallback(
    (row: IndexRow) => {
      if (row.deviceId === undefined) return;
      // 开着「新对话」时右栏归它，选中的会话渲染不出来。点了左栏的一条就是要看
      // 那一条——不在这里收掉 compose，人会被困在挑 Agent 那一屏，除了真开一条
      // 对话没有别的出路。草稿本来就没落任何东西，收掉不会丢下什么。
      setCompose(null);
      setSelected({
        deviceId: row.deviceId,
        sessionId: row.sessionId,
        peerFingerprint: row.fingerprint,
        // 这一行的标题就在手上：右栏没有理由为了同一个名字再等一次往返。
        title: row.title,
        // 整行也在手上（机器轴那一档列的是机器实时报的，账号里未必有对应的一行，
        // 取不到就留空，详情照旧自己认）。
        row: mirrorRowOf(row.fingerprint, row.sessionId),
      });
    },
    [mirrorRowOf],
  );

  /** 行投影的两层薄包装：真正的投影是 chatRows 里的纯函数。 */
  const fromMirrorRow = useCallback(
    (s: MirroredSession) => toMirrorRow(s, reach.devicesByFp, t),
    [reach.devicesByFp, t],
  );
  const fromMachineRow = useCallback(
    (device: DeviceItem, s: SessionSummary, localFingerprint?: string) =>
      toMachineRow(device, s, t, localFingerprint),
    [t],
  );

  /**
   * 机器轴上每台在线机器**各自的整份**（规格 2026-08-21 决策 1，口径沿用
   * 2026-08-19 决策 11 / 12，只是从「选中的那一台」扩到「每一台」）。
   *
   * null = 不在机器轴上（这一档不成立）。在线的机器以它自己上报的那份为准：镜像里
   * 发起自这台机器、但机器本地已经没有了的那些不在其中——它们不在这个问题的答案
   * 里（其余三个轴上照常在）。离线的机器压根不在这张表里：它答不出，一行都不列。
   */
  const machineRowsByDevice = useMemo<Map<number, MirrorIndexRow[]> | null>(
    () =>
      axis === "machine"
        ? buildMachineRows({
            onlineMachines: reach.onlineMachines,
            resolved: reach.resolved,
            mirrorRows: sessionIndex.mirrorRows,
            fromMirrorRow,
            fromMachineRow,
            search: sessionIndex.debouncedSearch,
            filter,
          })
        : null,
    [
      axis,
      reach.onlineMachines,
      reach.resolved,
      sessionIndex.mirrorRows,
      fromMirrorRow,
      fromMachineRow,
      sessionIndex.debouncedSearch,
      filter,
    ],
  );

  /**
   * 组键 → 这一组在当前范围下的真数（决策 6）。服务端按**它自己的**组身份说话
   * （`agent:<id>` / `machine:<指纹>`…），索引按客户端的组键分组，这里是两套词汇
   * 唯一的翻译处。认不出机器的那些行在客户端并成一组，因此它们的数要相加。
   */
  const groupTotals = useMemo(
    () =>
      buildGroupTotals({
        indexGroups: sessionIndex.indexGroups,
        devicesByFp: reach.devicesByFp,
        machineRowsByDevice,
      }),
    [sessionIndex.indexGroups, reach.devicesByFp, machineRowsByDevice],
  );

  /**
   * 翻某一组的下一页（「查看全部 N」那条路）。范围参数一并带上——弹层里翻的必须
   * 还是同一个搜索与筛选下的那一组，否则数说的是一件事、翻出来的是另一件。
   */
  const loadGroupPage = useCallback(
    async (scope: string, cursor: string | null) => {
      // 机器那一档整份就在手里，翻它不用再问任何人——更不该拿这个 scope 去问服务端
      // （它只知道账号里保存过的那些）。
      if (machineRowsByDevice) {
        const machine = reach.onlineMachines.find(
          (d) => scope === `machine:${d.fingerprint}`,
        );
        if (machine) {
          return {
            rows: machineRowsByDevice.get(machine.id) ?? [],
            cursor: null,
            hasMore: false,
          };
        }
      }
      const page = await fetchGroupPage(scope, cursor);
      return {
        rows: page.items.map(fromMirrorRow),
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
    },
    [fetchGroupPage, fromMirrorRow, reach.onlineMachines, machineRowsByDevice],
  );

  const view = useMemo(
    () =>
      buildView({
        machineRowsByDevice,
        mirrorRows: sessionIndex.mirrorRows,
        fromMirrorRow,
        search: sessionIndex.debouncedSearch,
        filter,
      }),
    [
      machineRowsByDevice,
      sessionIndex.mirrorRows,
      fromMirrorRow,
      sessionIndex.debouncedSearch,
      filter,
    ],
  );

  const selectedKey = useMemo(
    () => findSelectedKey(view.rows, selected),
    [selected, view.rows],
  );

  /** 删除确认要说清楚清的是哪台机器上那一份，以及它是不是一台电脑（决策 16）。 */
  const deleteTargetMachine = useMemo(() => {
    if (!sessionIndex.pendingDelete) return null;
    return (
      reach.devicesByFp.get(sessionIndex.pendingDelete.fingerprint) ?? null
    );
  }, [sessionIndex.pendingDelete, reach.devicesByFp]);

  const empty = isAccountEmpty({
    accountTotal: sessionIndex.accountTotal,
    axis,
    machineCount: reach.machines.length,
  });
  const composePick = (
    <NewConversationPane
      agents={agents}
      recentIds={recentIds}
      onPick={(agent) => setCompose({ step: "draft", agent })}
      onFromProject={() => setCompose({ step: "project" })}
    />
  );
  const composeProject = (
    <ProjectAgentPane
      projects={newConvProjects}
      agents={agents}
      stacked={isMobile}
      onPick={(agent) => setCompose({ step: "draft", agent })}
      onBack={() => setCompose({ step: "pick" })}
    />
  );
  const composeDraft =
    compose?.step === "draft" ? (
      <DraftSession
        agent={compose.agent}
        agents={agents}
        projects={newConvProjects}
        initialProjectSyncId={compose.projectSyncId}
        onStarted={onDraftStarted}
        onBack={isMobile ? () => setCompose({ step: "pick" }) : undefined}
      />
    ) : null;

  const settled = indexSettled(sessionIndex);

  const index = (
    <ChatIndexPanel
      sessionIndex={sessionIndex}
      reach={reach}
      axis={axis}
      onAxisChange={setAxis}
      filter={filter}
      onFilterChange={setFilter}
      view={view}
      selectedKey={selectedKey}
      onSelect={isMobile ? undefined : onSelect}
      projects={projectNodes}
      agents={agentInfos}
      groupTotals={groupTotals}
      loadGroupPage={loadGroupPage}
      projectManagement={projectManagement}
      rowStatusLabel={isMobile}
    />
  );

  const topBarRight = reach.hasOnlineDesktop ? <ChatFreshIndicator /> : null;

  /* 真实搜索：判据在服务端（决策 8，只按标题）。两处形态共用一份，只差尺寸。 */
  const renderSearchField = (size: "sm" | "md") => (
    <ChatSearchField
      size={size}
      value={sessionIndex.searchQuery}
      onChange={sessionIndex.setSearchQuery}
    />
  );

  // 在 JSX 之外先算好：i18next/no-literal-string 会把 JSX 里的
  // `renderSearchField("sm")` 当成一段裸文案报出来。
  const searchFieldSm = renderSearchField("sm");
  const searchFieldMd = renderSearchField("md");

  return (
    <AppShell
      title={t("nav.chat")}
      right={topBarRight}
      flush
      ownHeader={isMobile}
    >
      {isMobile &&
      (compose?.step === "draft" || compose?.step === "project") ? (
        /* 窄屏没有第二栏可用：这两步各占一整屏，返回回到底部弹层那一步。 */
        <div data-testid="chat-mobile-compose" className="h-full min-h-0">
          {compose.step === "draft" ? composeDraft : composeProject}
        </div>
      ) : isMobile ? (
        /* 移动形态（屏 20/32）：同一套四个轴（决策 5，不再有只属于移动端的状态分组）
           + 屏 32 空态；可触达的真实搜索：加载完成后始终显示，过滤索引里的行。 */
        <div className="flex h-full min-h-0 flex-col">
          {/*
            这一带由页面自己排（壳的 ownHeader）。此前是把桌面那一套 right 槽整个
            塞进壳的 52px：标题被截成「对.」、「桌面端已连接」折成两行、「去设备上
            找对话」也折成两行，整条被撑到 ~100px 还是挤的。窄屏上「标题 + 页面动作
            + 账号 + 语言/主题」本来就不该抢同一行。

            第一行只留**身份与全局控件**，搜索自成第二行。这一带 shrink-0，滚的是
            它下面那一块：单列长表里滚到第 40 条想换个搜索词，不必先滚回去。
          */}
          <header
            data-testid="chat-mobile-header"
            className="shrink-0 border-b border-border bg-card"
          >
            <div className="flex h-[52px] items-center gap-2 px-3">
              <span className="shrink-0 text-prose font-bold text-foreground">
                {t("nav.chat")}
              </span>
              {/* 状态不只靠颜色：点 + 可见文字一起给。 */}
              {reach.hasOnlineDesktop && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-status-running-bg px-2 py-0.5 text-2xs font-medium text-status-running-text">
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-status-running"
                  />
                  {t("appShell.topBar.fresh")}
                </span>
              )}
              <span className="flex-1" />
              {me && <UserMenu me={me} compact />}
              <AppControls />
            </div>
            {/* 同一真实搜索框在加载完成后始终可触达（含空态）：空态时不隐藏主空态、
                不制造结果；有会话时继续真实过滤索引里的行。 */}
            {settled && (
              <div className="flex items-center gap-2 px-3 pb-2">
                {searchFieldMd}
              </div>
            )}
          </header>
          <div
            aria-busy={!settled || undefined}
            className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5"
          >
            {!settled ? <SessionListSkeleton /> : null}
            {settled && empty ? (
              /* 空态沿用屏 32（共享 EmptyState）：标题/正文/主按钮文案与桌面一致。 */
              <EmptyState
                icon={MessageCirclePlus}
                title={t("chat.noSessions")}
                body={t("chat.startFirstBody")}
                testId="chat-empty-state"
                action={
                  <>
                    <Button size="lg" onClick={openCompose}>
                      {t("chat.startFirst")}
                    </Button>
                    <Link
                      to="/devices"
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      {t("chat.findMore")}
                    </Link>
                  </>
                }
              />
            ) : null}
            {/* 一条会话都没有时由上面那个空态独自承接：移动端只有一列，索引再印一遍
              「还没有对话」就是同一句话说两遍。桌面端两列各说各的，不受这一条管。 */}
            {settled && !empty && index}
            {/* 移动有会话时：新建入口（IC5sH 的 pen-line FAB），在底栏之上。它只在
              有会话时出现，所以可访问名是「新对话」——「开始第一个对话」在这里
              与事实相反，而屏幕阅读器上这个名字就是它的全部。 */}
            {settled && !empty && (
              <button
                type="button"
                aria-label={t("chat.startNew")}
                className="fixed bottom-24 right-4 z-30 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-overlay"
                onClick={openCompose}
              >
                <PenLine className="size-5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      ) : (
        /* 桌面（屏 49b）：320px 左会话列表列 + 右侧详情区。壳已经把整块主区交出来
           （flush），因此不再需要负 margin 去抵消它的 padding。 */
        <div data-testid="chat-layout" className="flex h-full min-h-0 flex-row">
          <div
            data-testid="chat-list-col"
            className="flex w-[320px] shrink-0 flex-col border-r border-border bg-card"
          >
            <div className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-border px-2.5">
              {searchFieldSm}
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-[30px]"
                aria-label={t("chat.startNew")}
                title={t("chat.startNew")}
                onClick={openCompose}
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <div
              aria-busy={!settled || undefined}
              className="min-h-0 flex-1 overflow-auto p-2.5"
            >
              {!settled ? <SessionListSkeleton rows={6} /> : index}
            </div>
          </div>
          <div
            data-testid="chat-detail"
            className="flex min-w-0 flex-1 flex-col"
          >
            {/* 右栏这一格不是列表，摆骨架行会像是在等**某一条对话**的内容，而此刻
                还没有任何目标被选中。留空：左列的骨架已经说了「在取」。 */}
            {!sessionIndex.loaded ? (
              <div aria-busy="true" className="min-h-0 flex-1" />
            ) : compose?.step === "draft" ? (
              /* 桌面不需要弹层：右栏本来就摆着「挑一条对话」的空态，这一路直接
                 接管它。左栏一直在，随时能点回真会话。 */
              <div className="min-h-0 flex-1">{composeDraft}</div>
            ) : compose?.step === "project" ? (
              <div className="min-h-0 flex-1">{composeProject}</div>
            ) : compose ? (
              <div className="min-h-0 flex-1">{composePick}</div>
            ) : selected ? (
              /* 选中真实会话：右栏直接嵌入 SessionDetailView（embedded 形态：
                 无外壳/面包屑，只渲染真实详情，由外层给尺寸）。 */
              <div className="min-h-0 flex-1">
                <SessionDetailView
                  deviceId={selected.deviceId}
                  sessionId={selected.sessionId}
                  peerFingerprint={selected.peerFingerprint}
                  form="embedded"
                  initialTitle={selected.title}
                  initialRow={selected.row}
                  initialModelNote={selected.modelNote}
                  onMarkedRead={onMarkedRead}
                />
              </div>
            ) : (
              /* 未选中 / 没有真实会话：按 kpP7A 的空态层级呈现（共享 EmptyState）。
                 两种「空」说的不是同一件事——左边列着几条、只是还没点开的时候，
                 这里不能说「还没有对话」。 */
              <div className="flex flex-1 items-center justify-center p-4">
                <EmptyState
                  icon={MessageCirclePlus}
                  title={t(empty ? "chat.noSessions" : "chat.pickSession")}
                  body={empty ? t("chat.startFirstBody") : undefined}
                  testId={empty ? "chat-empty-state" : "chat-unselected-state"}
                  action={
                    <>
                      {/* R15 的主动作：打开新对话弹层（屏 23/24/25）。 */}
                      <Button size="lg" onClick={openCompose}>
                        {t(empty ? "chat.startFirst" : "chat.startNew")}
                      </Button>
                      <Link
                        to="/devices"
                        className="text-[11.5px] text-muted-foreground hover:underline"
                      >
                        {t("chat.findMore")}
                      </Link>
                    </>
                  }
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* 移动端「挑一个 Agent」是底部弹层（屏 23）；桌面端这一步在右栏里，
          不弹层。 */}
      {isMobile && (
        <NewConversationSheet
          open={compose?.step === "pick"}
          onOpenChange={(open) => setCompose(open ? { step: "pick" } : null)}
          agents={agents}
          recentIds={recentIds}
          onPick={(agent) => setCompose({ step: "draft", agent })}
          onFromProject={() => setCompose({ step: "project" })}
        />
      )}

      <ProjectDialogs {...projectManagement.dialogs} />

      <FirstSaveDialog
        open={sessionIndex.pendingSave !== null}
        onOpenChange={(open) => {
          if (!open) sessionIndex.cancelSave();
        }}
        onConfirm={sessionIndex.confirmSave}
      />

      <DeleteSessionDialog
        open={sessionIndex.pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) sessionIndex.cancelDelete();
        }}
        machineName={deleteTargetMachine?.name}
        machineOnline={deleteTargetMachine?.online}
        machineKind={deleteTargetMachine?.kind}
        pending={sessionIndex.deleting}
        onConfirm={() => void sessionIndex.confirmDelete()}
      />

      {sessionIndex.loaded && reach.resolvers}
    </AppShell>
  );
}
