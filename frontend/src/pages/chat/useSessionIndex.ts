import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAccountChannel } from "@/hooks/use-account-channel";
import { useAliveEffect } from "@/hooks/use-api-query";
import { useTargetGuard } from "@/hooks/use-target-guard";
import { AccountChannelMirrorChanged } from "@/lib/accountChannel";
import { attentionReasonOf } from "@/lib/attentionAdapter";
import { api } from "@/lib/api";
import type { DeviceItem } from "@/lib/devices";
import type { IndexAxis } from "@/lib/sessionAxes";
import type { SessionFilter } from "@/lib/sessionView";
import {
  mergeMirrorRows,
  rowKey,
  type IndexGroupPayload,
  type IndexResponse,
  type MirroredSession,
  type MirrorIndexRow,
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
  onDeleted: (row: MirrorIndexRow) => void;
}

/**
 * 一条对话没能存进账号这件事，连同把它重做一遍的那条路。
 *
 * 两条来路合流到同一格：行尾按下的「保存」（kind: "manual"），以及从这一端派发
 * 新对话时的发起即保存（kind: "onStart"，R16）。两者的**后果**是同一个——账号里
 * 没有它，于是左栏列不出它——所以只该有一处说明和一颗重试，而不是两套。
 *
 * 两者说的话仍要分开：手动保存那条路，用户知道自己刚点了什么；发起即保存那条路，
 * 用户看到的是右栏正开着一条对话、左栏却一行都没有，得先告诉他会话**真的**跑起来了。
 *
 * 它只带**数据**，不带那颗重试的闭包：重试是 `retrySave`，由这只 hook 自己按
 * `kind` 分派。装一个闭包进来的话，造它的地方（doSave 的 catch）就得反过来引用
 * doSave 自己，那是个自引用的环。
 */
export type SaveFailure = {
  conversationId: string;
  /** 说给用户听的那个名字。 */
  title: string;
} & (
  | {
      kind: "manual";
      /** 行尾那条路：重做就是拿这一行再走一遍 doSave。 */
      row: MirrorIndexRow;
    }
  | {
      kind: "onStart";
      /** 发起即保存那条路：没有行可拿，重做就是原样再发一遍这份载荷。 */
      machineFingerprint: string;
      peerFingerprint: string;
    }
);

/** 「对话」页与索引数据层之间的全部契约。 */
export interface SessionIndexData {
  /** 服务端按当前轴给的组骨架（不带 scope 那一次的应答）。 */
  indexGroups: IndexGroupPayload[];
  /** 这一轮范围下的全部镜像行（骨架 + 追加页 + 乐观增删）。 */
  mirrorRows: MirroredSession[];
  /** 账号里一共保存过几条（不带任何搜索与筛选）；还没问出来时 null。 */
  accountTotal: number | null;
  /** 「未读」chip 上那个数。 */
  unreadTotal: number;
  /** 这一次取数成功过没有。 */
  loaded: boolean;
  /** 这一次取数的错。设备名单那一路取数失败也落在同一条横幅上，因此可写。 */
  loadError: unknown;
  setLoadError: (err: unknown) => void;
  /** 范围没变、但账号里的会话集合变了：重跑取数那一遍。 */
  refetch: () => void;
  /**
   * 打开一条对话之后把它就地标成已读（时刻由服务端在 /read 的应答里给）。
   * 不重取：改的只是那一行上的一列，见实现处。
   */
  markRead: (conversationId: string, lastReadAt: number) => void;
  /**
   * 按身份取回**原始**的那一行（线上载荷形状）。点一行进右栏时把它整个递给详情，
   * 详情因此不必回头再向服务端认领一次。
   *
   * 交回原始行而不是投影后的 IndexRow：详情的替补摘要要用到 provider_key /
   * model_key，机器离线时模型那一格全靠它们，投影里没有这两列。
   *
   * 与 markRead 一样**引用恒定**（行走 ref）：它会进 onSelect 的依赖，而 onSelect
   * 造出来的行又喂给整片列表。
   */
  mirrorRowOf: (conversationId: string) => MirroredSession | undefined;

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

  /**
   * 上一次保存没写成的那一条（两条来路合流，见 SaveFailure）。null = 没有。
   * 下一次写成、或者用户把它关掉时清空。
   */
  saveFailure: SaveFailure | null;
  dismissSaveFailure: () => void;
  /** 把上一次没写成的那次保存重做一遍（两条来路各按自己的方式重做）。 */
  retrySave: () => void;
  /**
   * 从这一端派发出去的新对话没能存进账号（dispatch 的 savedToAccount 为假）。
   *
   * 由页面报进来而不是由这只 hook 自己发现：那一次写是派发流程的收尾，发生在
   * `dispatchNewConversation` 里，索引这一层看不见它。
   */
  reportUnsavedOnStart: (session: {
    conversationId: string;
    title: string;
    machineFingerprint: string;
    peerFingerprint: string;
  }) => void;

  /** 行尾「保存」。第一次保存要先把说明弹层摆出来，因此不是直接写。 */
  onSave: (row: MirrorIndexRow) => void;
  /** 第一次保存的说明弹层挡着的那一条。 */
  pendingSave: MirrorIndexRow | null;
  cancelSave: () => void;
  confirmSave: () => void;

  /** 删除确认挡着的那一条。 */
  pendingDelete: MirrorIndexRow | null;
  askDelete: (row: MirrorIndexRow) => void;
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
  /** 「未读」chip 上那个数，同样是服务端在完整集合上数出来的。 */
  const [unreadTotal, setUnreadTotal] = useState(0);
  /** 平铺那一档的翻页位置。null = 没有下一页。 */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 取下一页失败：已列出的行留在原地，就地给一条可重试的提示（决策 16）。 */
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  /** 上一次保存没写成的那一条（两条来路合流，见 SaveFailure）。 */
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  /**
   * 保存 / 删除的乐观覆盖层。行本身来自服务端的组骨架，因此这两个动作不能直接改
   * 那份数据——它下一次取数就会被覆盖。覆盖层活到下一次取数为止，行尾那个动作
   * 因此立刻有反馈，又不会跟服务端各说各话。
   */
  const [optimisticSaved, setOptimisticSaved] = useState<MirroredSession[]>([]);
  const [optimisticRemoved, setOptimisticRemoved] = useState<string[]>([]);
  /**
   * 「刚打开过」的那几条各自的已读时刻。与上面两层同寿，下一次取数清空。
   *
   * 与另外两层不同的是它**不改集合**，只改行上的一列：打开一条对话既不会把它加进
   * 账号也不会拿走，只是这一行从此不算未读。
   */
  const [optimisticRead, setOptimisticRead] = useState<Map<string, number>>(
    () => new Map(),
  );
  /**
   * 账号里一共保存过几条（不带任何搜索与筛选）。第一次保存的说明弹层认的是
   * 「一条都还没保存过」，那件事不能拿收窄过的计数去判——搜不到不等于没有。
   */
  const [accountTotal, setAccountTotal] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  /** 第一次保存的说明弹层挡着的那一条（确认之后才真的写）。 */
  const [pendingSave, setPendingSave] = useState<MirrorIndexRow | null>(null);
  /** 删除确认挡着的那一条。 */
  const [pendingDelete, setPendingDelete] = useState<MirrorIndexRow | null>(
    null,
  );
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

  /**
   * 上一遍取数**落地时**的范围。
   *
   * 这只 effect 有两种来路，它们要的位置行为相反：
   *
   *   - 换范围（轴 / 搜索 / 筛选）：问的是另一批了，位置回到起点；
   *   - 就地重取（`indexNonce`：镜像变更的信号、本端派发）：说的只是「这一份变了，
   *     该拉了」，位置一步都不该动。
   *
   * 而那条信号在一轮对话跑起来之后是**每秒一条**（服务端按账号攒批，见
   * mirror_svc/notify.go）。不分开的话，agent 一开口，用户往下翻出来的页每秒被扔
   * 一次、位置跟着弹回顶上 —— 正是「等回复的时候界面自己在重搭」。
   */
  const appliedRangeRef = useRef<string | null>(null);
  const rangeKey = `${axis}|${debouncedSearch}|${filter}`;
  /**
   * 在这一范围里往下翻过没有。只有翻过的才需要护住游标 —— 没翻过时「还有没有
   * 下一页」本来就该以这一遍第一页的说法为准，护着一个旧游标只会留下一颗翻出
   * 空页的「加载更多」。
   */
  const pagedRef = useRef(false);
  /**
   * 在途翻页的范围守卫。
   *
   * 取数那一遍由 `useAliveEffect` 的 `alive()` 管着（换范围就是换依赖，那一轮当场
   * 作废），而「加载更多」是用户点出来的，没有清理函数可挂：点完再点一颗筛选
   * chip，过期的那一页会追加到新范围的列表下面，`nextCursor` 从此翻的也是错的
   * 那一批。
   */
  const guardRange = useTargetGuard(rangeKey);

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
          const rangeChanged = appliedRangeRef.current !== rangeKey;
          appliedRangeRef.current = rangeKey;
          if (rangeChanged) {
            // 换范围：翻页那一套整份作废，位置回到起点。
            setAppended([]);
            pagedRef.current = false;
          } else {
            // 就地重取：翻出来的页留在原地，只把这一遍也报了的那几条交还给它 ——
            // 这一遍比翻页那次新，同一条对话不该由旧的那份说了算（合并按 key 去重，
            // 见 mergeMirrorRows）。
            const fresh = new Set(
              groups.flatMap((g) =>
                (g.items ?? []).map((item) => rowKey(item.conversation_id)),
              ),
            );
            setAppended((prev) =>
              prev.filter((row) => !fresh.has(rowKey(row.conversation_id))),
            );
          }
          if (!debouncedSearch && filter === "all")
            setAccountTotal(page.total ?? 0);
          setOptimisticSaved([]);
          setOptimisticRemoved([]);
          setOptimisticRead(new Map());
          setUnreadTotal(unread.total ?? 0);
          // 平铺那一档（时间轴只有一个组）才有「接着往下翻」这回事。
          const flat =
            groups.length === 1 && groups[0].scope === "time"
              ? groups[0]
              : null;
          // 游标同理：翻过页之后它指的是「已经翻到哪儿了」，而这一遍报的是第一页
          // 的末尾 —— 拿它盖上去等于把接着往下翻这件事也退回起点。
          if (rangeChanged || !pagedRef.current) {
            setNextCursor(flat?.has_more ? (flat.cursor ?? null) : null);
          }
          setLoadMoreFailed(false);
          setLoaded(true);
          // 这一遍成功了，上一次失败留下的那条红横幅就该收起来。不清的话，一次
          // 网络抖动之后它会挂在一份**正确**的列表上方直到整页刷新
          // （设备页的 applyList 早就是这么写的）。
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (alive()) setLoadError(e);
        });
    },
    [rangeParams, debouncedSearch, filter, axis, indexNonce, rangeKey],
  );

  /**
   * 取下一页。失败时**不动**已经列出来的行，只把失败说出来——把它们清掉等于用一次
   * 网络抖动抹掉用户正在看的东西，静默停住则会被读成「到底了」。
   */
  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    // 这一页是**当前这个范围**的下一页。范围变了它就整页作废：追加上去等于把上一
    // 个筛选的行摆进新列表，而那个游标接着往下翻的也仍是旧范围。
    const sameRange = guardRange();
    setLoadingMore(true);
    setLoadMoreFailed(false);
    api<IndexResponse>(
      `/v1/agent-sessions?${rangeParams({ scope: "time", cursor: nextCursor }).toString()}`,
    )
      .then((page) => {
        if (!sameRange()) return;
        setAppended((prev) => [...prev, ...(page.items ?? [])]);
        setNextCursor(page.has_more ? (page.cursor ?? null) : null);
        pagedRef.current = true;
      })
      .catch(() => sameRange() && setLoadMoreFailed(true))
      // 「在飞」这一格**不**守：它是这只 hook 唯一的一份，而 loadMore 自己按它上
      // 闩。守住的话换范围之后没人再放它下来，那颗「加载更多」就此按不动了。
      .finally(() => setLoadingMore(false));
  }, [nextCursor, loadingMore, rangeParams, guardRange]);

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
        optimisticRead,
      }),
    [indexGroups, appended, optimisticSaved, optimisticRemoved, optimisticRead],
  );
  /**
   * 当前这批行的一份 ref。markRead 要回答「这一条本来算不算未读」，答案就在这批行
   * 里，但它**不能**因此把 mirrorRows 钉进依赖数组——那个回调会一路传到
   * SessionDetailView，落进它那条「session.list + attach + 补齐」effect 的依赖里。
   * 行一变它就换一次引用，正开着的那条对话于是每次索引重取都重跑一遍 attach 与补齐：
   * 本轮是来省请求的，那样反而给它添了往返。
   *
   * 所以行走 ref，回调本身恒定（依赖数组是空的）。它只在事件回调里被调用，那时提交
   * 早已结束，ref 里就是最新的一批。
   */
  const mirrorRowsRef = useRef<MirroredSession[]>([]);
  useEffect(() => {
    mirrorRowsRef.current = mirrorRows;
  });

  /** 按身份取回原始那一行。见 SessionIndexData.mirrorRowOf。 */
  const mirrorRowOf = useCallback((conversationId: string) => {
    return mirrorRowsRef.current.find(
      (r) => r.conversation_id === conversationId,
    );
  }, []);

  /**
   * 「打开即已读」落到索引这一侧：把那一行的已读时刻就地盖上，未读徽标跟着搬一格。
   *
   * 这条路此前是 refetch()——重取一遍整页索引外加一次完整集合上的未读数探测，两条
   * 请求，而**每次点进一条对话**都会走一遍。服务端已经把新的已读时刻回给了客户端
   * （MarkSessionReadResponse.last_read_at「供客户端就地覆盖那一行」），够改这一行了。
   *
   * 徽标只在这一条**本来算未读**时才减：重复标记同一条不会连着减两次（第一次盖上
   * 之后它就不算未读了）。行不在这一轮列出来的范围里时不动徽标——那时判不出它算不算
   * 未读，宁可让它多留一格到下一次取数，也不去猜一个会往下错的数。
   */
  const markRead = useCallback((conversationId: string, lastReadAt: number) => {
    if (!conversationId || lastReadAt <= 0) return;
    const key = rowKey(conversationId);
    const row = mirrorRowsRef.current.find(
      (r) => r.conversation_id === conversationId,
    );
    // 「本来算不算未读」不在这里判：判据是共享包 computeAttention 那一档，服务端
    // 数这个徽标时用的也是它（attentionExpr）。此前这里自写了一遍两列相比，于是
    // 打开一条**在跑的**对话会把徽标减一——而它压根就没被数进去。
    const wasUnread =
      row !== undefined &&
      attentionReasonOf({
        lifecycleState: row.lifecycle_state ?? "",
        waitingForInput: row.waiting_for_input,
        updatedAt: row.last_message_at ?? 0,
        lastReadAt: row.last_read_at ?? 0,
      }) === "unread";
    setOptimisticRead((prev) => {
      const next = new Map(prev);
      next.set(key, Math.max(prev.get(key) ?? 0, lastReadAt));
      return next;
    });
    if (wasUnread) setUnreadTotal((n) => Math.max(0, n - 1));
  }, []);

  /**
   * 保存 / 删除之后把那几个计数跟着搬一格。
   *
   * 行来自服务端的组骨架、由乐观覆盖层就地增删，而计数是服务端在**完整集合**上另外
   * 数出来的一份东西：两者不一起动的话，那几个数会跟列出来的行各说各的，而
   * 「账号里一条都还没保存过」在第一条存进去之后仍然成立——第一次保存的说明因此每
   * 保存一条就再来一遍，删光了主空态也回不来。下一次取数会用服务端的真数把这里的
   * 推算整份盖掉。
   */
  const shiftTotals = useCallback((row: MirrorIndexRow, delta: number) => {
    // 不越过 0：推算只在两次取数之间生效，负数在界面上没有意义。
    const bump = (n: number) => Math.max(0, n + delta);
    setAccountTotal((prev) => (prev === null ? prev : bump(prev)));
    // 「未读」那个徽标数的是同一批对话里没读过、且没有更强理由的那些。判据同样走
    // attentionReasonOf——刚保存进来的那条未必进得了这个徽标（它可能正在跑），而
    // 删掉的那条只在它本来就被数进去时才跟着下来。
    //
    // `saved: true` 是**故意**盖上的：这两个动作的两端各在账号里的一侧（保存后进、
    // 删除前在），而机器轴上那些还没保存的行带的是 saved=false，照原样问会一律得到
    // null，保存进来的第一条永远不进徽标。
    if (attentionReasonOf({ ...row, saved: true }) === "unread") {
      setUnreadTotal(bump);
    }
  }, []);

  /**
   * 把一条对话保存进账号（决策 5）：镜像随即对它开始。本地乐观更新，失败即回滚
   * ——行尾那个动作不能说谎。
   */
  const doSave = useCallback(
    async (row: MirrorIndexRow) => {
      const entry: MirroredSession = {
        conversation_id: row.conversationId,
        peer_fingerprint: row.fingerprint,
        device_fingerprint:
          devices.find((d) => d.id === row.deviceId)?.fingerprint ??
          row.fingerprint,
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
            device_fingerprint:
              devices.find((d) => d.id === row.deviceId)?.fingerprint ??
              row.fingerprint,
            // 行的身份指纹就是发起端（IndexRow.fingerprint 的定义）。
            peer_fingerprint: row.fingerprint,
            conversation_id: row.conversationId,
          }),
        });
        // 这一次写成了：上一次失败留下的那条横幅就该收起来，否则它会挂在一份
        // **已经正确**的列表上方（与取数那一路的 setLoadError(null) 同一条规矩）。
        setSaveFailure((prev) =>
          prev?.conversationId === row.conversationId ? null : prev,
        );
      } catch {
        setOptimisticSaved((prev) =>
          prev.filter((s) => s.conversation_id !== row.conversationId),
        );
        shiftTotals(row, -1);
        // 回滚是对的（账号里确实没有它），但只回滚就成了一次无声的失败：行闪一下
        // 消失，与「我大概没点中」长得一模一样。说出来，并把重试挂在同一条写上 ——
        // 让用户回去重新找到那一行再点一次是纯粹的额外劳动。
        setSaveFailure({
          conversationId: row.conversationId,
          title: row.title,
          kind: "manual",
          row,
        });
      }
    },
    [devices, shiftTotals],
  );

  const dismissSaveFailure = useCallback(() => setSaveFailure(null), []);

  /**
   * 发起即保存那一路没写成（R16）：只记下事实，重做交给 retrySave。
   */
  const reportUnsavedOnStart = useCallback(
    (session: {
      conversationId: string;
      title: string;
      machineFingerprint: string;
      peerFingerprint: string;
    }) => setSaveFailure({ ...session, kind: "onStart" }),
    [],
  );

  /**
   * 把上一次没写成的那一次保存重做一遍。
   *
   * 两条来路在这里才分岔，因为它们的**重做**不一样：手动保存那条有行，照原路再走
   * 一遍 doSave（乐观行、计数、成功后收横幅全都跟着走）；发起即保存那条没有行可拿
   * ——这条对话从来没进过任何一份列表——所以直接发那份载荷，写成之后 refetch 让它
   * 作为一条真行落进左栏，而不是只把横幅收掉、留下一份仍然看不见它的列表。
   */
  const retrySave = useCallback(() => {
    if (!saveFailure) return;
    if (saveFailure.kind === "manual") {
      void doSave(saveFailure.row);
      return;
    }
    void (async () => {
      try {
        await api("/v1/saved-sessions", {
          method: "POST",
          body: JSON.stringify({
            device_fingerprint: saveFailure.machineFingerprint,
            peer_fingerprint: saveFailure.peerFingerprint,
            conversation_id: saveFailure.conversationId,
          }),
        });
        setSaveFailure(null);
        setIndexNonce((n) => n + 1);
      } catch {
        // 还是没写成：横幅留在原地，那颗重试照常按得动。
      }
    })();
  }, [saveFailure, doSave]);

  const onSave = useCallback(
    (row: MirrorIndexRow) => {
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

  const askDelete = useCallback(
    (row: MirrorIndexRow) => setPendingDelete(row),
    [],
  );
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
        body: JSON.stringify({ conversation_id: row.conversationId }),
      });
      setOptimisticRemoved((prev) => [...prev, rowKey(row.conversationId)]);
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
    markRead,
    mirrorRowOf,

    searchQuery,
    setSearchQuery,
    debouncedSearch,

    hasMore: !!nextCursor,
    loadingMore,
    loadMoreFailed,
    loadMore,
    fetchGroupPage,

    saveFailure,
    dismissSaveFailure,
    retrySave,
    reportUnsavedOnStart,

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
