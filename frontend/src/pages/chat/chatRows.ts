import { type SessionSummary } from "@agentre-hub/agentre-wire";

import type { DeviceItem } from "@/lib/devices";
import type { IndexRow } from "@/lib/sessionAxes";
import { groupKeyOfScope } from "@/lib/sessionScope";
import {
  matchesRowSearch,
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
  const device = devicesByFp.get(s.peer_fingerprint);
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

/** 选中的那台机器上报的一条（还没进账号的那些）→ 索引的一行。 */
export function toMachineRow(
  device: DeviceItem,
  s: SessionSummary,
  t: Translate,
): IndexRow {
  const origin = s.peerFingerprint?.trim() || device.fingerprint;
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
  fromMachineRow: (device: DeviceItem, s: SessionSummary) => IndexRow;
  search: string;
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
      const origin = s.peerFingerprint?.trim() || device.fingerprint;
      const mirroredRow = savedByKey.get(rowKey(origin, s.sessionId));
      // 账号里已经有的那条：标出来，并把只有服务端判得出的项目归属带上（决策 12）。
      const row = mirroredRow
        ? { ...input.fromMirrorRow(mirroredRow), deviceId: device.id }
        : input.fromMachineRow(device, s);
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
    // 机器上报的那一份没有经过服务端的搜索与筛选（这一档本轮不向机器翻页，
    // 决策 12），就地按同一条口径过滤：搜索只按标题，chips 的判据与服务端
    // 逐字一致——两处不一样的话，同一个 chip 在这一档筛出的就是另一批。
    if (input.search) {
      rows = rows.filter((r) => matchesRowSearch([r.title], input.search));
    }
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
