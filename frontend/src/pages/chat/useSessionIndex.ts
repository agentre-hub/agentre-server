import { useCallback, useEffect, useMemo, useState } from "react";

import { useAccountChannel } from "@/hooks/use-account-channel";
import { useAliveEffect } from "@/hooks/use-api-query";
import { AccountChannelMirrorChanged } from "@/lib/accountChannel";
import { api } from "@/lib/api";
import type { DeviceItem } from "@/lib/devices";
import type { IndexAxis, IndexRow } from "@/lib/sessionAxes";
import type { SessionFilter } from "@/lib/sessionView";
import {
  mergeMirrorRows,
  rowKey,
  type IndexGroupPayload,
  type IndexResponse,
  type MirroredSession,
} from "@/pages/chat/chatRows";

/**
 * 机器轴上向镜像要的每组条数（服务端上限，超了它自己夹住）。
 *
 * 这一档的镜像行**不渲染**，只用来回答「这条在账号里有没有」与补项目归属
 * （规格 2026-08-21 决策 8）。默认那 5 条不够回答它：一台机器上保存过的第 6 条起
 * 会被标成「还没保存」、行尾多出一颗「保存」。按上限要过来，代价只是这一档的
 * 响应体大一点——它本来就不上屏。
 */
const MIRROR_MAX_PER_GROUP = "50";

/** 索引数据层要向页面借的东西。 */
export interface SessionIndexInput {
  /** 当前轴：范围的一部分，一变位置就回到起点。 */
  axis: IndexAxis;
  /** 设备名单：保存一条时要按设备标识回查它的指纹。 */
  devices: DeviceItem[];
  /** 筛选 chip：同样是范围的一部分。它归索引外壳管，因此是借的。 */
  filter: SessionFilter;
  /** 删掉一条之后：右栏正开着它的话要收起来——那是右栏的事，不是索引的事。 */
  onDeleted: (row: IndexRow) => void;
}

/** 「对话」页与索引数据层之间的全部契约。 */
export interface SessionIndexData {
  /** 服务端按当前轴给的组骨架（不带 scope 那一次的应答）。 */
  indexGroups: IndexGroupPayload[];
  /** 这一轮范围下的全部镜像行（骨架 + 追加页 + 乐观增删）。 */
  mirrorRows: MirroredSession[];
  /** 账号里一共保存过几条（不带任何搜索与筛选）；还没问出来时 null。 */
  accountTotal: number | null;
  /** 「等你处理」chip 上那个数。 */
  unreadTotal: number;
  /** 这一次取数成功过没有。 */
  loaded: boolean;
  /** 这一次取数的错。设备名单那一路取数失败也落在同一条横幅上，因此可写。 */
  loadError: unknown;
  setLoadError: (err: unknown) => void;
  /** 范围没变、但账号里的会话集合变了：重跑取数那一遍。 */
  refetch: () => void;

  /** 搜索框里的原文，与它防抖之后真正拿去问服务端的那一份。 */
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  debouncedSearch: string;

  /** 平铺那一档还有没有下一页，以及翻它的那一路。 */
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  loadMore: () => void;
  /** 翻某一组的下一页（服务端那一半；机器那一档整份在页面手里）。 */
  fetchGroupPage: (
    scope: string,
    cursor: string | null,
  ) => Promise<{
    items: MirroredSession[];
    cursor: string | null;
    hasMore: boolean;
  }>;

  /** 行尾「保存」。第一次保存要先把说明弹层摆出来，因此不是直接写。 */
  onSave: (row: IndexRow) => void;
  /** 第一次保存的说明弹层挡着的那一条。 */
  pendingSave: IndexRow | null;
  cancelSave: () => void;
  confirmSave: () => void;

  /** 删除确认挡着的那一条。 */
  pendingDelete: IndexRow | null;
  askDelete: (row: IndexRow) => void;
  cancelDelete: () => void;
  deleting: boolean;
  confirmDelete: () => Promise<void>;
}

/**
 * 索引的数据层：取数、分页、计数，以及保存 / 删除那两个乐观动作。
 *
 * 四件事合成一个 hook 是**故意**的，它们共用同一批状态：保存 / 删除要把服务端在完整
 * 集合上数出来的那几个计数跟着搬一格，而下一次取数又会用真数把推算整份盖掉、顺手清空
 * 乐观覆盖层。拆成两个的话，两边就得互相递 setter。
 */
export function useSessionIndex({
  axis,
  devices,
  filter,
  onDeleted,
}: SessionIndexInput): SessionIndexData {
  /** 服务端按当前轴给的组骨架（不带 scope 那一次的应答）。 */
  const [indexGroups, setIndexGroups] = useState<IndexGroupPayload[]>([]);
  /**
   * 索引重取的计数器。范围（轴 / 搜索 / 筛选）没变、但账号里的会话集合变了时，
   * 加一下让取数那一遍重跑——现在只有「新对话派发成功」这一处用得上它。
   */
  const [indexNonce, setIndexNonce] = useState(0);
  /** 时间轴上「加载更多」追加进来的页。分组轴的溢出走各组自己的入口（任务 4）。 */
  const [appended, setAppended] = useState<MirroredSession[]>([]);
  /** 「等你处理」chip 上那个数，同样是服务端在完整集合上数出来的。 */
  const [unreadTotal, setUnreadTotal] = useState(0);
  /** 平铺那一档的翻页位置。null = 没有下一页。 */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 取下一页失败：已列出的行留在原地，就地给一条可重试的提示（决策 16）。 */
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  /**
   * 保存 / 删除的乐观覆盖层。行本身来自服务端的组骨架，因此这两个动作不能直接改
   * 那份数据——它下一次取数就会被覆盖。覆盖层活到下一次取数为止，行尾那个动作
   * 因此立刻有反馈，又不会跟服务端各说各话。
   */
  const [optimisticSaved, setOptimisticSaved] = useState<MirroredSession[]>([]);
  const [optimisticRemoved, setOptimisticRemoved] = useState<string[]>([]);
  /**
   * 账号里一共保存过几条（不带任何搜索与筛选）。第一次保存的说明弹层认的是
   * 「一条都还没保存过」，那件事不能拿收窄过的计数去判——搜不到不等于没有。
   */
  const [accountTotal, setAccountTotal] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  /** 第一次保存的说明弹层挡着的那一条（确认之后才真的写）。 */
  const [pendingSave, setPendingSave] = useState<IndexRow | null>(null);
  /** 删除确认挡着的那一条。 */
  const [pendingDelete, setPendingDelete] = useState<IndexRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 搜索词：真实过滤索引里的行，不是假交互。
  const [searchQuery, setSearchQuery] = useState("");

  const refetch = useCallback(() => setIndexNonce((n) => n + 1), []);

  // 这一页是最容易撞见「没实时同步」的地方：索引此前只在范围（轴 / 搜索 / 筛选）
  // 变化或本端派发之后才重取，别的端跑出来的新消息一律要刷新整页才看得到。
  //
  // 三份数据各订各的那一类。重取走 indexNonce 而不是另开一条取数路径：范围、分页
  // 游标、乐观增删那一整套状态都挂在那一个 effect 上（见下面 rangeParams 那一带），
  // 绕开它重取会把它们各复制一份。
  useAccountChannel([AccountChannelMirrorChanged], () => {
    setIndexNonce((n) => n + 1);
  });

  /**
   * 搜索词打字时不逐个字符去问服务端：**范围一变位置就得回到起点**，每敲一下都
   * 重来一次既吵又慢。停下来再发。
   */
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  /** 一次索引读取的范围：轴 + 搜索词 + 筛选。它一变，位置就回到起点。 */
  const rangeParams = useCallback(
    (extra?: Record<string, string>) => {
      const params = new URLSearchParams({ axis });
      if (axis === "machine") params.set("per_group", MIRROR_MAX_PER_GROUP);
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (filter !== "all") params.set("filter", filter);
      for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
      return params;
    },
    [axis, debouncedSearch, filter],
  );

  useAliveEffect(
    (alive) => {
      // 「未读」那个数要的是完整集合上的真数，因此单独问一次：它跟当前选中哪个
      // chip 无关，本地在已加载的行里数只会随滚动往上爬。
      const unreadParams = new URLSearchParams({
        axis: "time",
        filter: "unread",
        per_group: "1",
      });
      if (debouncedSearch) unreadParams.set("q", debouncedSearch);
      Promise.all([
        api<IndexResponse>(`/v1/agent-sessions?${rangeParams().toString()}`),
        api<IndexResponse>(`/v1/agent-sessions?${unreadParams.toString()}`),
      ])
        .then(([page, unread]) => {
          if (!alive()) return;
          const groups = page.groups ?? [];
          setIndexGroups(groups);
          setAppended([]);
          if (!debouncedSearch && filter === "all")
            setAccountTotal(page.total ?? 0);
          setOptimisticSaved([]);
          setOptimisticRemoved([]);
          setUnreadTotal(unread.total ?? 0);
          // 平铺那一档（时间轴只有一个组）才有「接着往下翻」这回事。
          const flat =
            groups.length === 1 && groups[0].scope === "time"
              ? groups[0]
              : null;
          setNextCursor(flat?.has_more ? (flat.cursor ?? null) : null);
          setLoadMoreFailed(false);
          setLoaded(true);
        })
        .catch((e: unknown) => {
          if (alive()) setLoadError(e);
        });
    },
    [rangeParams, debouncedSearch, filter, axis, indexNonce],
  );

  /**
   * 取下一页。失败时**不动**已经列出来的行，只把失败说出来——把它们清掉等于用一次
   * 网络抖动抹掉用户正在看的东西，静默停住则会被读成「到底了」。
   */
  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    api<IndexResponse>(
      `/v1/agent-sessions?${rangeParams({ scope: "time", cursor: nextCursor }).toString()}`,
    )
      .then((page) => {
        setAppended((prev) => [...prev, ...(page.items ?? [])]);
        setNextCursor(page.has_more ? (page.cursor ?? null) : null);
      })
      .catch(() => setLoadMoreFailed(true))
      .finally(() => setLoadingMore(false));
  }, [nextCursor, loadingMore, rangeParams]);

  /**
   * 翻某一组的下一页（「查看全部 N」那条路）。范围参数一并带上——弹层里翻的必须
   * 还是同一个搜索与筛选下的那一组，否则数说的是一件事、翻出来的是另一件。
   */
  const fetchGroupPage = useCallback(
    async (scope: string, cursor: string | null) => {
      const params = rangeParams({ scope });
      if (cursor) params.set("cursor", cursor);
      const page = await api<IndexResponse>(
        `/v1/agent-sessions?${params.toString()}`,
      );
      return {
        items: page.items ?? [],
        cursor: page.cursor ?? null,
        hasMore: !!page.has_more,
      };
    },
    [rangeParams],
  );

  const mirrorRows = useMemo(
    () =>
      mergeMirrorRows({
        indexGroups,
        appended,
        optimisticSaved,
        optimisticRemoved,
      }),
    [indexGroups, appended, optimisticSaved, optimisticRemoved],
  );

  /**
   * 保存 / 删除之后把那几个计数跟着搬一格。
   *
   * 行来自服务端的组骨架、由乐观覆盖层就地增删，而计数是服务端在**完整集合**上另外
   * 数出来的一份东西：两者不一起动的话，那几个数会跟列出来的行各说各的，而
   * 「账号里一条都还没保存过」在第一条存进去之后仍然成立——第一次保存的说明因此每
   * 保存一条就再来一遍，删光了主空态也回不来。下一次取数会用服务端的真数把这里的
   * 推算整份盖掉。
   */
  const shiftTotals = useCallback((row: IndexRow, delta: number) => {
    // 不越过 0：推算只在两次取数之间生效，负数在界面上没有意义。
    const bump = (n: number) => Math.max(0, n + delta);
    setAccountTotal((prev) => (prev === null ? prev : bump(prev)));
    // 「未读」那个徽标数的是同一批对话里没读过的那些。刚保存进来的必然没读过；
    // 删掉的那条如果本来算未读，也要跟着下来。
    if (delta > 0 || (row.updatedAt ?? 0) > 0) setUnreadTotal(bump);
  }, []);

  /**
   * 把一条对话保存进账号（决策 5）：镜像随即对它开始。本地乐观更新，失败即回滚
   * ——行尾那个动作不能说谎。
   */
  const doSave = useCallback(
    async (row: IndexRow) => {
      const entry: MirroredSession = {
        peer_fingerprint: row.fingerprint,
        session_id: String(row.sessionId),
        title: row.title,
        agent_sync_id: row.agentSyncId || undefined,
        project_sync_id: row.projectSyncId || undefined,
        lifecycle_state: row.lifecycleState,
        waiting_for_input: row.waitingForInput,
        last_message_at: row.updatedAt,
      };
      setOptimisticSaved((prev) => [...prev, entry]);
      shiftTotals(row, 1);
      try {
        await api("/v1/saved-sessions", {
          method: "POST",
          body: JSON.stringify({
            // 「保存」只出现在机器轴上那些账号里还没有的行，它们恒挂着那台机器
            // （fromMachineRow 的 deviceId）。取不到时退回行的身份指纹 —— 对在本机
            // 开的对话两者本来就同值。
            machine_fingerprint:
              devices.find((d) => d.id === row.deviceId)?.fingerprint ??
              row.fingerprint,
            // 行的身份指纹就是发起端（IndexRow.fingerprint 的定义）。
            peer_fingerprint: row.fingerprint,
            session_id: String(row.sessionId),
          }),
        });
      } catch {
        setOptimisticSaved((prev) =>
          prev.filter(
            (s) =>
              !(
                s.peer_fingerprint === row.fingerprint &&
                s.session_id === String(row.sessionId)
              ),
          ),
        );
        shiftTotals(row, -1);
      }
    },
    [devices, shiftTotals],
  );

  const onSave = useCallback(
    (row: IndexRow) => {
      // 账号里一条都还没保存过 = 还没同意过：先把「内容会被存下来」说清楚。
      if (accountTotal === 0) {
        setPendingSave(row);
        return;
      }
      void doSave(row);
    },
    [accountTotal, doSave],
  );

  const cancelSave = useCallback(() => setPendingSave(null), []);
  const confirmSave = useCallback(() => {
    const row = pendingSave;
    setPendingSave(null);
    if (row) void doSave(row);
  }, [pendingSave, doSave]);

  const askDelete = useCallback((row: IndexRow) => setPendingDelete(row), []);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  /**
   * 删除（决策 6）：账号那份当场清掉，执行端那份由服务端负责（在线即删、离线记
   * 待办）。应答一到手这条对话在界面上就没了——不留「已删除但还在」的中间态。
   */
  const confirmDelete = useCallback(async () => {
    const row = pendingDelete;
    if (!row) return;
    setDeleting(true);
    try {
      await api("/v1/saved-sessions/delete", {
        method: "POST",
        body: JSON.stringify({
          peer_fingerprint: row.fingerprint,
          session_id: String(row.sessionId),
        }),
      });
      setOptimisticRemoved((prev) => [
        ...prev,
        rowKey(row.fingerprint, row.sessionId),
      ]);
      shiftTotals(row, -1);
      onDeleted(row);
      setPendingDelete(null);
    } catch {
      // 删除没成功：确认层留在原地、按钮重新可按，那条对话也还在列表里——
      // 界面不装作它没了。
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, shiftTotals, onDeleted]);

  return {
    indexGroups,
    mirrorRows,
    accountTotal,
    unreadTotal,
    loaded,
    loadError,
    setLoadError,
    refetch,

    searchQuery,
    setSearchQuery,
    debouncedSearch,

    hasMore: !!nextCursor,
    loadingMore,
    loadMoreFailed,
    loadMore,
    fetchGroupPage,

    onSave,
    pendingSave,
    cancelSave,
    confirmSave,

    pendingDelete,
    askDelete,
    cancelDelete,
    deleting,
    confirmDelete,
  };
}
