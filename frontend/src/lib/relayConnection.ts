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
import { RedialTimer } from "@/lib/redialTimer";
import {
  binaryPayload,
  unwrapEnvelope,
  wrapEnvelope,
} from "@/lib/relayEnvelope";
import { bearerSubprotocol } from "@/lib/relayUrl";

export type RelayState =
  "connecting" | "connected" | "disconnected" | "reconnecting";

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
  /** 退让的封顶（默认 30 秒）。 */
  maxReconnectDelayMs?: number;
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
  private readonly redial = new RedialTimer();
  private connectPromise: Promise<void> | null = null;
  private currentState: RelayState = "disconnected";
  /** 连着失败了几次。重连按它指数退让。 */
  private failures = 0;

  constructor(opts: RelayConnectionOptions) {
    this.opts = { reconnect: true, reconnectDelayMs: 1000, ...opts };
  }

  get state(): RelayState {
    return this.currentState;
  }

  /** 建立（或复用）这条账号级连接。 */
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
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
        this.failures = 0;
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
    if (this.opts.refreshCredentials) {
      const credentials = await this.opts.refreshCredentials();
      this.opts.url = credentials.url;
      this.opts.jwt = credentials.jwt;
    }
    const superseded = this.ws;
    this.ws = null;
    this.connectPromise = null;
    this.redial.cancel();
    for (const channel of this.channels.values()) channel.declared = false;
    // 先摘掉再关：那条被顶替的 socket 的 onclose 已经不属于当前连接，不会再跑收尾。
    superseded?.close();
    await this.connect();
  }

  /** 主动关闭整条连接（登出），不再自动重连。 */
  close(): void {
    this.closedByUser = true;
    this.redial.cancel();
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
    for (const channel of this.channels.values()) channel.declared = false;
    for (const listener of [...this.signalListeners]) {
      listener.onSignalClosed?.();
    }
    if (this.closedByUser || this.opts.reconnect === false) {
      this.setState("disconnected");
      return;
    }
    this.setState("reconnecting");
    if (this.redial.pending) return;
    // 指数退让并封顶：这条连接**登录期间常驻**（信号通道是永不释放的使用方），
    // 所以连不上的时候它会一直重试下去。固定 1 秒的重试等于对着一个够不着的
    // 服务端每秒拨一次，直到标签页关掉。
    const base = this.opts.reconnectDelayMs ?? 1000;
    const cap = this.opts.maxReconnectDelayMs ?? 30_000;
    const delay = Math.min(base * 2 ** this.failures, cap);
    this.failures += 1;
    this.redial.schedule(delay, () => {
      void this.redialOnce();
    });
  }

  private async redialOnce(): Promise<void> {
    try {
      if (this.opts.refreshCredentials) {
        const credentials = await this.opts.refreshCredentials();
        this.opts.url = credentials.url;
        this.opts.jwt = credentials.jwt;
      }
      await this.connect();
    } catch {
      this.handleClose();
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
