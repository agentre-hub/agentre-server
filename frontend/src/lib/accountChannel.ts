/**
 * 账号级实时通道在浏览器这一侧（server 的 GET /v1/account/channel）。
 *
 * 一条**常连**的 websocket，服务端在这个账号的同步版本推进时往上面推一个信号
 * 「该拉了」。它与中继的 /v1/relay/client 的根本区别是**不指定目标 daemon**，
 * 也**不送对象内容** —— 收到信号之后拉什么、怎么拉，由调用方自己决定。
 *
 * 这条通道的设计前提就是**它可以不可靠**：
 *
 *  - 连不上 / 断开：退回 30 秒轮询，即没有通道时的行为。不重试到底、不阻塞任何操作；
 *  - 建连成功（首次与重连一视同仁）：立刻主动拉一次，而不是等服务端补发 ——
 *    通道不保存未送达的信号，断线期间的变更由这一次补齐；
 *  - 漏帧、乱序、重复：都无害。版本号只用于「该拉了」的判断，绝不拿它当闸门。
 *
 * **30 秒轮询保留，不缩短也不删除**：它是通道的兜底，也是「不丢变更」的依据。
 * 判据是「把通道整个关掉，所有功能仍然正确，只是变慢到 30 秒」。
 *
 * 鉴权：浏览器原生 WebSocket 设不了请求头，票据沿用中继那条 query 搬运
 * （server 的 queryTokenBridge）。票据短效，因此每次建连都现取一张。
 */
import { RedialTimer } from "@/lib/redialTimer";
import { ensureRelayTicket } from "@/lib/relayTicket";
import {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
  AccountChannelSyncVersion,
  ProtobufAccountChannelCodec,
  type AccountChannelCodec,
  type AccountChannelSignal,
} from "@agentre-hub/agentre-wire";

const ProtobufSubprotocol = "agentre-protobuf";

export {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
  AccountChannelSyncVersion,
} from "@agentre-hub/agentre-wire";

/**
 * 通道上的信号种类与 notification codec 由 `@agentre-hub/agentre-wire` 统一拥有；
 * 本文件只负责浏览器鉴权、连接生命周期与刷新回调。
 *
 * 每一种都只说「这一类东西变了，该拉了」。不认识的种类**忽略但不断连**（见
 * decodeSignal），所以 server 新加一种可以先发后收。
 */
/** 账号的同步版本推进了（组织架构、Agent、执行目标……）。只有这一种带版本号。 */
/** 会话镜像与设备在线态的通知常量由共享 wire 包拥有。 */

/** 本轮认得的全部种类，也是 signalTypes 的默认值。 */
export const AccountChannelKnownTypes = [
  AccountChannelSyncVersion,
  AccountChannelMirrorChanged,
  AccountChannelDevicePresence,
] as const;

export type AccountChannelFrame = AccountChannelSignal;

/** 兜底轮询周期。与桌面端的 sync_svc.PollInterval 同一个 30 秒。 */
export const AccountChannelPollMs = 30_000;

/** 首次重连的等待，之后按指数退让，封顶到一个轮询周期。 */
export const AccountChannelReconnectMs = 1_000;

export interface AccountChannelOptions {
  /**
   * 「该拉了」。建连、每一次重连、每一条信号、以及兜底轮询都会调用它 ——
   * 调用方据此重新读一遍自己展示的数据。它必须是幂等的：重复调用只是多读一次。
   *
   * 参数是**哪一类**变了：收到信号时是那一帧的种类；建连 / 重连 / 兜底轮询触发时
   * 是 `null`，意思是「你可能已经落后了」——那三条路本来就不知道落后的是哪一类，
   * 拿它们当某一类的信号会漏掉别的。分发给多个消费者的调用方据此过滤。
   */
  onRefresh: (signalType: string | null) => void;
  /**
   * 只在这几种信号上回调，默认全部认得的种类。
   *
   * 收窄的是**信号**这一路，不是另外两路：建连/重连后的那一次主动拉、以及兜底轮询
   * 照样无条件跑——它们说的是「你可能已经落后了」，与哪一类东西变了无关。
   *
   * 页面据此只被自己展示的东西吵醒：设备列表不必因为别人发了条消息就重拉一遍。
   */
  signalTypes?: readonly string[];
  /** 兜底轮询周期，默认 30 秒。 */
  pollIntervalMs?: number;
  /** 首次重连等待，默认 1 秒（之后指数退让）。 */
  reconnectDelayMs?: number;
  /** 建连接缝：默认取一张中继票据。 */
  ensureTicket?: () => Promise<string>;
  /** WebSocket 工厂接缝，测试注入假连接。 */
  createWebSocket?: (url: string, protocols: string[]) => WebSocket;
  /** 线上帧 codec；默认使用共享包生成的 Protobuf codec。 */
  codec?: AccountChannelCodec;
}

export interface AccountChannelHandle {
  /** 停掉通道与兜底轮询。停掉之后不再重连、不再回调。 */
  stop(): void;
}

/** 通道端点。票据走 query：浏览器原生 WebSocket 设不了 Authorization 头。 */
export function accountChannelUrl(accessToken: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ access_token: accessToken });
  return `${proto}//${window.location.host}/v1/account/channel?${params.toString()}`;
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
  const baseRedialMs = options.reconnectDelayMs ?? AccountChannelReconnectMs;
  const ensureTicket =
    options.ensureTicket ??
    (async () => (await ensureRelayTicket()).accessToken);
  const createWebSocket =
    options.createWebSocket ??
    ((url: string, protocols: string[]) => new WebSocket(url, protocols));
  const codec = options.codec ?? ProtobufAccountChannelCodec;
  const wanted = new Set<string>(
    options.signalTypes ?? AccountChannelKnownTypes,
  );

  let stopped = false;
  let socket: WebSocket | null = null;
  const redial = new RedialTimer();
  let failures = 0;

  /**
   * 「该拉了」唯一的出口。
   *
   * `stop()` 关的是 websocket，而关闭是**异步**的：连接先进 CLOSING，onclose 要等
   * 之后才到，这中间已经在途的一帧照样会交给 onmessage。所以「停掉之后不再回调」
   * （见 AccountChannelHandle.stop）不能只靠停掉重连与轮询来兑现，得在这里挡一道
   * ——调用方 stop 多半是因为自己正在拆掉，这时再喊一次只会去拉一个没人看的视图。
   */
  function refresh(signalType: string | null): void {
    if (stopped) return;
    options.onRefresh(signalType);
  }

  /**
   * 这条回调是不是**当前**那条连接发来的。
   *
   * 重连等待由调用方给（reconnectDelayMs），给得够短时新连接就可能排在旧连接的
   * onerror / onclose 之前。那之后旧连接说的话一句都不算数——尤其不能让它把
   * `socket` 置空：置掉的是刚换上的那一条，stop() 从此关不到它，留下一条没人持有
   * 也没人关的连接在后台跟着心跳活下去。
   */
  function isCurrent(ws: WebSocket): boolean {
    return socket === ws;
  }

  // 兜底轮询：无条件跑，通道在不在、连不连得上都一样。它才是「不丢变更」的依据。
  const poll = setInterval(() => refresh(null), pollMs);

  /** 排一次重连。退让封顶到一个轮询周期——通道只是优化，重连不该比兜底还急。 */
  function scheduleRedial(): void {
    if (stopped || redial.pending) return;
    const delay = Math.min(baseRedialMs * 2 ** failures, pollMs);
    failures += 1;
    redial.schedule(delay, () => void connect());
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    let ws: WebSocket;
    try {
      const accessToken = await ensureTicket();
      if (stopped) return;
      ws = createWebSocket(accountChannelUrl(accessToken), [
        ProtobufSubprotocol,
      ]);
    } catch {
      // 票据取不到、连接建不起来：退回轮询，隔一会儿再试。不抛给调用方——
      // 通道连不上不是一次失败，是这条通道本来就允许不在。
      scheduleRedial();
      return;
    }
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      failures = 0;
      // 建连成功（首次或重连都一样）：立刻主动拉一次，断线期间的变更由它补齐。
      refresh(null);
    };
    ws.onmessage = (ev: MessageEvent) => {
      const frame = decodeSignal(ev.data, wanted, codec);
      if (frame === null) return;
      refresh(frame.type);
    };
    ws.onerror = () => {
      // 浏览器在建连失败时先 error 后 close；scheduleRedial 自己防重排。
      if (!isCurrent(ws)) return;
      scheduleRedial();
    };
    ws.onclose = () => {
      if (!isCurrent(ws)) return;
      socket = null;
      scheduleRedial();
    };
  }

  void connect();

  return {
    stop() {
      stopped = true;
      clearInterval(poll);
      redial.cancel();
      socket?.close();
      socket = null;
    },
  };
}
