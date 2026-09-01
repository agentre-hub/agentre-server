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
   * 「该拉了」唯一的出口。停掉之后不再喊：调用方 stop 多半是因为自己正在拆掉，
   * 这时再喊一次只会去拉一个没人看的视图。
   */
  function refresh(signalType: string | null): void {
    if (stopped) return;
    options.onRefresh(signalType);
  }

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
      refresh(frame.type);
    },
    {
      // 保留通道被判死：订阅建不起来，或信号源中途断了。整条连接照常服务 RPC，
      // 这里只把信号那一路标为不可用并退回 30 秒轮询。
      onSignalClosed: () => {
        live = false;
      },
      onStateChange: (state) => {
        if (state === "connected") {
          live = true;
          // 连上（首次或重连都一样）：立刻主动拉一次，断线期间的变更由它补齐。
          refresh(null);
          return;
        }
        live = false;
      },
    },
  );

  return {
    stop() {
      stopped = true;
      clearInterval(poll);
      unsubscribe();
    },
  };
}
