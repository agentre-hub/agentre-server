/**
 * 账号级中继连接：**一个账号一条 WebSocket**（决策 10 + 13）。
 *
 * 从前一台机器一条：URL 上带 `daemon_fingerprint`，于是同时看三台机器上的对话就是
 * 三条 socket，再加账号信号那条独立连接，一共四条。目标下沉到通道之后连接本身不再
 * 有目标——每条虚拟通道开通时自己声明 `conversation:<uuid>` 或 `machine:<fingerprint>`
 * （见 relayTarget），所以同一条 socket 上的两条通道可以落在两台不同的机器上。
 *
 * 这条连接同时承担两件事：普通通道承载 RPC，服务端主动开的保留通道
 * （`~signal`，决策 14）承载账号信号。因此**服务端主动开通道**这件事是新的：从前
 * 客户端那条链路上的通道全部由客户端 `open()`。
 *
 * 失败按通道隔离：单条通道的目标不存在 / 离线 / 转发失败只答复给那一条通道一帧
 * 通道级错误，随后关掉那一条；整条连接只在鉴权失效时被服务端关掉。信号订阅建不
 * 起来同理——它也是通道级的，连接照常服务 RPC。
 */
import { ApiError } from "@/lib/api";
import { RedialTimer } from "@/lib/redialTimer";
import { backoffDelay } from "@/lib/relayBackoff";
import { unwrapEnvelope, wrapEnvelope } from "@agentre-hub/agentre-wire";
import { bearerSubprotocol } from "@/lib/relayUrl";

/** 把 WebSocket 收到的东西归一成字节。信封本身归 wire 包，只有这条平台细节留在这里。 */
function binaryPayload(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("relay: 中继帧必须是二进制");
}

/** 页面此刻对用户可见吗。没有 document（非浏览器）时按可见算。 */
function pageVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

/**
 * 连接（及其上每条通道）的状态。
 *
 * 终态只有两种来历：`disconnected`（主动关掉了 / 协议版本不符 / 目标永远开不起来）与
 * `signedOut`（取票 401：会话已登出，再拨也只会再拿一次 401）。超时、断开、5xx 等网络
 * 错误一律停在 `reconnecting` 持续退避重试，永不进终态（E1）。
 */
export type RelayState =
  "connecting" | "connected" | "disconnected" | "reconnecting" | "signedOut";

/**
 * 这次失败说的是「账号已登出」吗。只有 401 才算：网络错误、超时、5xx、403 都不算
 * （spec 的硬约束「只有 401 才算登出」）。
 */
export function isSignedOutError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * 页面可见时连着这么多次请求等不到应答，就不信这条 socket 还活着了（E3）。
 *
 * 浏览器发不了 WebSocket ping，一条死掉的 socket 要等很久才自己报关闭；一次超时可能
 * 只是对端慢，两次之间没有任何一帧回来才说明是这条线死了。
 */
const DEAD_AFTER_TIMEOUTS = 2;

/** 账号信号那条保留通道，与服务端 relay_svc.SignalChannelID 同一个值。 */
export const SignalChannelID = "~signal";

const OPEN = 1;
const PROTOBUF_SUBPROTOCOL = "agentre-protobuf";

/** 一条虚拟通道的收件口。 */
export interface RelayChannelListener {
  /**
   * socket 就绪、这条通道的目标已经声明出去。
   *
   * 每一次（重）连都会调用：新 socket 上服务端认不得旧通道，目标要重新声明，
   * 通道自己的握手（`auth.account`）也要重做。
   */
  onOpen?: () => void;
  /** 这条通道收到一帧载荷。 */
  onFrame?: (payload: Uint8Array) => void;
  /**
   * 服务端关掉了这条通道（空载荷）。通道级错误会先到一帧错误、再到这一下。
   * 整条连接不受影响。
   */
  onClose?: () => void;
  /**
   * 整条连接的状态变了。通道据此知道「不是我这条出了问题，是 socket 断了」——
   * 通道级失败走 onClose，连接级的抖动走这里。
   */
  onConnectionState?: (state: RelayState) => void;
  /**
   * 连接下一次自动重拨排在哪个时刻（Unix 毫秒）；没排着时是 null。界面据此画
   * 「下次自动重试 N 秒后」。
   */
  onNextRetryAt?: (at: number | null) => void;
}

/** 一条虚拟通道的把手。 */
export interface RelayChannelHandle {
  /** 往这条通道写一帧。连接没就绪时抛。 */
  send(frame: Uint8Array): void;
  /** 关掉这条通道（不影响连接）。 */
  close(): void;
}

/** 账号信号那一路的收件口。 */
export interface RelaySignalListener {
  /** 一帧信号（线上字节，由调用方按 wire 的账号 codec 解）。 */
  onSignal?: (payload: Uint8Array) => void;
  /**
   * 信号那一路不可用：订阅建不起来，或信号源中途断了。
   *
   * 这是**通道级**的失败，连接照常服务 RPC，调用方只把信号那一路标为不可用并
   * 退回 30 秒轮询。
   */
  onSignalClosed?: () => void;
}

export interface RelayConnectionOptions {
  /** ws(s)://host/v1/relay/client —— URL 上没有目标（决策 10）。 */
  url: string;
  /** 短效票据，走子协议携带（见 relayUrl）。 */
  jwt: string;
  /** 断线重连前换取新的短效凭据。 */
  refreshCredentials?: () => Promise<{ url: string; jwt: string }>;
  /** 断线自动重连（默认 true）。 */
  reconnect?: boolean;
  /** 首次重连的等待，之后指数退让（默认 1000）。 */
  reconnectDelayMs?: number;
  /**
   * 连上之后活满多久才算「这次是成功的」，退让计数据此归零（默认 10 秒）。
   *
   * 不能一 `onopen` 就归零：服务端接受 upgrade 之后随即断开是一条真实路径——连接
   * 守卫每次心跳复查账号闸门，而闸门判不出来时是 fail-closed。那时每条连接都在
   * 「连上 → 立刻断 → 等 1 秒」上打转，等于对着一个已经不健康的依赖每秒一次。
   */
  stableConnectionMs?: number;
  /** [0,1) 的抖动源，测试注入定值。 */
  random?: () => number;
  /** WebSocket 工厂接缝，测试注入假实现。 */
  createWebSocket?: (
    url: string,
    headers: Record<string, string>,
    protocols: string[],
  ) => WebSocket;
  onStateChange?: (state: RelayState) => void;
}

interface Channel {
  readonly id: string;
  readonly target: string;
  readonly listener: RelayChannelListener;
  /** 这一条在当前 socket 上已经声明过目标了吗。 */
  declared: boolean;
}

export class RelayConnection {
  private readonly opts: RelayConnectionOptions;
  private ws: WebSocket | null = null;
  private nextChannel = 1;
  private readonly channels = new Map<string, Channel>();
  private readonly signalListeners = new Set<RelaySignalListener>();
  private closedByUser = false;
  /**
   * 主动关闭的次数。重连 / 重拨要先换票（await），换票期间被关掉的话票回来时不能再拨：
   * `connect()` 会把 closedByUser 复位，拨出去的就是一条没人认领、自己退让重拨不止的连接。
   */
  private closeGeneration = 0;
  private readonly redial = new RedialTimer();
  private connectPromise: Promise<void> | null = null;
  private currentState: RelayState = "disconnected";
  /** 连着失败了几次。重连按它指数退让。 */
  private failures = 0;
  /** 当前这条 socket 是什么时候连上的；没连上时为 null。见 stableConnectionMs。 */
  private connectedAt: number | null = null;
  /**
   * 可见时意外断线那一次「不等退避」的重拨还能不能用（决策 2）。
   *
   * 只能用一次：连上就断的循环里每次都立即重拨，就是对着一个不健康的服务端猛拨。
   * 用掉之后要等一条连接活满 stableConnectionMs（或一次全新的 reconnect）才再给。
   */
  private quickRedial = true;
  /** 下一次自动重拨排在哪个时刻，见 nextRetryAt。 */
  private retryAt: number | null = null;
  /** 页面可见时连着超时了几次，见 noteRequestTimeout。 */
  private timeouts = 0;

  constructor(opts: RelayConnectionOptions) {
    this.opts = { reconnect: true, reconnectDelayMs: 1000, ...opts };
  }

  get state(): RelayState {
    return this.currentState;
  }

  /** 下一次自动重拨排在哪个时刻（Unix 毫秒）；没排着时是 null。 */
  get nextRetryAt(): number | null {
    return this.retryAt;
  }

  /**
   * 这条连接上有一条请求等满了上限也没等到应答（RelayClient 报上来）。
   *
   * 页面可见时连着两次、期间这条 socket 一帧都没送回来：判它已死，换一条新连接（E3）。
   * 隐藏时不算——后台里定时器被节流，超时本身就不可信，回到前台由池子按「在后台待了
   * 多久」换连接。没连着时也不算：那时重拨已经在途。
   */
  noteRequestTimeout(): void {
    if (this.currentState !== "connected" || !pageVisible()) return;
    this.timeouts += 1;
    if (this.timeouts < DEAD_AFTER_TIMEOUTS) return;
    this.timeouts = 0;
    void this.reconnect().catch(() => {
      // 取票失败已在 reconnect 里落成退避重试 / 登出态。
    });
  }

  /** 建立（或复用）这条账号级连接。 */
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    // 登出是终态：拿手上那张注定被拒的旧票再拨，只是又一轮「连上就断 → 换票 401」。
    if (this.currentState === "signedOut") {
      return Promise.reject(new Error("relay: 账号已登出"));
    }
    this.closedByUser = false;
    this.setState("connecting");
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const headers = { Authorization: `Bearer ${this.opts.jwt}` };
      const factory =
        this.opts.createWebSocket ??
        ((url: string, _headers: Record<string, string>, protocols: string[]) =>
          new WebSocket(url, protocols));
      // 票走子协议而不是 URL：那样它不进 access log / history / Referer。
      const ws = factory(this.opts.url, headers, [
        PROTOBUF_SUBPROTOCOL,
        bearerSubprotocol(this.opts.jwt),
      ]);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        this.connectedAt = Date.now();
        this.timeouts = 0;
        this.setState("connected");
        // 新 socket 上服务端认不得旧通道：逐条重新声明目标，再让每条通道自己
        // 重做握手与补齐。顺序要紧——目标声明必须是这条通道的第一帧。
        for (const channel of [...this.channels.values()]) {
          this.declare(channel);
        }
        resolve();
        for (const channel of [...this.channels.values()]) {
          channel.listener.onOpen?.();
        }
      };
      ws.onerror = () => {
        if (ws.readyState !== OPEN) {
          this.connectPromise = null;
          reject(new Error("relay: WebSocket 连接失败"));
        }
      };
      ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
      ws.onclose = () => {
        // 只有**当前**这条 socket 的收尾才作数：被换掉的旧 socket 的 close 总在
        // 新连接建立之后才到，照单全收会把一条刚连上的连接判成断线。
        if (this.ws !== ws) return;
        this.ws = null;
        this.connectPromise = null;
        this.handleClose();
      };
    });
    return this.connectPromise;
  }

  /**
   * 从头再连一次：关掉当前这条 socket、换一张票、重建。
   *
   * 通道**留着**：重连换的是底下那条 socket，不是「大家都不用了」。每条通道在新
   * socket 上重新声明目标、重做自己的握手。
   */
  async reconnect(): Promise<void> {
    // 人点的「重新连接」是一次全新的尝试：不该继承上一轮攒下来的退让，否则紧接着
    // 的一次失败要等满累积的那个时长才会再试。它换出去的那条连上之后再意外断开，
    // 同样配得上一次立即重拨。
    this.failures = 0;
    this.quickRedial = true;
    // 「立即重试」：排着的那次作废，倒计时由这一次的结果重新给。
    this.cancelRedial();
    const generation = this.closeGeneration;
    // 换连接从这一刻起就是「连接中」（E3）：取票期间旧 socket 还挂着，但它已被判
    // 不可信，发送据此走排队，而不是写进一条可能早已死掉的线。
    this.setState("connecting");
    if (this.opts.refreshCredentials) {
      let credentials: { url: string; jwt: string };
      try {
        credentials = await this.opts.refreshCredentials();
      } catch (err) {
        if (generation === this.closeGeneration) {
          this.supersede();
          this.failCredentials(err);
        }
        throw err;
      }
      if (generation !== this.closeGeneration) return;
      this.opts.url = credentials.url;
      this.opts.jwt = credentials.jwt;
    }
    this.supersede();
    await this.connect();
  }

  /** 主动关闭整条连接（登出），不再自动重连。 */
  close(): void {
    this.closedByUser = true;
    this.closeGeneration += 1;
    this.cancelRedial();
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
    this.setState("disconnected");
  }

  /**
   * 开一条虚拟通道并声明它的目标。
   *
   * 通道号是**客户端自己那个命名空间**里的号：它只在这条连接里有效，服务端分配给
   * daemon 那条链路的号由服务端翻译，所以撞不到、也猜不到别人那条通道。保留前缀
   * `~` 不在这里生成的字母表内（决策 14）。
   */
  openChannel(
    target: string,
    listener: RelayChannelListener = {},
  ): RelayChannelHandle {
    const id = `c${this.nextChannel++}`;
    const channel: Channel = { id, target, listener, declared: false };
    this.channels.set(id, channel);
    if (this.ws?.readyState === OPEN) this.declare(channel);
    return {
      send: (frame: Uint8Array) => {
        if (!this.channels.has(id)) throw new Error("relay: 通道已关闭");
        this.declare(channel);
        this.writeEnvelope(id, frame);
      },
      close: () => {
        if (!this.channels.delete(id)) return;
        // 空载荷 = 这条通道关了，让承载它的机器也知道。连接没就绪时无须（也无法）
        // 通知：新 socket 上这条通道本来就不存在。
        if (channel.declared && this.ws?.readyState === OPEN) {
          try {
            this.writeEnvelope(id, new Uint8Array(0));
          } catch {
            // 连接正在收尾：机器那侧会随整条链路的断开一并清掉。
          }
        }
      },
    };
  }

  /** 订阅账号信号那条保留通道。交回退订。 */
  subscribeSignals(listener: RelaySignalListener): () => void {
    this.signalListeners.add(listener);
    return () => {
      this.signalListeners.delete(listener);
    };
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private declare(channel: Channel): void {
    if (channel.declared) return;
    // 目标是这条通道的第一帧（决策 10）。写不出去就不标记，下一次再补。
    this.writeEnvelope(channel.id, new TextEncoder().encode(channel.target));
    channel.declared = true;
  }

  private writeEnvelope(channelId: string, frame: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== OPEN) {
      throw new Error("relay: 连接未就绪");
    }
    this.ws.send(wrapEnvelope(channelId, frame));
  }

  private handleMessage(data: unknown): void {
    // 这条 socket 还活着：之前那几次超时不再算「连着的」。
    this.timeouts = 0;
    let channelId: string;
    let frame: Uint8Array;
    try {
      ({ channelId, frame } = unwrapEnvelope(binaryPayload(data)));
    } catch {
      // 单帧坏掉不影响连接：丢掉继续等下一帧。
      return;
    }
    if (channelId === SignalChannelID) {
      this.dispatchSignal(frame);
      return;
    }
    const channel = this.channels.get(channelId);
    if (!channel) return;
    if (frame.length === 0) {
      // 服务端关掉了这条通道（通道级失败的收尾）。整条连接不受影响。
      this.channels.delete(channelId);
      channel.listener.onClose?.();
      return;
    }
    channel.listener.onFrame?.(frame);
  }

  private dispatchSignal(frame: Uint8Array): void {
    // 空载荷 = 保留通道关了：订阅建不起来，或信号源中途断了。它是通道级的，
    // 这条连接上的 RPC 照常。
    const listeners = [...this.signalListeners];
    if (frame.length === 0) {
      for (const listener of listeners) listener.onSignalClosed?.();
      return;
    }
    for (const listener of listeners) listener.onSignal?.(frame);
  }

  private handleClose(): void {
    // 「连上过」不等于「连成功过」：活够 stableConnectionMs 才算，退让计数这时才归零。
    const stableMs = this.opts.stableConnectionMs ?? 10_000;
    // 没连上就关了的是一次拨号失败，不是「意外断线」：它照旧退避。
    const wasOpen = this.connectedAt !== null;
    if (
      this.connectedAt !== null &&
      Date.now() - this.connectedAt >= stableMs
    ) {
      this.failures = 0;
      this.quickRedial = true;
    }
    this.connectedAt = null;
    for (const channel of this.channels.values()) channel.declared = false;
    for (const listener of [...this.signalListeners]) {
      listener.onSignalClosed?.();
    }
    if (this.closedByUser || this.opts.reconnect === false) {
      this.setState("disconnected");
      return;
    }
    // 已登出：再拨只会再拿一次 401，停在终态等人重新登录。
    if (this.currentState === "signedOut") return;
    this.setState("reconnecting");
    if (this.redial.pending) return;
    // 页面可见时意外断线：用户正看着，第一次重拨不等退避（决策 2）。不动失败计数，
    // 这一次若又没成，接下来就是今天那条阶梯。后台里断的照旧退避——回到前台时由
    // 池子换连接（RelayClientPool.watchForeground）。
    if (wasOpen && this.quickRedial && pageVisible()) {
      this.quickRedial = false;
      this.scheduleRedial(0);
      return;
    }
    // 指数退让并封顶：这条连接**登录期间常驻**（信号通道是永不释放的使用方），
    // 所以连不上的时候它会一直重试下去。固定 1 秒的重试等于对着一个够不着的
    // 服务端每秒拨一次，直到标签页关掉。形状（含抖动）见 relayBackoff。
    const delay = backoffDelay(this.failures, {
      baseMs: this.opts.reconnectDelayMs ?? 1000,
      capMs: 30_000,
      random: this.opts.random,
    });
    this.failures += 1;
    this.scheduleRedial(delay);
  }

  /** 排一次重拨，并把它排在哪个时刻告诉每条通道。 */
  private scheduleRedial(delayMs: number): void {
    this.redial.schedule(delayMs, () => {
      this.setRetryAt(null);
      void this.redialOnce();
    });
    this.setRetryAt(Date.now() + delayMs);
  }

  private cancelRedial(): void {
    this.redial.cancel();
    this.setRetryAt(null);
  }

  /**
   * 把当前这条 socket 摘下来关掉，好让下一次 connect() 拨一条新的。
   *
   * 先摘掉再关：那条被顶替的 socket 的 onclose 已经不属于当前连接，不会再跑收尾。
   */
  private supersede(): void {
    const superseded = this.ws;
    this.ws = null;
    this.connectPromise = null;
    // 「连上过」说的是被顶替的那条：新这条拨不通时不能被当成「连上后意外断开」。
    this.connectedAt = null;
    for (const channel of this.channels.values()) channel.declared = false;
    superseded?.close();
  }

  /**
   * 取票失败。401 是终态：停拨、转登出态；其余（网络错误、超时、5xx）都只是这一次
   * 没成，照退避接着试，永不进终态（E1）。
   */
  private failCredentials(err: unknown): void {
    if (isSignedOutError(err)) {
      this.cancelRedial();
      this.setState("signedOut");
      return;
    }
    this.handleClose();
  }

  private async redialOnce(): Promise<void> {
    const generation = this.closeGeneration;
    if (this.opts.refreshCredentials) {
      let credentials: { url: string; jwt: string };
      try {
        credentials = await this.opts.refreshCredentials();
      } catch (err) {
        if (generation === this.closeGeneration) this.failCredentials(err);
        return;
      }
      if (generation !== this.closeGeneration) return;
      this.opts.url = credentials.url;
      this.opts.jwt = credentials.jwt;
    }
    try {
      await this.connect();
    } catch {
      this.handleClose();
    }
  }

  private setRetryAt(at: number | null): void {
    if (at === this.retryAt) return;
    this.retryAt = at;
    for (const channel of [...this.channels.values()]) {
      channel.listener.onNextRetryAt?.(at);
    }
  }

  private setState(state: RelayState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.opts.onStateChange?.(state);
    for (const channel of [...this.channels.values()]) {
      channel.listener.onConnectionState?.(state);
    }
  }
}
