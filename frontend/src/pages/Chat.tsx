import { type SessionSummary } from "@agentre-hub/agentre-wire";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
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
  ResizableSidebar,
  SessionRowSkeleton,
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
import { useAliveEffect } from "@/hooks/use-alive-effect";
import { fetchDevices, type DeviceItem } from "@/lib/devices";
import type { DispatchedSession } from "@/lib/dispatch";
import { readRecentAgents } from "@/lib/recentAgents";
import ResolvedSessionDetail, {
  type SessionDetailSeed,
} from "@/components/session/ResolvedSessionDetail";
import { useIsMobile } from "@/components/use-is-mobile";
import { UserMenu } from "@/components/UserMenu";
import { useMe } from "@/hooks/use-me";
import { useAccountChannel } from "@/hooks/use-account-channel";
import {
  AccountChannelDevicePresence,
  AccountChannelSyncVersion,
} from "@/lib/accountChannel";
import { fetchAgents } from "@/lib/agents";
import { useLiveTurns } from "@/lib/liveSessions";
import { fetchProjects, type ProjectNode as ApiProject } from "@/lib/projects";
import {
  buildGroupTotals,
  buildMachineRows,
  buildView,
  findSelectedKey,
  overlayLiveRow,
  toMachineRow,
  toMachineRows,
  toMirrorRow,
  type MirroredSession,
  type MirrorIndexRow,
} from "@/pages/chat/chatRows";
import {
  ChatIndexPanel,
  ChatSearchField,
  indexSettled,
  isAccountEmpty,
} from "@/pages/chat/ChatIndexPanel";
import { ProjectDialogs } from "@/pages/chat/ProjectDialogs";
import { useMachineReachability } from "@/pages/chat/useMachineReachability";
import { useProjectManagement } from "@/pages/chat/useProjectManagement";
import { useSessionIndex } from "@/pages/chat/useSessionIndex";
import type { SessionPathTarget } from "@/components/session/SessionIndex";
import { INDEX_AXES, type IndexAxis } from "@/lib/sessionAxes";
import {
  chatIndexAddress,
  readDeviceParam,
  sessionAddress,
} from "@/lib/sessionAddress";
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
/** 轴与范围都在 URL 上：设备下钻靠它重定向，链接也因此可分享。 */
function readAxis(raw: string | null): IndexAxis {
  return INDEX_AXES.includes(raw as IndexAxis) ? (raw as IndexAxis) : "project";
}

/**
 * 刚从草稿页派发出去那一刻这一屏知道得比详情早的那几样（规格 2026-09-17-chat-session-url
 * 「Desktop」：这些种子不进地址，刷新后按正常路径重新获取）。
 *
 * 标题、刚说的那句话、挑的 Agent、没钉住的模型 / 力度说明、轮次开始的时刻，以及承载
 * 它的机器——那条对话此刻还不在索引里，不带机器的话右栏要先绕一趟认领才连得上。
 */
interface DraftSeed {
  conversationId: string;
  deviceId: number;
  peerFingerprint?: string;
  title?: string;
  userText?: string;
  agent: NewConvAgent;
  modelNote?: string;
  effortNote?: string;
  turnStartedAt: number;
}

/**
 * `?machine=<设备标识>`：把机器轴收到这一台上。
 *
 * `/devices/:deviceId/sessions`（「查看这台机器的对话」）重定向过来时带着它——
 * 那句话说的是**一台**机器，不带范围的话落地看到的是账号下每一台。没带、或者
 * 带了个不是设备标识的东西，就是不收范围：机器轴本身仍是每台在线机器各一组。
 */
function readMachineScope(raw: string | null): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
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
  /**
   * 右栏（移动端是整屏）开着哪一条，真源是**地址**（规格 2026-09-17-chat-session-url
   * 决策 5）：`/chat/:conversationId`，未保存的会话再带 `?device=`。刷新、新标签、
   * 后退前进因此都回到同一条，而不必另记一份组件状态再去和地址对齐。
   */
  const { conversationId: routeConversationId } = useParams<{
    conversationId?: string;
  }>();
  const openConversationId = routeConversationId ?? null;
  const location = useLocation();
  const deviceParam = readDeviceParam(searchParams);
  /**
   * 异步回调里要的是**此刻**的地址，不是回调造出来那一刻的：保存 / 删除的应答回来时
   * 用户可能已经点去了别的会话，拿闭包里那份旧地址会把人拽回去。提交之后同步。
   */
  const locationRef = useRef({
    conversationId: openConversationId,
    search: location.search,
    deviceParam,
  });
  useEffect(() => {
    locationRef.current = {
      conversationId: openConversationId,
      search: location.search,
      deviceParam,
    };
  });

  const axis = readAxis(searchParams.get("axis"));
  const machineScope = readMachineScope(searchParams.get("machine"));

  const [filter, setFilter] = useState<SessionFilter>("all");
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [agents, setAgents] = useState<NewConvAgent[]>([]);
  /**
   * Agent 清单**问过了**没有。空数组是它的初值，而挑 Agent 那一屏把空清单读作
   * 「账号里一个 Agent 都没有，去桌面端建一个」——`/chat?compose=1` 直接落在那一
   * 屏（会话详情「机器离线」横幅给的正是这个出口），于是那一个往返里屏幕上写着
   * 一句还没有任何依据的肯定话。问过了没有得自己记一格，清单本身答不了。
   */
  const [agentsSettled, setAgentsSettled] = useState(false);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  /** 项目树**问过了**没有。理由与 `agentsSettled` 同：空清单说不出自己是哪一种空。 */
  const [projectsSettled, setProjectsSettled] = useState(false);
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
  /**
   * 派发种子留在这一页的内存里、不进历史记录：浏览器刷新会保留 history.state，放在那里
   * 的话刷新之后还拿着派发那一刻的机器去连，绕过按地址认领（规格决策 4）。
   */
  const [draftSeed, setDraftSeed] = useState<DraftSeed | null>(null);
  /**
   * 地址换到另一条会话（点行、后退前进、派发落地）：右栏归地址说了算（规格决策 5）。
   * 开着的「新对话」一并收掉，否则前进到一条会话时右栏还摆着挑 Agent 那一屏；别的
   * 会话的派发种子也不再作数。离开到不开会话的 `/chat` 不收——进「新对话」正是这样
   * 离开的。
   */
  const [lastOpenId, setLastOpenId] = useState(openConversationId);
  if (lastOpenId !== openConversationId) {
    setLastOpenId(openConversationId);
    if (openConversationId !== null) setCompose(null);
    if (draftSeed && draftSeed.conversationId !== openConversationId) {
      setDraftSeed(null);
    }
  }
  // 「最近用过」只在打开这一路时读一次：读它是为了排个序，不值得每次渲染都碰
  // 一次 localStorage。
  const [recentIds, setRecentIds] = useState<string[]>([]);
  /**
   * 离开当前开着的会话，回到不开任何会话的 `/chat`（范围参数留着）。
   *
   * 用 replace：这是系统替用户离开，不是用户想退回去的一格——后退回一条已删除的
   * 会话、或刚被「新对话」接管的那一条都没有意义（规格决策 7）。
   */
  const leaveSession = useCallback(() => {
    const current = locationRef.current;
    if (!current.conversationId) return;
    void nav(chatIndexAddress(current.search), { replace: true });
  }, [nav]);
  const beginCompose = useCallback(() => {
    setRecentIds(readRecentAgents());
    setCompose({ step: "pick" });
  }, []);
  const openCompose = useCallback(() => {
    beginCompose();
    // 右栏从此归「新对话」这一路，没有任何一条对话开着了：地址一并离开那条，否则
    // 左栏还标着上一条，看上去像是正往那条对话里写。见 onProjectNewChat 那处
    // 同一句。
    leaveSession();
  }, [beginCompose, leaveSession]);
  /** 删掉一条之后：右栏归这一页管，因此这一步借给索引数据层。 */
  const onSessionDeleted = useCallback(
    (row: MirrorIndexRow) => {
      // 右栏正开着这一条时一并收起：它已经不存在了，留在那里等于让用户对着一份
      // 已经删掉的转录继续读。身份就是 conversation_id，与行的键同一个值。
      if (locationRef.current.conversationId === row.conversationId) {
        leaveSession();
      }
    },
    [leaveSession],
  );
  /**
   * 右栏正开着的那条写进了账号：`?device=` 只是未保存会话的寻址兜底，从此由账号那一行
   * 认承载机器，地址原地去掉它（replace，右栏不重挂）。
   */
  const onSessionSaved = useCallback(
    (conversationId: string) => {
      const current = locationRef.current;
      if (
        current.conversationId !== conversationId ||
        current.deviceParam === null
      ) {
        return;
      }
      void nav(sessionAddress(conversationId, {}, current.search), {
        replace: true,
      });
    },
    [nav],
  );
  /**
   * 索引的数据层整族住在 useSessionIndex 里：取数、分页、计数，以及保存 / 删除那两个
   * 乐观动作。轴与筛选是**范围**、因此借给它；删掉之后右栏怎么收由这一页说了算。
   */
  const sessionIndex = useSessionIndex({
    axis,
    devices,
    filter,
    onDeleted: onSessionDeleted,
    onSaved: onSessionSaved,
  });
  // 这两个（连同下面 reach 的 forgetResolved）单独拎出来：整个 hook 结果每次渲染都是
  // 新对象，把它整个钉进依赖数组会让下面几个 useCallback 每渲染换一次引用，索引里的
  // 行因此整片重造（见 ChatIndexPanel 的 sessionPath 那一段）。它们本身是 useCallback，稳定。
  const { refetch, fetchGroupPage, markRead, reportUnsavedOnStart } =
    sessionIndex;
  /**
   * 从别处进来的「新建一个会话」。目前唯一的来源是会话详情的「机器离线」横幅：
   * 那条对话钉在一台够不着的机器上、续轮不会改派，唯一走得通的路是另起一条。
   *
   * 走 URL 而不是回调，因为详情里那颗按钮离这一页隔着好几层，没有回调递得过来。
   *
   * 参数进来就消掉：它说的是「刚才要新建」这件一次性的事，不是页面此刻的范围。
   * 留着的话，之后每一次刷新与前进后退都会把人重新丢回挑 Agent 那一屏。
   */
  useEffect(() => {
    if (searchParams.get("compose") !== "1") return;
    // 状态更新推到 effect 之后：`react-hooks/set-state-in-effect` 禁止在 effect 体里
    // 裸调 setState（同一条规矩在 SessionDetailView 的 pendingSend 那处也绕过一次）。
    void Promise.resolve().then(() => {
      beginCompose();
      // 一并离开开着的那条会话：compose 与会话地址都不该留在地址上。
      void nav(chatIndexAddress(searchParams), { replace: true });
    });
  }, [searchParams, nav, beginCompose]);
  /**
   * 派发成功：这条对话已经进账号，直接去读它的实时流；compose 到此结束。
   *
   * 这条新对话从此与左栏里点开的任何一条没有分别，落地形态因此与 `onSelect` 同一
   * 套：push 到它的会话地址。桌面端右栏就地嵌入它的真实详情，左栏那份上下文不动；
   * 移动端单列没有第二栏可落，整屏换成它的详情。
   *
   * `peerFingerprint` 记的是**发起端**——从控制台派发出去的对话发起端是这个浏览器，
   * 承载它的才是那台 agentred，两者不是同一个值（dispatch 那一步的保存也正是这么
   * 分开报的）。它不再参与寻址（身份是 conversation_id），只在点名发起端的那几个
   * wire 请求上用得到。
   */
  const onDraftStarted = useCallback(
    (
      {
        deviceId,
        deviceFingerprint,
        conversationId,
        peerFingerprint,
        title,
        userText,
        modelPinned,
        reasoningEffortPinned,
        savedToAccount,
      }: DispatchedSession,
      /**
       * 这条对话是**哪个 Agent** 的 —— 就是草稿页那一屏用户亲手挑的那个，调用点
       * （`composeDraft`）手里现成。
       *
       * 递给落地那一屏当种子（`initialAgent`）：详情页自己解这件事要两条链式的异步
       * （先由镜像行 / `session.list` 认出 agentSyncId，再拿它去账号清单换名字与头像），
       * 而刚派发出去的这条账号里还没有那一行——整段空窗里抬头一个字都说不出。与
       * `title` / `userText` 同一条路子：这一屏知道的，不让用户在下一屏重等一圈。
       */
      agent: NewConvAgent,
    ) => {
      setCompose(null);
      // 钉不住不影响这条对话开起来（第一轮就是按所选模型跑的），但后续轮次会回到
      // 跟随 Agent 绑定 —— 详情页必须如实说出来，否则它会显示成「跟随绑定」而
      // 用户明明选过。
      const modelNote = modelPinned
        ? undefined
        : t("session.composerControls.modelNotPinnedOnStart");
      // 力度没钉住是同一件事的另一半：第一轮按所选档位跑了，后续轮次回到后端配置。
      const effortNote = reasoningEffortPinned
        ? undefined
        : t("session.composerControls.effortNotPinnedOnStart");
      // 这一轮**刚刚**由这一屏派发出去。详情页装载时 attach 只看得到「对端已经在
      // 跑」，而那种轮次它一律不计时（什么时候开的它不知道）——交出去，第一轮的耗时
      // 才不必等它跑完才出数。
      const turnStartedAt = Date.now();
      // 桌面与移动同一步：push 到这条会话的地址；种子留在这一页里（不进地址，也不进
      // 历史记录）。承载机器也在种子里——这条对话此刻还不在索引里，不带的话右栏要先
      // 绕一趟认领。
      setDraftSeed({
        conversationId,
        deviceId,
        peerFingerprint,
        title,
        userText,
        turnStartedAt,
        agent,
        modelNote,
        effortNote,
      });
      void nav(
        sessionAddress(
          conversationId,
          savedToAccount ? {} : { device: deviceId },
          locationRef.current.search,
        ),
      );
      // 左栏还是派发之前那一份，里面没有这条刚写进账号的对话：右栏开着它、左栏
      // 却列不出来，看上去就像它没进账号。重取一次让它落成一行。
      //
      // 但它**真的**没进账号时，重取是取不出来的：那一刻左栏的空白不是「还没取」，
      // 而是一个事实，且与「派发根本没成功」长得一模一样。此前这里只有 refetch，
      // 于是用户面对的就是那个无法证伪的画面。如实说出来，并把重试挂上去。
      if (savedToAccount) {
        refetch();
        return;
      }
      reportUnsavedOnStart({
        conversationId,
        title: title ?? "",
        machineFingerprint: deviceFingerprint,
        peerFingerprint,
      });
    },
    [refetch, reportUnsavedOnStart, nav, t],
  );
  /**
   * 右栏「打开即已读」回来了：把左栏那一行就地改掉。
   *
   * 此前这里是 refetch()——为了一个服务端刚刚告诉过我们的时刻，重取一遍当前范围的
   * 索引外加一次完整集合上的未读数探测。这条路每点开一条对话就走一遍。
   * 直接把 markRead 挂上去：它本就是 useCallback 的稳定引用。
   */

  /** 机器与 Agent 名单只喂组头与行上的另外两维，不随**范围**重取。 */
  useAliveEffect((alive) => {
    Promise.all([fetchDevices(), fetchAgents()])
      .then(([d, a]) => {
        if (!alive()) return;
        setDevices(d);
        setAgents(a);
      })
      .catch((e: unknown) => {
        if (alive()) sessionIndex.setLoadError(e);
      })
      // 取不到也算问过：挑 Agent 那一屏不能为了一次失败永远转下去。
      .finally(() => {
        if (alive()) setAgentsSettled(true);
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
      .catch(() => {})
      // 取不到也算问过：那一屏不能为了一次失败永远转下去。
      .finally(() => setProjectsSettled(true));
  }, []);
  useEffect(() => {
    reloadProjects();
  }, [reloadProjects]);

  // 同步版本推进：行上的 Agent 名与项目轴的组头都来自 sync_objects。放在这里而不是
  // 跟另外两条信号挤在一起，只因为它要用到上面这个 reloadProjects。
  useAccountChannel([AccountChannelSyncVersion], () => {
    fetchAgents()
      .then(setAgents)
      .catch(() => {});
    reloadProjects();
  });

  /**
   * 机器可达性整族住在 useMachineReachability 里：中继连接、每台的解析状态、重试，
   * 以及由设备名单派生的那几份表。它与索引在设备名单和搜索词这两份数据上碰头 ——
   * 后者随 session.list 下推给机器，由机器自己筛（否则整份清单过线，绝大多数与搜索无关）。
   */
  const reach = useMachineReachability({
    devices,
    axis,
    machineScope,
    keyword: sessionIndex.debouncedSearch,
    filter,
  });
  const { forgetResolved } = reach;

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
    (agent: NewConvAgent, projectSyncId: string) => {
      setCompose({ step: "draft", agent, projectSyncId });
      // 同 openCompose：草稿接管右栏之后没有对话开着，左栏的高亮跟着松开。
      leaveSession();
    },
    [leaveSession],
  );
  /**
   * Agent 轴的组头上那颗 ＋。索引报回来的是组键，而 Agent 轴的组键就是
   * agentSyncId——在这儿换回「新对话」那一族要的那份 Agent 载荷。
   *
   * 认不出来就什么都不做：清单还没回来、或这个 Agent 已经从账号里去掉了，都不该
   * 开一份没有 Agent 的草稿出来。
   */
  const onAgentNewSession = useCallback(
    (agentSyncId: string) => {
      const agent = agents.find((a) => a.sync_id === agentSyncId);
      if (!agent) return;
      setCompose({ step: "draft", agent });
      // 同 openCompose：草稿接管右栏之后没有对话开着，左栏的高亮跟着松开。
      leaveSession();
    },
    [agents, leaveSession],
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
      // 换轴就是重新分组，范围跟着丢掉：`?machine=` 是设备下钻带过来的收窄，
      // 自己动手换轴的人要的是完整的那一份。再点一次机器轴因此回到每台一组。
      params.delete("machine");
      setSearchParams(params, { replace: true });
    },
    [axis, searchParams, setSearchParams, forgetResolved],
  );

  /**
   * 一条会话的地址：继承此刻的索引范围，未保存的行带上它所在的机器。
   *
   * 只随查询串变：索引的行渲染与 openRow 都把它列在依赖里（见 ChatIndexPanel）。
   */
  const sessionPath = useCallback(
    (target: SessionPathTarget) =>
      sessionAddress(
        target.conversationId,
        target.saved === false ? { device: target.deviceId } : {},
        location.search,
      ),
    [location.search],
  );

  // 桌面点行 → push 到这条会话的地址，右栏跟着地址嵌入真实详情视图。
  const onSelect = useCallback(
    (row: MirrorIndexRow) => {
      if (row.deviceId === undefined) return;
      // 开着「新对话」时右栏归它，选中的会话渲染不出来。点了左栏的一条就是要看
      // 那一条——不在这里收掉 compose，人会被困在挑 Agent 那一屏，除了真开一条
      // 对话没有别的出路。草稿本来就没落任何东西，收掉不会丢下什么。
      setCompose(null);
      const target = sessionPath({ ...row, deviceId: row.deviceId });
      // 再点一次正开着的那条不多记一格历史：否则后退要按两下才离得开它。
      const current = locationRef.current;
      if (
        current.conversationId !== null &&
        target ===
          sessionAddress(
            current.conversationId,
            current.deviceParam === null ? {} : { device: current.deviceParam },
            current.search,
          )
      ) {
        return;
      }
      void nav(target);
    },
    [nav, sessionPath],
  );

  /**
   * 这个浏览器亲眼看到的那些轮次（见 `@/lib/liveSessions`）。它叠在**每一条**行上，
   * 因此索引、「查看全部 N」弹层与机器那一档看到的是同一份事实。
   */
  const liveTurns = useLiveTurns();

  /**
   * 行投影的两层薄包装：真正的投影是 chatRows 里的纯函数。
   *
   * 实时覆盖就叠在这里 —— 这两只是**全部**行的必经之路（索引、弹层、机器轴），
   * 叠在更外面的某一处就等于让另外两处继续画旧事实。
   */
  const fromMirrorRow = useCallback(
    (s: MirroredSession) =>
      overlayLiveRow(
        toMirrorRow(s, reach.devicesByFp, t),
        liveTurns.get(s.conversation_id),
      ),
    [reach.devicesByFp, t, liveTurns],
  );
  const fromMachineRow = useCallback(
    (device: DeviceItem, s: SessionSummary, localFingerprint?: string) =>
      overlayLiveRow(
        toMachineRow(device, s, t, localFingerprint),
        liveTurns.get(s.conversationId),
      ),
    [t, liveTurns],
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
        ? sessionIndex.rangePending
          ? new Map()
          : buildMachineRows({
              onlineMachines: reach.onlineMachines,
              resolved: reach.resolved,
              mirrorRows: sessionIndex.mirrorRows,
              fromMirrorRow,
              fromMachineRow,
              filter,
            })
        : null,
    [
      axis,
      reach.onlineMachines,
      reach.resolved,
      sessionIndex.mirrorRows,
      sessionIndex.rangePending,
      fromMirrorRow,
      fromMachineRow,
      filter,
    ],
  );

  /**
   * 每台机器上匹配当前搜索的总数,由机器自己报(手上那一份只是第一页)。
   *
   * **chips 生效时不给**:那一档是在浏览器里按运行态 / 未读筛的,机器不知道这个
   * 口径,拿它的总数去配筛过的行,组头会写着「查看全部 3500」而下面只有两条。
   */
  const machineTotals = useMemo(() => {
    if (filter !== "all") return {};
    const totals: Record<number, number> = {};
    for (const device of reach.onlineMachines) {
      const machine = reach.resolved[device.fingerprint];
      if (machine) totals[device.id] = machine.total;
    }
    return totals;
  }, [filter, reach.onlineMachines, reach.resolved]);

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
        machineTotals,
      }),
    [
      sessionIndex.indexGroups,
      reach.devicesByFp,
      machineRowsByDevice,
      machineTotals,
    ],
  );

  // 从那一族里取出下面这条路要用的三样。**不整个依赖 `reach`**:它每次渲染都是一个
  // 新对象,把它列进依赖会让 loadGroupPage 每渲染一次就换一个身份 —— 而「查看全部」
  // 弹层的取数 effect 认这个身份,于是它每渲染一次就重取一次第一页,自己把自己叫醒。
  const { onlineMachines, resolved: resolvedMachines, loadMachinePage } = reach;

  /**
   * 翻页时要读的那两份行，同样走 ref —— 与上面那条是同一件事，只是漏了。
   *
   * `sessionIndex.mirrorRows` 是一个 `useMemo`，`machineRowsByDevice` 是另一个，
   * 而索引在**每一条** `mirror_changed` 上重取（一轮对话跑起来时约每秒一条），每次
   * 取数都换成新数组。把它们列进依赖，`loadGroupPage` 就每秒换一次身份，弹层的首页
   * effect 于是每秒重跑一遍第一页，把用户已经翻进来的行扔掉——「查看全部 N」在
   * agent 说话期间根本翻不动。
   *
   * 走 ref 是安全的：这两份只在**点开弹层 / 点「加载更多」之后**才被读到，那时提交
   * 早已结束，ref 里就是最新的一批（与 useSessionIndex 的 mirrorRowsRef 同一个理由）。
   */
  const groupPageRowsRef = useRef({
    mirrorRows: sessionIndex.mirrorRows,
    machineRowsByDevice,
  });
  // 每次打开机器 overflow（cursor=null）都重建这一组游标轨迹；同一次展开里若 daemon
  // 给出 A -> B -> A 这样的环，第三页不能继续当作有效进度。
  const machinePageCursorsRef = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    groupPageRowsRef.current = {
      mirrorRows: sessionIndex.mirrorRows,
      machineRowsByDevice,
    };
  });

  /**
   * 翻某一组的下一页（「查看全部 N」那条路）。范围参数一并带上——弹层里翻的必须
   * 还是同一个搜索与筛选下的那一组，否则数说的是一件事、翻出来的是另一件。
   */
  const loadGroupPage = useCallback(
    async (scope: string, cursor: string | null) => {
      const { mirrorRows, machineRowsByDevice } = groupPageRowsRef.current;
      // 机器那一档问的是机器自己,不该拿这个 scope 去问服务端(它只知道账号里保存
      // 过的那些)。翻页也走那台机器:它才知道自己上面还有什么。
      if (machineRowsByDevice) {
        const machine = onlineMachines.find(
          (d) => scope === `machine:${d.fingerprint}`,
        );
        if (machine) {
          const resolved = resolvedMachines[machine.fingerprint];
          if (cursor === null) {
            // 第一页就是索引手上那一份 —— 弹层一打开就为已经拿到的东西再跑一次
            // 往返,只会让它先空着。
            const firstCursor = resolved?.hasMore ? resolved.cursor : "";
            machinePageCursorsRef.current.set(
              machine.fingerprint,
              new Set(firstCursor ? [firstCursor] : []),
            );
            return {
              rows: machineRowsByDevice.get(machine.id) ?? [],
              cursor: firstCursor || null,
              hasMore: !!resolved?.hasMore,
            };
          }
          const seen =
            machinePageCursorsRef.current.get(machine.fingerprint) ??
            new Set<string>();
          seen.add(cursor);
          machinePageCursorsRef.current.set(machine.fingerprint, seen);
          const page = await loadMachinePage(machine.fingerprint, cursor);
          if (page.hasMore && (!page.cursor || seen.has(page.cursor))) {
            throw new Error("invalid machine session cursor");
          }
          if (page.hasMore) seen.add(page.cursor);
          else machinePageCursorsRef.current.delete(machine.fingerprint);
          return {
            rows: toMachineRows({
              device: machine,
              sessions: page.sessions,
              localFingerprint: resolved?.localFingerprint,
              mirrorRows,
              fromMirrorRow,
              fromMachineRow,
              filter,
            }),
            cursor: page.hasMore ? page.cursor : null,
            hasMore: page.hasMore,
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
    [
      fetchGroupPage,
      fromMirrorRow,
      fromMachineRow,
      filter,
      onlineMachines,
      resolvedMachines,
      loadMachinePage,
    ],
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

  /**
   * 右栏这条会话该连哪台机器：与 ResolvedSessionDetail 同一条「承载者优先」——账号那一行
   * 记着承载机器，`?device=` 只是未保存会话的兜底。机器轴上同一条对话常被发起端与承载
   * 机器各报一行，已保存的地址又不带 `?device=`，不先认承载者的话会按分组先后认到
   * 发起端那一行，右栏连错机器、高亮落错行。
   */
  const preferredDeviceId = useMemo(() => {
    if (openConversationId === null) return null;
    const row = sessionIndex.mirrorRows.find(
      (r) => r.conversation_id === openConversationId,
    );
    const host = row
      ? reach.devicesByFp.get(row.device_fingerprint)
      : undefined;
    return host?.id ?? deviceParam;
  }, [
    openConversationId,
    sessionIndex.mirrorRows,
    reach.devicesByFp,
    deviceParam,
  ]);
  const selectedKey = useMemo(
    () => findSelectedKey(view.rows, openConversationId, preferredDeviceId),
    [openConversationId, preferredDeviceId, view.rows],
  );
  /**
   * 右栏那条会话手上现成的种子：索引里列着它时就是那一行（机器、发起端、账号那一行
   * 都在上面），否则是刚派发出来时这一页记下的机器。都没有才让详情按地址去认。
   *
   * 记住最近一次给过的种子（同一条会话内）：搜索、筛选、换轴会让那一行暂时列不出来，
   * 种子一撤右栏就要回头认领一遍——整个详情卸掉重挂，正在读的转录闪成空白。
   */
  const selectedRow = selectedKey
    ? view.rows.find((r) => r.key === selectedKey)
    : undefined;
  const openSeed =
    draftSeed && draftSeed.conversationId === openConversationId
      ? draftSeed
      : undefined;
  const liveSeed: SessionDetailSeed | undefined =
    openConversationId === null
      ? undefined
      : selectedRow?.deviceId !== undefined
        ? {
            deviceId: selectedRow.deviceId,
            peerFingerprint: selectedRow.fingerprint,
            row: sessionIndex.mirrorRows.find(
              (r) => r.conversation_id === openConversationId,
            ),
          }
        : openSeed
          ? {
              deviceId: openSeed.deviceId,
              peerFingerprint: openSeed.peerFingerprint,
            }
          : undefined;
  const [stickySeed, setStickySeed] = useState<{
    conversationId: string;
    seed: SessionDetailSeed;
  } | null>(null);
  if (
    openConversationId !== null &&
    liveSeed &&
    (stickySeed?.conversationId !== openConversationId ||
      stickySeed.seed.deviceId !== liveSeed.deviceId ||
      stickySeed.seed.peerFingerprint !== liveSeed.peerFingerprint ||
      stickySeed.seed.row !== liveSeed.row)
  ) {
    setStickySeed({ conversationId: openConversationId, seed: liveSeed });
  }
  const detailSeed =
    liveSeed ??
    (stickySeed && stickySeed.conversationId === openConversationId
      ? stickySeed.seed
      : undefined);
  const detailTitle = openSeed?.title ?? selectedRow?.title;

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
    projectCount: projects.length,
    agentCount: agentInfos.length,
  });
  // `empty` also accounts for authoritative empty groups so mobile does not hide
  // them. The desktop detail copy answers the narrower account-level question.
  const accountEmpty = sessionIndex.accountTotal === 0;
  const mobileTrueEmpty =
    empty && sessionIndex.debouncedSearch === "" && filter === "all";
  /*
    页面级的那簇控件：连接态 + 语言/主题。

    转录上方此前叠着两条带 —— 壳的 52px 顶栏（一个与侧栏高亮重复的「对话」标题，
    外加这簇控件）和 89px 的详情头部，合计 141px 只承载一行标题和一行 meta。桌面档
    因此也走壳的 `ownHeader`：顶栏下线，这簇控件跟着落到右栏顶带的右端 —— 选中
    对话时那条带**就是**详情头部本身，没选中时才由下面那条 `chat-chrome` 承接。
    两种情形同高（68px），控件的位置不跳。
  */
  const pageChrome = !isMobile ? (
    <div className="flex shrink-0 items-center gap-2">
      <AppControls />
    </div>
  ) : null;

  /** 没选中对话时右栏自己那条顶带：只承载 pageChrome，与左列顶行同高。 */
  const chromeBand = pageChrome ? (
    <div
      data-testid="chat-chrome"
      className="flex h-[68px] shrink-0 items-center justify-end border-b border-border bg-card px-5"
    >
      {pageChrome}
    </div>
  ) : null;

  const composePick = (
    <NewConversationPane
      agents={agents}
      recentIds={recentIds}
      onPick={(agent) => setCompose({ step: "draft", agent })}
      onFromProject={() => setCompose({ step: "project" })}
      settled={agentsSettled}
    />
  );
  const composeProject = (
    <ProjectAgentPane
      projects={newConvProjects}
      agents={agents}
      stacked={isMobile}
      onPick={(agent) => setCompose({ step: "draft", agent })}
      onBack={() => setCompose({ step: "pick" })}
      onNewProject={projectManagement.openCreate}
      projectsSettled={projectsSettled}
      agentsSettled={agentsSettled}
    />
  );
  const composeDraft =
    compose?.step === "draft" ? (
      <DraftSession
        agent={compose.agent}
        agents={agents}
        projects={newConvProjects}
        initialProjectSyncId={compose.projectSyncId}
        onStarted={(session) => onDraftStarted(session, compose.agent)}
        onBack={isMobile ? () => setCompose({ step: "pick" }) : undefined}
        headerRight={pageChrome}
      />
    ) : null;

  // 只有索引及项目、Agent、设备名单都完成后，分组结果才可靠。
  const settled =
    indexSettled(sessionIndex) &&
    (axis === "machine" ||
      !sessionIndex.rangePending ||
      !!sessionIndex.loadError) &&
    projectsSettled &&
    agentsSettled;

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
      projects={projects}
      agents={agentInfos}
      groupTotals={groupTotals}
      loadGroupPage={loadGroupPage}
      projectManagement={projectManagement}
      onAgentNewSession={onAgentNewSession}
      rowStatusLabel={isMobile}
      machineRangePending={sessionIndex.rangePending}
      sessionPath={sessionPath}
    />
  );

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

  // 移动端单列：地址上开着一条会话时整屏就是它的详情，索引留在后退的那一格里。
  if (isMobile && openConversationId) {
    return (
      <ResolvedSessionDetail
        conversationId={openConversationId}
        deviceParam={deviceParam}
        seed={detailSeed}
        form="page"
        backTo={chatIndexAddress(location.search)}
        initialTitle={detailTitle}
        initialUserText={openSeed?.userText}
        initialAgent={openSeed?.agent}
        initialModelNote={openSeed?.modelNote}
        initialEffortNote={openSeed?.effortNote}
        initialTurnStartedAt={openSeed?.turnStartedAt}
        onMarkedRead={markRead}
      />
    );
  }

  return (
    <AppShell flush ownHeader>
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
            /* 这一条顶栏由页面自己排（壳走 ownHeader，够不着它），所以安全区也得
               自己让：viewport-fit=cover 之后内容会伸到状态栏底下，无刘海设备
               env() 为 0、与改动前逐像素相同。 */
            className="shrink-0 border-b border-border bg-card pt-[env(safe-area-inset-top,0px)]"
          >
            <div className="flex h-[52px] items-center gap-2 px-3">
              <span className="shrink-0 text-prose font-bold text-foreground">
                {t("nav.chat")}
              </span>
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
            {!settled ? <SessionRowSkeleton /> : null}
            {settled && mobileTrueEmpty ? (
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
            {settled && !mobileTrueEmpty && index}
            {/* 移动有会话时：新建入口（IC5sH 的 pen-line FAB），在底栏之上。它只在
              有会话时出现，所以可访问名是「新对话」——「开始第一个对话」在这里
              与事实相反，而屏幕阅读器上这个名字就是它的全部。 */}
            {settled && !mobileTrueEmpty && (
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
          {/*
            320px 是起点不是结论：只列着几条短标题的人希望这一列让位给转录，
            按项目分组、标题写满一行的人在 320px 里读到的全是省略号。谁对取决于
            这一刻在做什么，所以交给拖（共享包的 ResizableSidebar，量程 220–640，
            记在这台机器上），而不是再挑一个所有人都不满意的定值。
          */}
          <ResizableSidebar
            persistenceKey="chat"
            ariaLabel={t("chat.listAria")}
            testId="chat-list-col"
            className="bg-card"
          >
            {/* 左列顶行与右栏那条顶带同高：两列的顶边因此是同一条横线。省下的
                16px 换不来一条断开的顶边。 */}
            <div
              data-testid="chat-list-head"
              className="flex h-[68px] shrink-0 items-center gap-1.5 border-b border-border px-2.5"
            >
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
              {!settled ? <SessionRowSkeleton rows={6} /> : index}
            </div>
          </ResizableSidebar>
          <div
            data-testid="chat-detail"
            className="flex min-w-0 flex-1 flex-col"
          >
            {/* 选中对话时详情头部**就是**这一栏的顶带，那簇控件递进它的右端；
                草稿那条顶带同样是（它与详情共用同一副外壳，见 DraftSession）。
                其余几档没有那样一条带，才由 chromeBand 顶上。三者同高，控件
                因此不会随着选中与否、发没发出第一句上下跳。 */}
            {!openConversationId && compose?.step !== "draft" && chromeBand}
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
            ) : openConversationId ? (
              /* 地址上开着一条会话：右栏嵌入它的真实详情（embedded 形态：无外壳/
                 面包屑，由外层给尺寸）。先认出承载机器，再交给 SessionDetailView。 */
              <div className="min-h-0 flex-1">
                <ResolvedSessionDetail
                  conversationId={openConversationId}
                  deviceParam={deviceParam}
                  seed={detailSeed}
                  form="embedded"
                  initialTitle={detailTitle}
                  initialUserText={openSeed?.userText}
                  initialAgent={openSeed?.agent}
                  initialModelNote={openSeed?.modelNote}
                  initialEffortNote={openSeed?.effortNote}
                  initialTurnStartedAt={openSeed?.turnStartedAt}
                  headerRight={pageChrome}
                  onMarkedRead={markRead}
                />
              </div>
            ) : (
              /* 未选中 / 没有真实会话：按 kpP7A 的空态层级呈现（共享 EmptyState）。
                 两种「空」说的不是同一件事——左边列着几条、只是还没点开的时候，
                 这里不能说「还没有对话」。 */
              <div className="flex flex-1 items-center justify-center p-4">
                <EmptyState
                  icon={MessageCirclePlus}
                  title={t(
                    accountEmpty ? "chat.noSessions" : "chat.pickSession",
                  )}
                  body={accountEmpty ? t("chat.startFirstBody") : undefined}
                  testId={
                    accountEmpty ? "chat-empty-state" : "chat-unselected-state"
                  }
                  action={
                    <>
                      {/* R15 的主动作：打开新对话弹层（屏 23/24/25）。 */}
                      <Button size="lg" onClick={openCompose}>
                        {t(accountEmpty ? "chat.startFirst" : "chat.startNew")}
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
          settled={agentsSettled}
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

      {reach.resolvers}
    </AppShell>
  );
}
