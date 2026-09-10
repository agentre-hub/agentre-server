import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import {
  computeBottomVisibleMessageId,
  nextAutoFollow,
} from "@agentre-hub/agentre-ui";
import { loadMirrorTail } from "@/components/session/sessionMirror";
import {
  toTranscriptFrame,
  type SessionEventFrame,
} from "@/components/session/transcriptFrame";
import { turnDoneFrames } from "@/components/session/turnDone";
import { applyJournalFrames, type RelayClient } from "@/lib/relayClient";

/**
 * 未保存的对话向中继补齐时，只补最后这么多**帧**。
 *
 * 这里只能用帧数：对端的 pull 只有 cursor + limit 两个入参，没有服务端那套按轮次与
 * 字节算的预算（协议在 sibling 的 agentre 仓）。而帧数是个很差的刻度——一帧可以是
 * 一个 token 的 delta，也可以是几百 KB 的工具结果。所以它只负责「别把整份 journal
 * 拉回来」，「够不够一屏」由下面那条顶补兜底。
 */
export const RELAY_TAIL_FRAMES = 400;

/** 自动顶补的次数上限，见 earlier.capped。 */
const TOPUP_CAP = 5;

/** 判「在底部」的容差：像素级的小数差不该让自动跟随失效。 */
const AT_BOTTOM_SLACK = 24;

/**
 * 一次用户输入之后，多久之内的滚动仍算他的手笔。
 *
 * 滚轮的惯性、拖住滚动条不放、一路按着方向键，都是一串滚动事件配零星几个输入事件；
 * 而每一次算数的滚动又会把这个窗口续上，所以只要够盖住两次事件之间的间隔即可。
 */
const USER_INTENT_MS = 400;

/**
 * 续读的触发点：距顶还有这么多屏时就去取下一页。
 *
 * 不放在顶部——在顶部才发请求的话，每次往上滚都要停下来等一次网络。
 */
const EARLIER_TRIGGER_VIEWPORTS = 2;

/**
 * 「更早的」那一半的进度。
 *
 * source 决定往回问谁：镜像交出过内容就接着问镜像（它从 0 起镜完整条对话，问到
 * 头就是对话的开头）；镜像里根本没有这一份（未保存的对话）时只能问中继。
 *
 * capped 是**顶补撞上封顶**：内容一直填不满视口（投影把渲染物削光了、或者几十轮
 * 都只剩一张折叠卡），补到上限就停手，改出一个能点的入口——滚动那条路在这种对话
 * 上不成立，不给按钮就等于把更早的内容锁在够不着的地方。
 */
export interface EarlierState {
  source: "mirror" | "relay" | "none";
  oldestSeq: number;
  hasBefore: boolean;
  loading: boolean;
  capped: boolean;
  /**
   * 上一次往回读失败了。
   *
   * 不记这一格的话，那行「正在读取更早的…」消失之后什么都不出现，而更早的内容明明
   * 还在——用户会把这一片空白读成对话的开头。索引侧对同一件事早就是这么处理的。
   */
  failed: boolean;
}

export interface TranscriptScrollbackParams {
  /** 已装载的目标会话：这三样一变，滚动位置与顶补计数都要重来。 */
  did: number;
  sid: string;
  originProp: string | undefined;
  /** 转录事件流。往回取那一页前插进它，钉底与顶补也按它的变化重新量。 */
  events: SessionEventFrame[];
  setEvents: Dispatch<SetStateAction<SessionEventFrame[]>>;
  /** 中继客户端。往回取时走它的 pullBefore（账号里没有这一份的那一路）。 */
  clientRef: RefObject<RelayClient | null>;
  /** 这条对话的发起端指纹，pullBefore 要原样带回。 */
  originRef: RefObject<string | undefined>;
  /** 首屏认出来的发起端指纹，往回问镜像时用它。 */
}

/** 详情视图从这一族拿到的东西。除此之外的滚动细节（pinRef / 前插补偿）不外泄。 */
export interface TranscriptScrollback {
  /** 挂到那条滚动带上。 */
  scrollRef: RefObject<HTMLDivElement | null>;
  /**
   * 挂到滚动带**里面**那一层内容上。跟随期间它一长高就跟着钉底 —— 行虚拟化的
   * 复测不经过本视图的提交，只有量它才知道。
   */
  contentRef: (node: HTMLDivElement | null) => void;
  /** 交给转录做行虚拟化的滚动容器（取值函数，稳定引用）。 */
  getScrollElement: () => HTMLDivElement | null;
  onScroll: () => void;
  /** 用户对这条滚动带动手了。滚轮 / 触摸 / 按键 / 摁下都接到它。 */
  noteUserScroll: () => void;
  /** 「回到底部」那枚药丸按下去做的事。 */
  jumpToBottom: () => void;
  /** 用户自己发了一条消息：重新跟住底部。 */
  pinToBottom: () => void;
  /** 此刻在不在底部。输入带的上边界与药丸的可见性都读它。 */
  atBottom: boolean;
  /** 视口下沿那条消息；贴底 / 量不出来时为 null。 */
  bottomVisibleId: number | null;
  /** 「更早的」那一半的进度，供转录上方那一带渲染。 */
  earlier: EarlierState;
  /** 目标会话换了。由详情视图的渲染期重置调用。 */
  reset: () => void;
  /** 镜像交出过首屏内容：往回接着问镜像。 */
  noteMirrorHistory: (oldestSeq: number, hasBefore: boolean) => void;
  /** 账号里没有这一份，首屏来自中继：往回只能问中继。 */
  noteRelayHistory: (oldestSeq: number, hasBefore: boolean) => void;
  /** 撞上顶补封顶之后那个能点的入口。 */
  retryEarlier: () => void;
}

/**
 * 转录的滚动、钉底、前插补偿与「更早的」续读。
 *
 * 这一族的状态彼此咬得很紧（钉底要读前插补偿留下的高度、顶补要读在飞标志），
 * 而详情视图只关心其中几样，所以整片归这里，对外只交出上面那份契约。
 */
export function useTranscriptScrollback({
  did,
  sid,
  originProp,
  events,
  setEvents,
  clientRef,
  originRef,
}: TranscriptScrollbackParams): TranscriptScrollback {
  const [earlier, setEarlier] = useState<EarlierState>({
    source: "none",
    oldestSeq: 0,
    hasBefore: false,
    loading: false,
    capped: false,
    failed: false,
  });

  // ── 滚动 ──────────────────────────────────────────────────────────────
  /** 转录那条滚动带。钉底、前插补偿、续读触发都量它。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * 交给转录做行虚拟化的滚动容器。
   *
   * 给的是**取值函数**而不是 state：把元素放进 state 会在挂载的 commit 里多打一次
   * 渲染，而这条路径正在切换右栏（草稿 → 真实会话），那一次额外渲染会把刚挂上的
   * 详情又掀掉（new-conversation 的「就地进入这条新会话」当场变红）。
   * 取值函数是稳定引用，SessionDetailView 一份状态都不用多。
   *
   * 虚拟器在 effect 里才调它，那时 ref 已经赋好；随后它自己的测量会触发重渲染，
   * 转录据此从「整列渲染」切到开窗（见 Transcript 的 windowed）。
   */
  const getScrollElement = useCallback(() => scrollRef.current, []);
  /**
   * 下一次布局要不要钉到底 —— 记的是**跟随意图**，不是「此刻在不在底部」。
   *
   * 初值 true = 首屏进去停在最后一条；此后只有用户主动上滚才解除，滚回底部再置回
   * （共享包的 nextAutoFollow，桌面端同一份）。位置式的判据在这里是错的：钉底写完
   * scrollTop 之后，那一次程序化滚动自己的 scroll 事件要等到帧末才送到，而行虚拟化
   * 早已在这中间把估算行高换成实测行高——事件送到时位置已经落后好几百像素，按位置
   * 判就成了「用户离开了底部」，跟随从此永久关掉（联调机上停在离底 717px）。
   */
  const pinRef = useRef(true);
  /**
   * 上一次观察到的 scrollTop。用来分辨「用户上滚（变小）」与「内容长高 / 程序化
   * 贴底（不变或变大）」——只有前者算离开的意图。
   *
   * 程序化的每一次写也要更新它：浏览器里那一次写会发出 scroll 事件、事件里就把它
   * 记上了，而 jsdom 不发；两边都写就都是同一条时间线。
   */
  const lastTopRef = useRef(0);
  /**
   * 用户的手到什么时候为止还算在场（见 USER_INTENT_MS）。
   *
   * 光看位置往回走是不够的：行虚拟化复测出视口上方那些行的真高之后，会调自己的
   * scrollToFn 把 scrollTop 往回补（联调机上实测 1065 → 879），好让人正在看的那一行
   * 不漂 —— 那一下和「用户上滚」在位置上完全同形。所以解除跟随要问的是「这一下是不是
   * 他动的手」，由滚轮 / 触摸 / 按键 / 摁下这几件事作证。
   */
  const userIntentUntilRef = useRef(0);
  /**
   * `pinRef` 的可渲染镜像。输入带的上边界要跟着「在不在底部」变（规格 2026-08-23
   * 决策 6），而 ref 改了不重渲染 —— 布局仍然只读 `pinRef`（同步、不掉帧），
   * 这一份只服务那条边界。
   */
  const [atBottom, setAtBottom] = useState(true);
  /**
   * 视口下沿那条消息。「下面还有 N 轮」从它之后数起；数不出（贴底 / 容器未布局 /
   * 转录里一条消息行都没有）时为 null，药丸退回「回到底部」，不猜数字。
   */
  const [bottomVisibleId, setBottomVisibleId] = useState<number | null>(null);
  /**
   * 前插之前的高度与位置。前插会把内容整体往下推，加了多少高度就往下挪多少，
   * 用户看的那一行才不动。两个数都要记：replaceChildren 之后 scrollTop 会被浏览器
   * 夹回去，只记高度的话补偿量对、起点却已经被挪走了。
   */
  const restoreRef = useRef<{ height: number; top: number } | null>(null);
  /** 已经为「填不满一屏」自动补了几次（见 earlier.capped）。 */
  const topupsRef = useRef(0);
  /** 往回取那一次在不在飞。见 loadEarlier 里为什么不能读 earlier.loading。 */
  const earlierInFlightRef = useRef(false);

  /**
   * 往回取一页，前插进转录。
   *
   * 两个来源二选一（earlier.source）：镜像从 0 起镜完整条对话，因此问到头就是对话
   * 的开头；账号里没有这一份时只能问中继，到头的判据是对端自己的留存下界。
   *
   * 失败时**不动** hasBefore：这一次没读到不等于没有更早的，下次还该能试。
   */
  const loadEarlier = useCallback(async () => {
    // 「有没有一次在飞」只能记在 ref 里，不能读 earlier.loading：那是**上一次渲染**
    // 的值。顶补是一串同步接力（effect → 取数 → setState → effect），拿旧值当门闩
    // 会让某一轮悄悄早退、又什么状态都不改 —— effect 再也不会重跑，整个顶补就此
    // 卡死在半路，界面既不补也不出按钮。
    if (earlierInFlightRef.current) return;
    if (!earlier.hasBefore || earlier.source === "none") return;
    earlierInFlightRef.current = true;
    const el = scrollRef.current;
    if (el) restoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setEarlier((p) => ({ ...p, loading: true, failed: false }));
    const append = (
      evs: SessionEventFrame[],
      oldest: number,
      hasBefore: boolean,
    ) => {
      setEvents((prev) => [...evs, ...prev]);
      setEarlier((p) => ({
        ...p,
        loading: false,
        failed: false,
        oldestSeq: oldest > 0 ? oldest : p.oldestSeq,
        hasBefore,
      }));
    };
    try {
      if (earlier.source === "mirror") {
        const page = await loadMirrorTail(sid, earlier.oldestSeq);
        append(page.events, page.oldestSeq, page.hasBefore);
        return;
      }
      const c = clientRef.current;
      if (!c) {
        setEarlier((p) => ({ ...p, loading: false, failed: true }));
        return;
      }
      const res = await c.pullBefore(
        sid,
        earlier.oldestSeq,
        RELAY_TAIL_FRAMES,
        originRef.current,
      );
      const evs: SessionEventFrame[] = [];
      // 与首屏同一条解帧路径。**不**走客户端的去重投递：那套 seq 闸门会把这一段
      // 判成跳号，反手从游标往后把整条日志再拉一遍。
      applyJournalFrames(res.frames, {
        onEvent: (f, at) => evs.push(toTranscriptFrame(f, at)),
        onRunResultDone: (frame, at) =>
          evs.push(...turnDoneFrames(sid, frame, at)),
      });
      append(evs, res.frames[0]?.seq ?? 0, res.hasBefore);
    } catch {
      setEarlier((p) => ({ ...p, loading: false, failed: true }));
      restoreRef.current = null;
    } finally {
      earlierInFlightRef.current = false;
    }
    // 后四样都是稳定引用（ref 对象与 useState 的 setter），列进依赖只为如实交代
    // 读了什么，不会让 loadEarlier 多换一次身份。
  }, [earlier, sid, setEvents, clientRef, originRef]);

  /**
   * 滚动那几个 ref 随目标一起重来。右栏换会话是同实例换 props，不清的话新的一条会
   * 沿用上一条的滚动位置、以及它的顶补计数。
   *
   * 放在 effect 里而不是上面那段渲染期重置里：渲染期写 ref 是被 react-hooks/refs
   * 明令禁止的。而**声明顺序**要紧——同一个组件里的 layout effect 按声明先后跑，
   * 它必须排在下面那条钉底之前，否则新会话首屏用的还是上一条留下的 pinRef。
   */
  useLayoutEffect(() => {
    pinRef.current = true;
    restoreRef.current = null;
    topupsRef.current = 0;
    earlierInFlightRef.current = false;
  }, [did, sid, originProp]);

  /**
   * 钉底：用户就在底部（含首屏）时，跟住内容的最后一行。顶补也走这一支——补完
   * 仍然停在最后一条。
   *
   * **每次提交都跑一遍**，不挂 `events`：转录长高的路不止「多了一条事件」这一条。
   * 排队与失败那两种气泡挂在转录之外（它们是用户自己写的字，不进 events），助手
   * 那三个点、审批卡、行虚拟化复测出来的真实行高也都不产生事件。只认 events 的话
   * 这些都会把内容顶到折叠线以下，而滚动位置停在原处 —— 看起来就是「发了没反应」。
   *
   * 代价是每次提交多读一次 scrollHeight（一次强制布局）。钉底本来就要读它，而
   * 没钉底时这个 effect 在那个 if 之前就返回了。
   *
   * 与下面那条前插补偿**互斥且优先**：钉底时把补偿的存根丢掉（人在底部，脚下那
   * 一行就是最后一行，没有「他看的那一行」要保）。声明在它前面，两条的先后就是
   * 这个优先级。
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinRef.current) return;
    restoreRef.current = null;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  });

  /**
   * 跟随期间盯住内容本身的高度。
   *
   * 上面那条只在**本视图提交**时才跑，而转录长高的路有一整条不经过它：行虚拟化先
   * 按估算行高占位、随后逐行复测，那次重渲染发生在 Transcript 里，本视图一次都不
   * 提交。首屏尤其明显——钉底钉的是估算高度的底，复测把内容又撑高几百像素，人就
   * 停在离底几百像素的地方（联调机上实测 911px，另一次却是 0：全看这一帧的时序）。
   * 图片、表格、字体这些异步长高的东西同样不产生提交。
   *
   * 所以改看高度：内容一变高就跟上去。回调在布局之后、绘制之前跑，写 scrollTop
   * 不会多闪一帧；写完不改变任何盒子的尺寸，不会把观察器自己转起来。
   */
  const contentObserverRef = useRef<ResizeObserver | null>(null);
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    contentObserverRef.current?.disconnect();
    contentObserverRef.current = null;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (!el || !pinRef.current) return;
      // 量不出视口就什么都不做：那是「不知道」，不是「内容为零」——此刻把
      // scrollTop 推到一个 0 高度的底，等它显示出来就停在顶上了。
      if (el.clientHeight === 0) return;
      el.scrollTop = el.scrollHeight;
      lastTopRef.current = el.scrollTop;
    });
    observer.observe(node);
    contentObserverRef.current = observer;
  }, []);

  /**
   * 前插补偿：用户已经往上滚开时，前插了多少高度就往下挪多少，他看的那一行不动。
   *
   * 这一条**只挂 `events`**，与上面那条相反：存根是在发请求那一刻记下的，而补偿
   * 要等前插真的落地才算得出来。跟着每次提交跑的话，中间那些提交（比如「正在读
   * 更早的」那行字）会拿一个高度根本没变的时刻把存根消费掉，等内容真到了反而没
   * 得补 —— 视口当场跳走。
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const restore = restoreRef.current;
    if (!restore) return;
    restoreRef.current = null;
    el.scrollTop = restore.top + (el.scrollHeight - restore.height);
    lastTopRef.current = el.scrollTop;
  }, [events]);

  /**
   * 够不够一屏 —— 服务端算不出来的那一半（规格决策 12）。
   *
   * 内容不满一屏时**没有滚动条**，滚动触发的续读永远不会成立，更早的内容会变成
   * 够不着。而服务端预测不了渲染高度：投影会丢掉渲染物，几 MB 的工具结果经共享包
   * 的折叠卡渲染出来只有几十像素——预算说满了，屏幕上却是空的。所以只能在这里量
   * 真渲染结果。
   *
   * 封顶防的是「一页接一页都渲染不出高度」时把整条对话拉回来，正是本轮要避免的事；
   * 封顶之后滚动这条路已经证明不管用，改出一个能点的入口。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (earlierInFlightRef.current || earlier.capped || !earlier.hasBefore) {
      return;
    }
    // 量不出视口高度（还没布局、或容器此刻是折叠的）时什么都不做：那是「不知道」，
    // 不是「不满一屏」。当成后者会在一个根本没显示出来的容器上白补满上限。
    if (el.clientHeight === 0) return;
    if (el.scrollHeight > el.clientHeight) return;
    if (topupsRef.current >= TOPUP_CAP) {
      setEarlier((p) => (p.capped ? p : { ...p, capped: true }));
      return;
    }
    topupsRef.current += 1;
    void loadEarlier();
  }, [events, earlier, loadEarlier]);

  /**
   * 「回到底部」那枚药丸按下去做的事。与钉底同一条语义：把 scrollTop 推到底，
   * 顺带把 pin 与它的可渲染镜像一起置回 —— 不等下一次 scroll 事件，
   * 否则控件会在原地多留一帧。
   */
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
    pinRef.current = true;
    setAtBottom(true);
  }, []);

  /**
   * 用户自己发了一条消息：重新跟住底部。
   *
   * 与药丸那一枚的区别是**不当场推 scrollTop**：这一下发生在提交回调里，要跟的
   * 那些东西（排队气泡、他自己那条消息、助手的三个点）都还没渲染出来，此刻推到
   * 底也只是推到「旧的底」。改开 pin，由上面那条 layout effect 在往后的每次提交
   * 里跟住 —— 内容长多少就跟多少。
   *
   * 「往回翻着看的人不该被新消息拽走」这条依然成立：拽走他的只有对端，而这一下
   * 是他自己按的发送，他的话就落在最底下。
   */
  const pinToBottom = useCallback(() => {
    pinRef.current = true;
    setAtBottom(true);
    setBottomVisibleId(null);
  }, []);

  /**
   * 用户对这条滚动带动手了（滚轮 / 触摸 / 按键 / 摁下滚动条）。
   *
   * 记的是**时刻**而不是「这一下滚了多少」：浏览器把输入与它引起的滚动分成两拨事件
   * 送来，中间还夹着惯性，位置的变化只能在随后的 scroll 里读到。
   */
  const noteUserScroll = useCallback(() => {
    userIntentUntilRef.current = performance.now() + USER_INTENT_MS;
  }, []);

  /** 滚动：维护「在不在底部」，并在距顶两屏以内时预取下一页。 */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const prevTop = lastTopRef.current;
    lastTopRef.current = top;
    const now = performance.now();
    const byUser = now <= userIntentUntilRef.current;
    // 用户在场时，这一串滚动（惯性、拖着滚动条）整段都算他的。
    if (byUser) userIntentUntilRef.current = now + USER_INTENT_MS;
    // 位置只是入参之一：解除跟随还要求这一下是**用户往回滚**。内容长高把底部推远
    // （行虚拟化复测、图片、表格）同样会让位置落在容差外，那不是他的意思；虚拟器
    // 复测时自己往回补的那一下更是连方向都和上滚一样 —— 不是他动的手，就当没往回走。
    const pinned = nextAutoFollow({
      prev: pinRef.current,
      prevScrollTop: byUser ? prevTop : top,
      scrollTop: top,
      atBottom: el.scrollHeight - top - el.clientHeight <= AT_BOTTOM_SLACK,
    });
    pinRef.current = pinned;
    setAtBottom((prev) => (prev === pinned ? prev : pinned));
    // 边界只随用户滚动而变；轮数则挂在 messages 上，人停在原地不动、对端又连出
    // 几轮时那个数照样往上走（见下面的 turnsBelow）。贴底时没有「下面」可言。
    setBottomVisibleId(pinned ? null : computeBottomVisibleMessageId(el));
    if (earlierInFlightRef.current || earlier.capped || !earlier.hasBefore) {
      return;
    }
    if (el.scrollTop < el.clientHeight * EARLIER_TRIGGER_VIEWPORTS) {
      void loadEarlier();
    }
  }, [earlier, loadEarlier]);

  /**
   * 目标会话换了，这一族的状态跟着重来。
   *
   * 输入带的边界跟着新会话回到「贴底」。pinRef 那一半在下面的 layout effect 里
   * 重置（渲染期写 ref 被 react-hooks/refs 禁止），这一半只能在这里。
   */
  const reset = useCallback(() => {
    setAtBottom(true);
    lastTopRef.current = 0;
    setEarlier({
      source: "none",
      oldestSeq: 0,
      hasBefore: false,
      loading: false,
      capped: false,
      failed: false,
    });
  }, []);

  const noteMirrorHistory = useCallback(
    (oldestSeq: number, hasBefore: boolean) => {
      setEarlier((prev) => ({
        ...prev,
        source: "mirror",
        oldestSeq,
        hasBefore,
      }));
    },
    [],
  );

  const noteRelayHistory = useCallback(
    (oldestSeq: number, hasBefore: boolean) => {
      // 镜像已经开口了就不改口：它从 0 起镜完整条对话，问到头就是对话的开头，
      // 而中继那一路的尽头只是对端自己的留存下界。
      setEarlier((prev) =>
        prev.source === "mirror"
          ? prev
          : { ...prev, source: "relay", oldestSeq, hasBefore },
      );
    },
    [],
  );

  /** 手点就是一次新的开始：把顶补的计数清掉，让它重新有机会自动补。 */
  const retryEarlier = useCallback(() => {
    topupsRef.current = 0;
    setEarlier((p) => ({ ...p, capped: false, failed: false }));
    void loadEarlier();
  }, [loadEarlier]);

  return {
    scrollRef,
    contentRef,
    getScrollElement,
    onScroll,
    noteUserScroll,
    jumpToBottom,
    pinToBottom,
    atBottom,
    bottomVisibleId,
    earlier,
    reset,
    noteMirrorHistory,
    noteRelayHistory,
    retryEarlier,
  };
}
