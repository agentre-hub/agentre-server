import { type SessionSummary } from "@agentre-hub/agentre-wire";

import type { DeviceItem } from "@/lib/devices";
import type { IndexRow } from "@/lib/sessionAxes";
import { groupKeyOfScope } from "@/lib/sessionScope";
import {
  matchesSessionFilter,
  sessionTitle,
  type SessionFilter,
} from "@/lib/sessionView";
import type { ResolvedMachine } from "@/pages/chat/useMachineReachability";

/**
 * 「对话」页的行投影：线上载荷 → 索引的行，以及由那些行算出来的分组、计数与视图。
 *
 * 整族是**纯函数**（不闭包捕获任何组件状态），页面里只留一层 `useMemo` /
 * `useCallback` 包装。这一族要么被索引本身用、要么被「查看全部 N」弹层用、要么被
 * 机器那一档用，三处必须给出同一种行。
 */

/** 一条账号镜像里的会话（线上载荷形状，下划线键）。 */
export interface MirroredSession {
  /** 发起端指纹：与 session_id 一起构成这条对话在账号里的身份（决策 17）。 */
  peer_fingerprint: string;
  /** 承载这条对话、详情实际要连接的账号设备；与发起端可以不同。 */
  machine_fingerprint: string;
  session_id: string;
  title?: string;
  agent_sync_id?: string;
  project_sync_id?: string;
  backend_type?: string;
  lifecycle_state?: string;
  waiting_for_input?: boolean;
  last_message_at?: number;
  /** 这个账号最后一次打开它的时刻（Unix 毫秒），从没打开过时缺省。 */
  last_read_at?: number;
}

/**
 * 索引行加一维「读到哪了」。共享包的 `IndexRow` 上没有这一列（它是本站账号镜像
 * 独有的），而机器轴那一档要在**本地**判「未读」——那份清单是机器实时报的，没经过
 * 服务端的筛选。其余三个轴由服务端筛，用不到它。
 */
export type MirrorIndexRow = IndexRow & { lastReadAt?: number };

/** GET /v1/agent-sessions 的一组：组的身份、它在当前范围下的真数、先给的那几条。 */
export interface IndexGroupPayload {
  scope: string;
  total: number;
  items?: MirroredSession[];
  cursor?: string;
  has_more?: boolean;
}

/**
 * 一次索引读取的应答（规格 2026-08-19「索引读到什么」）。groups 与 items 互斥：
 * 不带 scope 时给组骨架，带 scope 时给那一组的行。total 是**当前搜索与筛选下**
 * 账号里的条数，与已加载多少无关。
 */
export interface IndexResponse {
  groups?: IndexGroupPayload[];
  items?: MirroredSession[];
  cursor?: string;
  has_more?: boolean;
  total: number;
}

/** `sessionTitle` 认的那一种 t：这里只是把它传下去，不额外要求 i18next 的全貌。 */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 机器那一档先列几条。与其余轴的每组条数同一个量级（规格决策 4）：这一档同样是
 * 「一台机器 = 一组」，没有理由比项目组铺得更开。
 */
const MACHINE_PAGE_SIZE = 5;

/** 账号里一条对话的身份：（发起端指纹, 那一端的会话标识）。 */
export function rowKey(
  fingerprint: string,
  sessionId: number | string,
): string {
  return `${fingerprint}:${sessionId}`;
}

/**
 * 账号镜像里的一条 → 索引的一行。机器认不出来时机器那一维空着，行照常在。
 *
 * 提到 view 之外是因为它有**三个**用处：索引本身、「查看全部 N」弹层里翻回来的
 * 那些行，以及机器那一档里「账号已经有」的那些。三处各写一份就会长出三种行。
 */
export function toMirrorRow(
  s: MirroredSession,
  devicesByFp: Map<string, DeviceItem>,
  t: Translate,
): MirrorIndexRow {
  const device = devicesByFp.get(s.machine_fingerprint);
  return {
    key: rowKey(s.peer_fingerprint, s.session_id),
    sessionId: Number(s.session_id),
    deviceId: device?.id,
    fingerprint: s.peer_fingerprint,
    agentSyncId: s.agent_sync_id?.trim() ?? "",
    projectSyncId: s.project_sync_id?.trim() ?? "",
    updatedAt: s.last_message_at ?? 0,
    title: sessionTitle(
      {
        title: s.title,
        backendType: s.backend_type,
        lifecycleState: s.lifecycle_state ?? "",
      },
      t,
    ),
    lifecycleState: s.lifecycle_state ?? "",
    waitingForInput: s.waiting_for_input,
    lastReadAt: s.last_read_at ?? 0,
    saved: true,
  };
}

/**
 * 这条会话在账号里的**发起端**指纹。
 *
 * `session.list` 只在「发起端不是调用方自己」时才交出 `peerFingerprint`
 * （daemon 的 session_catchup.List：`row.PeerFingerprint != peer` 才写）。因此空值
 * 的语义是「就是本次调用的这一端」——在控制台这里，那是**这个浏览器**的中继标识，
 * 不是承载它的那台机器。
 *
 * 兜底成机器指纹的话，从控制台派发出去的每一条对话都会算出一个账号里不存在的身份：
 * 机器轴上它们永远挂着「保存」（镜像明明有），按下去写进去的是一条以机器指纹冒充
 * 发起端的假记录，而转录与「已读」也会拿这个假身份去问 server，回来的是 0 帧。
 *
 * 连接还没交出 ticket 时才退到机器指纹：那一档本来就列不出任何行。
 */
export function machineRowOrigin(
  s: SessionSummary,
  device: DeviceItem,
  localFingerprint: string | undefined,
): string {
  return (
    s.peerFingerprint?.trim() || localFingerprint?.trim() || device.fingerprint
  );
}

/** 选中的那台机器上报的一条（还没进账号的那些）→ 索引的一行。 */
export function toMachineRow(
  device: DeviceItem,
  s: SessionSummary,
  t: Translate,
  localFingerprint?: string,
): IndexRow {
  const origin = machineRowOrigin(s, device, localFingerprint);
  return {
    key: rowKey(origin, s.sessionId),
    sessionId: s.sessionId,
    // 这一档看的就是这台机器，行因此挂在它下面（读写都要连到它）。
    deviceId: device.id,
    fingerprint: origin,
    agentSyncId: s.agentSyncId?.trim() ?? "",
    // 项目归属由服务端在镜像上判（决策 12）：还没保存的对话 server 手里没有
    // 它的任何东西，因此这一维如实空着，而不是拿 cwd 在浏览器里猜一个。
    projectSyncId: "",
    updatedAt: s.lastMessageAt ?? 0,
    title: sessionTitle(s, t),
    lifecycleState: s.lifecycleState,
    waitingForInput: s.waitingForInput,
    saved: false,
  };
}

/**
 * 这一轮范围下服务端给出的全部行：组骨架里各组先给的那几条，加上「加载更多」
 * 追加的页。按身份去重——分组轴上同一条对话只可能出现在一个组里，去重防的是
 * 追加页与骨架在边界上撞车。
 */
export function mergeMirrorRows(input: {
  indexGroups: IndexGroupPayload[];
  appended: MirroredSession[];
  optimisticSaved: MirroredSession[];
  optimisticRemoved: string[];
  /**
   * 「刚打开过」的那几条各自的已读时刻（键同 rowKey）。
   *
   * 打开一条对话就把它标成已读，而服务端把新的已读时刻原样回给了客户端
   * （MarkSessionReadResponse.last_read_at「供客户端就地覆盖那一行」）。盖在这里
   * 而不是重取一遍索引：重取拿回来的是同一份行，只是多两条请求，而这条路是
   * **每次点进一条对话**都要走的。
   *
   * 与另外两层覆盖同寿：活到下一次取数为止，那时服务端的真值把它整份换掉。
   */
  optimisticRead?: ReadonlyMap<string, number>;
}): MirroredSession[] {
  const byKey = new Map<string, MirroredSession>();
  for (const group of input.indexGroups) {
    for (const item of group.items ?? []) {
      byKey.set(rowKey(item.peer_fingerprint, item.session_id), item);
    }
  }
  for (const item of input.appended) {
    byKey.set(rowKey(item.peer_fingerprint, item.session_id), item);
  }
  for (const item of input.optimisticSaved) {
    byKey.set(rowKey(item.peer_fingerprint, item.session_id), item);
  }
  for (const key of input.optimisticRemoved) byKey.delete(key);
  for (const [key, lastReadAt] of input.optimisticRead ?? []) {
    const row = byKey.get(key);
    // 只盖在场的那一行。覆盖层里可能留着已经不在这一轮范围里的键（换了搜索词、
    // 换了轴），那时它什么都不该凭空造出来。
    if (!row) continue;
    // 取大的那个：服务端交出来的行可能比这次点击还新（另一端刚打开过同一条）。
    // 往回退等于把一条已经读过的对话重新标成未读。
    byKey.set(key, {
      ...row,
      last_read_at: Math.max(row.last_read_at ?? 0, lastReadAt),
    });
  }
  return [...byKey.values()];
}

/**
 * 机器轴上每台在线机器**各自的整份**（规格 2026-08-21 决策 1，口径沿用
 * 2026-08-19 决策 11 / 12，只是从「选中的那一台」扩到「每一台」）。
 *
 * 在线的机器以它自己上报的那份为准：镜像里发起自这台机器、但机器本地已经没有了的
 * 那些不在其中——它们不在这个问题的答案里（其余三个轴上照常在）。离线的机器压根
 * 不在这张表里：它答不出，一行都不列。
 */
export function buildMachineRows(input: {
  onlineMachines: DeviceItem[];
  resolved: Record<string, ResolvedMachine>;
  mirrorRows: MirroredSession[];
  fromMirrorRow: (s: MirroredSession) => MirrorIndexRow;
  fromMachineRow: (
    device: DeviceItem,
    s: SessionSummary,
    localFingerprint: string | undefined,
  ) => IndexRow;
  filter: SessionFilter;
}): Map<number, MirrorIndexRow[]> {
  const savedByKey = new Map(
    input.mirrorRows.map((s) => [rowKey(s.peer_fingerprint, s.session_id), s]),
  );
  const byDevice = new Map<number, MirrorIndexRow[]>();
  for (const device of input.onlineMachines) {
    let rows: MirrorIndexRow[] = (
      input.resolved[device.fingerprint]?.sessions ?? []
    ).map((s) => {
      // 空 origin = 「这条连接的这一端」，也就是本浏览器（见 machineRowOrigin）。
      const localFingerprint =
        input.resolved[device.fingerprint]?.localFingerprint;
      const origin = machineRowOrigin(s, device, localFingerprint);
      const mirroredRow = savedByKey.get(rowKey(origin, s.sessionId));
      // 账号里已经有的那条：标出来，并把只有服务端判得出的项目归属带上（决策 12）。
      const row = mirroredRow
        ? { ...input.fromMirrorRow(mirroredRow), deviceId: device.id }
        : input.fromMachineRow(device, s, localFingerprint);
      // 账号身份仍是 origin + session；但机器轴会让多台机器各自报告同一条
      // 会话。渲染/键盘导航的行身份还必须包含报告机器，否则两行会共用一个
      // React key 和 data-nav-target，ArrowDown 永远把焦点送回第一行。
      return {
        ...row,
        // 自己报告自己的常规行保留账号身份键（行尾动作与已有选择状态都认它）；
        // 只有代另一发起端报告时才补报告机器维度，这正是会发生重复的分支。
        key:
          origin === device.fingerprint ? row.key : `${device.id}:${row.key}`,
      };
    });
    // 搜索**不在这里**过：关键词随 session.list 下推给机器了，这份清单已经是命中项。
    // 在这里再按标题筛一遍会把机器按 agent 名 / 项目名命中的那些丢掉（桌面端手上有
    // 这些名字，agentred 只有标题——见 wire 里 SessionListRequest.keyword 的注释）。
    //
    // chips 仍要就地过：它判的是运行态与未读，机器上报的那一份没有这些口径，判据
    // 与服务端逐字一致——两处不一样的话，同一个 chip 在这一档筛出的就是另一批。
    if (input.filter !== "all") {
      rows = rows.filter((r) => matchesSessionFilter(r, input.filter));
    }
    byDevice.set(device.id, rows);
  }
  return byDevice;
}

/**
 * 组键 → 这一组在当前范围下的真数（决策 6）。服务端按**它自己的**组身份说话
 * （`agent:<id>` / `machine:<指纹>`…），索引按客户端的组键分组，这里是两套词汇
 * 唯一的翻译处。认不出机器的那些行在客户端并成一组，因此它们的数要相加。
 */
export function buildGroupTotals(input: {
  indexGroups: IndexGroupPayload[];
  devicesByFp: Map<string, DeviceItem>;
  machineRowsByDevice: Map<number, MirrorIndexRow[]> | null;
}): Record<string, number> {
  const totals: Record<string, number> = {};
  // 机器那一档的数不来自服务端：整份是机器自己上报的，就在手里。
  if (input.machineRowsByDevice) {
    for (const [deviceId, rows] of input.machineRowsByDevice) {
      totals[`device-${deviceId}`] = rows.length;
    }
    return totals;
  }
  for (const group of input.indexGroups) {
    const key = groupKeyOfScope(
      group.scope,
      (fingerprint) => input.devicesByFp.get(fingerprint)?.id,
    );
    if (!key) continue;
    totals[key] = (totals[key] ?? 0) + group.total;
  }
  return totals;
}

/** 索引这一刻列出来的行，外加「这一份是不是被搜索/筛选收窄过」。 */
export interface IndexView {
  rows: IndexRow[];
  narrowed: boolean;
}

export function buildView(input: {
  machineRowsByDevice: Map<number, MirrorIndexRow[]> | null;
  mirrorRows: MirroredSession[];
  fromMirrorRow: (s: MirroredSession) => MirrorIndexRow;
  search: string;
  filter: SessionFilter;
}): IndexView {
  const narrowed = !!input.search || input.filter !== "all";
  if (input.machineRowsByDevice) {
    // 机器那一档：每台机器的整份都在手，因此各自先只列几条、其余走
    // 「查看全部 N」，N 是那台机器的真数。离线的机器不在这张表里，一行都不列。
    return {
      rows: [...input.machineRowsByDevice.values()].flatMap((rows) =>
        rows.slice(0, MACHINE_PAGE_SIZE),
      ),
      narrowed,
    };
  }
  return { rows: input.mirrorRows.map(input.fromMirrorRow), narrowed };
}

/** 右栏正开着的那一条在这一份行里的键（列不出来时 null）。 */
export function findSelectedKey(
  rows: IndexRow[],
  selected: { deviceId: number; sessionId: number } | null,
): string | null {
  if (!selected) return null;
  return (
    rows.find(
      (r) =>
        r.deviceId === selected.deviceId && r.sessionId === selected.sessionId,
    )?.key ?? null
  );
}
