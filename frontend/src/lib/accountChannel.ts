/**
 * 账号级实时信号在浏览器这一侧。
 *
 * 它**不再有自己的 socket**：`/v1/account/channel` 已经删除，信号跑在那条账号级中继
 * 连接的**保留通道**上（决策 13 / 14）。合并的是传输，不是总线——服务端每副本一份
 * Redis Pub/Sub 订阅原样保留，这里只是换了个到达口。
 *
 * 这条信号路的设计前提仍然是**它可以不可靠**：
 *
 *  - 不可用（订阅建不起来、信号源中断、连接断开）：退回 30 秒轮询，即没有它时的
 *    行为。不重试到底、不阻塞任何操作；这是**通道级**的失败，同一条 socket 上的
 *    RPC 照常；
 *  - 连上（首次与重连一视同仁）：立刻主动拉一次，而不是等服务端补发 ——
 *    通道不保存未送达的信号，断线期间的变更由这一次补齐；
 *  - 漏帧、乱序、重复：都无害。版本号只用于「该拉了」的判断，绝不拿它当闸门。
 *
 * **30 秒轮询保留，不缩短**：它是兜底，也是「不丢变更」的依据。判据是「把信号那一路
 * 整个关掉，所有功能仍然正确，只是变慢到 30 秒」。但它只在**信号不在**的时候跑
 * ——连着的时候变更由信号送达，再定时喊一次只会让每个订阅页面白拉一遍（见 poll）。
 *
 * 「该拉了」的出口上还有两道闸，压的都是**唤醒频率**，不是每次唤醒的成本：
 *
 *  - **攒批**（见 openWindow）：按种类分发的信号走 3 秒的首发 + 尾补窗口。持续写入
 *    的账号一秒能来好几条，而每喊一次「该拉了」，订到这一路上的每个页面都各拉一遍
 *    自己那份数据；
 *  - **可见性**（见 visible）：页面不可见时信号与兜底轮询都不走，恢复可见时补一次
 *    `refresh(null)`。
 *
 * 攒批只挡按种类的那一路——`refresh(null)` 是上面那条判据的依据，不能给它加延迟。
 */
import { relayClientPool } from "@/lib/relayClientPool";
import {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
  AccountChannelSyncVersion,
  ProtobufAccountChannelCodec,
  type AccountChannelCodec,
  type AccountChannelSignal,
} from "@agentre-hub/agentre-wire";

export {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
  AccountChannelSyncVersion,
} from "@agentre-hub/agentre-wire";

/**
 * 通道上的信号种类与 notification codec 由 `@agentre-hub/agentre-wire` 统一拥有；
 * 本文件只负责订阅那条保留通道并把「该拉了」分发出去。
 *
 * 每一种都只说「这一类东西变了，该拉了」。不认识的种类**忽略但不断连**（见
 * decodeSignal），所以 server 新加一种可以先发后收。
 */
export const AccountChannelKnownTypes = [
  AccountChannelSyncVersion,
  AccountChannelMirrorChanged,
  AccountChannelDevicePresence,
] as const;

export type AccountChannelFrame = AccountChannelSignal;

/** 兜底轮询周期。与桌面端的 sync_svc.PollInterval 同一个 30 秒。 */
export const AccountChannelPollMs = 30_000;

/**
 * 按种类分发的信号在收件侧的攒批窗口。
 *
 * 刻意与服务端 `mirror_svc` 的 `mirrorChangeWindow` 取**同一个 3 秒**：两边说的是
 * 同一件事「摘要多久刷新一次算够」，各取一个数的话总时延变成两个常量的和，而没有
 * 任何一处代码写得出这个和。两侧各自声明，不引入跨语言共享的常量。
 */
export const AccountChannelSignalWindowMs = 3_000;

/**
 * 这条通道此刻的状态，界面据此点灯。
 *
 * 三态而不是池子那四个 `RelayState` 的透传：`connecting` 与 `reconnecting` 在用户
 * 那里是同一件事（在动、会自己回来），分成两个只会让灯多闪一次而说不出新东西。
 * `disconnected` 与它们**不是**同一件事——它不会自己回来（见下面 onSignalClosed
 * 那一段），所以它必须单独占一态，界面才有地方挂那个出路。
 */
export type AccountChannelState = "connected" | "connecting" | "disconnected";

/** 池子上信号那一路要的那一小块能力（ISP），测试据此注入替身。 */
export type AccountSignalSource = Pick<
  typeof relayClientPool,
  "subscribeSignals"
>;

export interface AccountChannelOptions {
  /**
   * 「该拉了」。连上、每一次重连、每一条信号、以及兜底轮询都会调用它 ——
   * 调用方据此重新读一遍自己展示的数据。它必须是幂等的：重复调用只是多读一次。
   *
   * 参数是**哪一类**变了：收到信号时是那一帧的种类；连上 / 重连 / 兜底轮询触发时
   * 是 `null`，意思是「你可能已经落后了」——那三条路本来就不知道落后的是哪一类，
   * 拿它们当某一类的信号会漏掉别的。分发给多个消费者的调用方据此过滤。
   */
  onRefresh: (signalType: string | null) => void;
  /**
   * 只在这几种信号上回调，默认全部认得的种类。
   *
   * 收窄的是**信号**这一路，不是另两路：连上/重连后的那一次主动拉、以及兜底轮询
   * 照样无条件跑——它们说的是「你可能已经落后了」，与哪一类东西变了无关。
   */
  signalTypes?: readonly string[];
  /** 兜底轮询周期，默认 30 秒。 */
  pollIntervalMs?: number;
  /** 信号来源接缝，默认那条共用的账号级中继连接。 */
  source?: AccountSignalSource;
  /** 线上帧 codec；默认使用共享包生成的 Protobuf codec。 */
  codec?: AccountChannelCodec;
  /**
   * 状态变了。**只在真的变了的时候**调用——退避重连期间每拨一次都喊一遍的话，
   * 界面上那盏灯会跟着闪，而它想说的事从头到尾没变过。
   *
   * 与 onRefresh 分开的理由是它们服务两件事：onRefresh 是「去把数据读回来」，
   * 这里是「告诉用户你看到的东西还是不是实时的」。合成一个的话，界面要么按
   * 「有没有被喊过」猜状态，要么每次重拉都重画一遍灯。
   */
  onState?: (state: AccountChannelState) => void;
}

export interface AccountChannelHandle {
  /** 停掉信号订阅与兜底轮询。停掉之后不再回调。 */
  stop(): void;
}

/** 解一帧信号；读不懂或不是调用方要的种类时返回 null。 */
function decodeSignal(
  data: unknown,
  wanted: ReadonlySet<string>,
  codec: AccountChannelCodec,
): AccountChannelFrame | null {
  try {
    const signal = codec.decode(data);
    return signal !== null && wanted.has(signal.type) ? signal : null;
  } catch {
    // 读不懂的一帧丢掉就是了，不断连：断了要退回 30 秒轮询，代价比丢一帧大得多。
    return null;
  }
}

export function startAccountChannel(
  options: AccountChannelOptions,
): AccountChannelHandle {
  const pollMs = options.pollIntervalMs ?? AccountChannelPollMs;
  const source = options.source ?? relayClientPool;
  const codec = options.codec ?? ProtobufAccountChannelCodec;
  const wanted = new Set<string>(
    options.signalTypes ?? AccountChannelKnownTypes,
  );

  let stopped = false;
  /**
   * 信号那一路此刻**通着**吗。兜底轮询据此让路（见下面的 poll）。
   *
   * 判据是「连接连上过、保留通道还没被判死」，与 WebSocket 的实现细节无关——那条
   * socket 归池子，这里只认它交上来的三种事件。
   */
  let live = false;

  /**
   * 灯此刻的读数，以及**这条连接有没有说过话**。
   *
   * 后者用来分辨两种长得一样的「这一路不可用」：连过之后的每一次断开都伴随一次
   * 状态事件（RelayConnection.handleClose 先喊 onSignalClosed，再置 reconnecting），
   * 而池子在建连那一步就失败时**只有** onSignalClosed，一个状态事件都不会有。
   * 后者才是那个不会自愈的：`ensureConnection` 已经把连接置回 null，此后没有任何
   * 东西重试，页面就那么一直停在 30 秒轮询上。
   */
  let state: AccountChannelState = "connecting";
  let heardConnection = false;

  function setState(next: AccountChannelState): void {
    if (stopped || next === state) return;
    state = next;
    options.onState?.(next);
  }

  /**
   * 这一侧的 `document`，没有就是 null。
   *
   * SSR、Node 里跑的单测、以及任何不是浏览器的宿主都可能没有它。这条通道允许
   * 自己不在（不可用就退回轮询），但不允许自己弄坏调用方——所以这里不能直接摸
   * `document`，取不到时按「一直可见」处理。
   */
  const doc = typeof document === "undefined" ? null : document;

  /** 这个页面此刻有人看着吗。判据是可见性，不是焦点（见 onVisibilityChange）。 */
  function visible(): boolean {
    return doc === null || doc.visibilityState !== "hidden";
  }

  /**
   * 「该拉了」唯一的出口。两种情况不喊：
   *
   *  - 停掉之后：调用方 stop 多半是因为自己正在拆掉，这时再喊一次只会去拉一个
   *    没人看的视图；
   *  - 页面不可见：看不见的页面上没有任何人在等这份数据。信号与兜底轮询一起挡在
   *    这里，只挡轮询的话后台标签页仍会被每一条信号逐条唤醒，省不下什么。隐藏期间
   *    落下的所有变更由恢复可见时的那一次 refresh(null) 一次补齐（决策 4）。
   */
  function refresh(signalType: string | null): void {
    if (stopped || !visible()) return;
    options.onRefresh(signalType);
  }

  /**
   * 攒批窗口此刻的样子：开着的那个定时器，以及窗口里被压住的种类。
   *
   * 只压**按种类分发**的那一路。`refresh(null)` 不进这里（决策 3）：它说的是
   * 「你可能已经落后了」，是「不丢变更」的依据，押进窗口等于给补齐加延迟。
   */
  let windowTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();

  function closeWindow(): void {
    if (windowTimer !== null) clearTimeout(windowTimer);
    windowTimer = null;
    pending.clear();
  }

  /**
   * 开一个窗口。窗口结束时把压住的种类**各分发一次**——不能合成一条，也不能换成
   * 一条 null：fanOut 按种类过滤订阅者，合成会让只订某一种的订阅者被错误唤醒或
   * 错误跳过。补过还有就再开一个窗口，与服务端那一侧的首发 + 尾补同形状。
   */
  function openWindow(): void {
    // 分发是**同步**回调调用方的，而调用方可以在那一下里把通道停掉：use-account-channel
    // 的 fanOut 会在一个订阅者的 refresh 里同步卸载别的订阅者，卸载走到 releaseChannel
    // 就是 stop()。续窗排在分发之后，所以它必须自己认一次「已经停了」——否则这一步会把
    // 一个定时器留在 stop() 之后，把 handle 连同它闭包里那一份调用方状态一起吊住。
    if (stopped) return;
    windowTimer = setTimeout(() => {
      windowTimer = null;
      const flushing = Array.from(pending);
      pending.clear();
      // 这一轮什么都没压住：安静下来了，窗口关掉，下一条信号又是零时延。
      if (flushing.length === 0) return;
      flushing.forEach((signalType) => refresh(signalType));
      openWindow();
    }, AccountChannelSignalWindowMs);
  }

  /**
   * 一条按种类分发的信号到了。窗口外的第一条立刻分发（一次突发里第一条的时延仍是
   * 零），窗口内再来的按种类记下。
   *
   * 不可见时在这里就掉头：让它走下去只会在一个没人看的标签页上留一个每 3 秒醒
   * 一次的定时器，而醒来那一下什么都不会分发。
   */
  function dispatchSignal(signalType: string): void {
    if (stopped || !visible()) return;
    if (windowTimer !== null) {
      pending.add(signalType);
      return;
    }
    refresh(signalType);
    openWindow();
  }

  /**
   * 可见性变了。判据取 `document.visibilityState` 而不是窗口焦点：失焦但可见的
   * 窗口（分屏、并排对照）用户确实在看，拿 blur/focus 判会让并排看两个标签页的
   * 用户看到其中一个停止更新。
   *
   * 转为可见时先**清空窗口**再补齐（决策 6）：否则这一次 refresh(null) 之后，窗口
   * 里可能还压着隐藏期间攒下的尾补，几百毫秒后再无谓地重拉一遍。清空之后语义干净
   * ——恢复可见 = 一次完整补齐，窗口从零开始。
   */
  function onVisibilityChange(): void {
    if (stopped || !visible()) return;
    closeWindow();
    refresh(null);
  }

  doc?.addEventListener("visibilitychange", onVisibilityChange);

  /**
   * 兜底轮询：**信号不在时**的那一档，通着的时候让路。
   *
   * `refresh(null)` 说的是「你可能已经落后了」，因此它会喊醒**所有**订阅者
   * （见 use-account-channel 的 fanOut），每个页面各拉一遍自己那份数据——一个开着
   * 「对话」页的标签页就是七条请求。通着的时候这七条一条都换不来新东西：真变了
   * 服务端会推信号，而信号那条路是按种类分发的。
   *
   * 代价说清楚：通着但服务端漏发了信号时，页面会停在旧数据上直到下一条信号或用户
   * 自己刷新，不再有 30 秒把它拉回来。
   */
  const poll = setInterval(() => {
    if (live) return;
    refresh(null);
  }, pollMs);

  const unsubscribe = source.subscribeSignals(
    (payload: Uint8Array) => {
      const frame = decodeSignal(payload, wanted, codec);
      if (frame === null) return;
      dispatchSignal(frame.type);
    },
    {
      // 保留通道被判死：订阅建不起来，或信号源中途断了。整条连接照常服务 RPC，
      // 这里只把信号那一路标为不可用并退回 30 秒轮询。
      onSignalClosed: () => {
        live = false;
        if (!heardConnection) setState("disconnected");
      },
      onStateChange: (next) => {
        heardConnection = true;
        if (next === "connected") {
          live = true;
          setState("connected");
          // 连上（首次或重连都一样）：立刻主动拉一次，断线期间的变更由它补齐。
          refresh(null);
          return;
        }
        live = false;
        // connecting 与 reconnecting 折成同一态：都是「在动，会自己回来」。
        setState(next === "disconnected" ? "disconnected" : "connecting");
      },
    },
  );

  return {
    stop() {
      stopped = true;
      clearInterval(poll);
      closeWindow();
      // 留在 document 上的监听会把这个 handle 连同它闭包里那一份调用方状态一起
      // 吊住，页面切一次就漏一份。
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribe();
    },
  };
}
