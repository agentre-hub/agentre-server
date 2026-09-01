/**
 * 一个账号一条中继 WebSocket，一个目标一条虚拟通道。
 *
 * 为什么需要它:`RelayClient` 自己在一条通道上按 request id 多路复用，可那是
 * **一条通道之内**的复用；跨功能没有任何东西在管。此前详情页、目录选择器、技能面板、
 * 引擎设置、派发各自 `new RelayClient`，于是同一台 agentred 在同一个页面上会有好几条
 * 物理连接，每条都要重取一次票、重升级一次 WS、再重握一次 `auth.account`。
 *
 * 本轮把这件事推到底（决策 10 + 13）：目标从连接级降到通道级之后，连接本身不再有
 * 目标，于是**同时观察 N 台机器上的对话也只有一条 socket**，账号信号那条从前独立的
 * 连接也并进来（保留通道）。池子因此按**账号**索引连接、按**目标**索引通道。
 *
 * 空闲宽限只管普通通道：最后一个使用方走了之后那条**通道**留一段宽限再关，一次性
 * 调用（点开一次技能面板）因此不会在通道刚开好就把它关掉。**连接不受宽限管**——
 * 信号通道是一个永不释放的使用方，所以「零台机器在线时 socket 数仍是 1」，只有登出
 * （closeAll）才收掉它。
 *
 * 关的权力只在池子手里。使用方拿到的是一份租约，`release()` 说的是「我不用了」，
 * 不是「关掉它」——旧代码里那些 `finally { client.close() }` 一旦共享就会把别人正在
 * 收事件的通道关掉。
 */
import type {
  AutonomousTurnStartedFrame,
  EventFrame,
  RunResultDoneFrame,
} from "@agentre-hub/agentre-wire";

import {
  RelayClient,
  type RelayClientOptions,
  type RelayState,
} from "@/lib/relayClient";
import {
  RelayConnection,
  type RelayConnectionOptions,
} from "@/lib/relayConnection";
import { ensureRelayTicket, type RelayTicket } from "@/lib/relayTicket";
import { relayClientUrl } from "@/lib/relayUrl";

/** 空闲宽限：与 Go 侧 ConnPool 的 idleTimeout 同值。 */
const DEFAULT_IDLE_GRACE_MS = 30_000;

/**
 * 一个使用方的收件口。全是可选的：一次性调用只是想借条通道发个请求，什么都不听。
 */
export interface RelayListener {
  onEvent?: (frame: EventFrame) => void;
  onRunResultDone?: (frame: RunResultDoneFrame) => void;
  onAutonomousTurnStarted?: (frame: AutonomousTurnStartedFrame) => void;
  onStateChange?: (state: RelayState) => void;
}

/** 一份租约。 */
export interface RelayLease {
  readonly client: RelayClient;
  readonly ticket: RelayTicket;
  release(): void;
}

export interface RelayClientPoolDeps {
  idleGraceMs?: number;
  ensureTicket?: () => Promise<RelayTicket>;
  /** 账号级连接的 URL。上面没有目标（决策 10）。 */
  connectionUrl?: () => string;
  createConnection?: (opts: RelayConnectionOptions) => RelayConnection;
  createClient?: (opts: RelayClientOptions) => RelayClient;
}

export interface AcquireOptions {
  /**
   * 等这条通道**握完手**再交出租约，默认 true。
   *
   * 一次性调用要 true：拿到就发请求，没连上等于白发。长连接的使用方（详情页）要
   * false —— 它不等，拿到 client 就挂上去，首次连不上交给连接自己退避重连、页面从
   * `onStateChange` 读到 "reconnecting"。等连上再交付会把这条路堵死：首次失败当场
   * 被说成 "disconnected"（横幅写「已经不再自动重试」），而它明明正在重试。
   */
  waitForConnect?: boolean;
}

/** 一条虚拟通道上的租户。 */
interface Entry {
  target: string;
  client: RelayClient;
  listeners: Set<RelayListener>;
  refs: number;
  idle: ReturnType<typeof setTimeout> | null;
  /** 这条通道的首次握手。`waitForConnect` 那一档等的就是它。 */
  ready: Promise<void>;
}

/** 账号信号那一路的订阅者。 */
export interface RelaySignalSubscriber {
  onSignal?: (payload: Uint8Array) => void;
  onSignalClosed?: () => void;
  onStateChange?: (state: RelayState) => void;
}

export class RelayClientPool {
  private readonly idleGraceMs: number;
  private readonly ensureTicket: () => Promise<RelayTicket>;
  private readonly connectionUrl: () => string;
  private readonly createConnection: (
    opts: RelayConnectionOptions,
  ) => RelayConnection;
  private readonly createClient: (opts: RelayClientOptions) => RelayClient;

  /** 这个账号此刻那条连接。至多一条。 */
  private connection: RelayConnection | null = null;
  private connectionTicket: RelayTicket | null = null;
  private connecting: Promise<{
    connection: RelayConnection;
    ticket: RelayTicket;
  }> | null = null;

  private readonly entries = new Map<string, Entry>();
  /** 正在建的那一条通道。并发 acquire 共用它，不抢建第二条。 */
  private readonly pending = new Map<string, Promise<Entry>>();
  private readonly signalSubscribers = new Set<RelaySignalSubscriber>();

  constructor(deps: RelayClientPoolDeps = {}) {
    this.idleGraceMs = deps.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.ensureTicket = deps.ensureTicket ?? ensureRelayTicket;
    this.connectionUrl = deps.connectionUrl ?? relayClientUrl;
    this.createConnection =
      deps.createConnection ?? ((opts) => new RelayConnection(opts));
    this.createClient = deps.createClient ?? ((opts) => new RelayClient(opts));
  }

  /**
   * 此刻持有的**物理 WebSocket** 数：0 或 1。
   *
   * 这就是本轮那个数字（决策 10 + 13）。观测用，也被用例直接钉住。
   */
  get size(): number {
    return this.connection === null ? 0 : 1;
  }

  /** 那条连接上此刻活着的虚拟通道数。 */
  get channelCount(): number {
    return this.entries.size;
  }

  /**
   * 借一条到某个目标的通道。`target` 是 `conversation:<uuid>` 或
   * `machine:<fingerprint>`（见 relayTarget 的入口分流）。
   */
  async acquire(
    target: string,
    listener: RelayListener = {},
    options: AcquireOptions = {},
  ): Promise<RelayLease> {
    const entry = await this.entryFor(target);
    entry.listeners.add(listener);
    entry.refs++;
    this.cancelIdle(entry);

    let released = false;
    const scheduleIdle = () => this.scheduleIdle(entry);
    const ticket = this.connectionTicket;
    const lease: RelayLease = {
      get client() {
        return entry.client;
      },
      get ticket() {
        return ticket as RelayTicket;
      },
      release() {
        // 幂等：重复 release 不能把别人的引用一起扣掉。React 的 cleanup 在
        // StrictMode 下会跑两遍，这不是理论情况。
        if (released) return;
        released = true;
        entry.listeners.delete(listener);
        entry.refs--;
        if (entry.refs <= 0) scheduleIdle();
      },
    };

    if (options.waitForConnect === false) return lease;
    // 已经连着就不必等那个早已落定的首次握手：它可能是一次**失败**的首次握手，
    // 而客户端此后自己重连上了 —— 拿它判断会把一条好通道说成连不上。
    if (entry.client.state === "connected") return lease;
    try {
      await entry.ready;
    } catch (err) {
      lease.release();
      // 没人再用的失败条目当场摘掉，别让它在空闲宽限里继续被下一个人捡到。
      if (entry.refs <= 0) this.evict(entry);
      throw err;
    }
    return lease;
  }

  /**
   * 从头再连一次：换掉底下那条 socket。
   *
   * 换的是**连接**而不是某一条通道：这个账号只有一条 socket，一台机器连不上多半是
   * 它出了问题。通道与引用计数原样留着——每条通道在新 socket 上重新声明目标、重做
   * 自己的握手。
   *
   * 池子里压根没有这条通道（票根本没换到、连接没建出来）时交回 false，调用方据此
   * 退回「整只 effect 从取票重跑」那条兜底路。
   */
  async reconnect(target: string): Promise<boolean> {
    if (!this.entries.has(target) || !this.connection) return false;
    const ticket = await this.ensureTicket();
    this.connectionTicket = ticket;
    await this.connection.reconnect();
    return true;
  }

  /**
   * 收掉这条连接与它上面的全部通道。
   *
   * 生产里登出走的是整页跳转（UserMenu 的 `window.location.assign("/login")`），
   * 页面连同这条 socket 一起没了；这里是**显式**的那条拆卸路径，用例据它复位。
   */
  closeAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.cancelIdle(entry);
      entry.client.close();
    }
    this.entries.clear();
    this.pending.clear();
    this.connection?.close();
    this.connection = null;
    this.connectionTicket = null;
    this.connecting = null;
  }

  /**
   * 订阅账号信号那条保留通道（决策 13）。
   *
   * 它是这条连接的**永不释放的使用方**：订阅会把连接建起来，退订**不**关掉它。
   * 「零台机器在线时 socket 总数仍是 1」就是这么来的——空闲宽限只管普通通道。
   */
  subscribeSignals(
    onSignal: (payload: Uint8Array) => void,
    subscriber: Omit<RelaySignalSubscriber, "onSignal"> = {},
  ): () => void {
    const entry: RelaySignalSubscriber = { onSignal, ...subscriber };
    this.signalSubscribers.add(entry);
    void this.ensureConnection()
      .then(({ connection }) => {
        // 连接可能早就连上了（这条 socket 是账号级共用的）：状态变化是**事件**，
        // 后来的订阅者等不到它。不补这一下，它会一直以为信号那一路不在，于是
        // 永远跑兜底轮询——功能仍然正确，只是每 30 秒白拉一遍。
        if (connection.state === "connected")
          entry.onStateChange?.("connected");
      })
      .catch(() => {
        // 票取不到 / 连不上：信号那一路本来就允许不在，调用方退回 30 秒轮询。
        entry.onSignalClosed?.();
      });
    return () => {
      this.signalSubscribers.delete(entry);
    };
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private ensureConnection(): Promise<{
    connection: RelayConnection;
    ticket: RelayTicket;
  }> {
    if (this.connection && this.connectionTicket) {
      return Promise.resolve({
        connection: this.connection,
        ticket: this.connectionTicket,
      });
    }
    if (this.connecting) return this.connecting;
    const building = (async () => {
      const ticket = await this.ensureTicket();
      const connection = this.createConnection({
        url: this.connectionUrl(),
        jwt: ticket.accessToken,
        refreshCredentials: async () => {
          const fresh = await this.ensureTicket();
          this.connectionTicket = fresh;
          return { url: this.connectionUrl(), jwt: fresh.accessToken };
        },
        onStateChange: (state) => this.fanOutSignalState(state),
      });
      this.connection = connection;
      this.connectionTicket = ticket;
      connection.subscribeSignals({
        onSignal: (payload) => {
          for (const s of [...this.signalSubscribers]) s.onSignal?.(payload);
        },
        onSignalClosed: () => {
          for (const s of [...this.signalSubscribers]) s.onSignalClosed?.();
        },
      });
      // 握手在这里**发起**但不在这里等：等不等由每个使用方自己说。
      const ready = connection.connect();
      ready.catch(() => {});
      return { connection, ticket };
    })().finally(() => {
      this.connecting = null;
    });
    // 连不上就不留在池子里：留着的话这一屏里永远打不开，而用户手里的「重试」
    // 会变成一颗每次都复读同一句失败的按钮。
    building.catch(() => {
      this.connection = null;
      this.connectionTicket = null;
    });
    this.connecting = building;
    return building;
  }

  private fanOutSignalState(state: RelayState): void {
    for (const subscriber of [...this.signalSubscribers]) {
      subscriber.onStateChange?.(state);
    }
  }

  private entryFor(target: string): Promise<Entry> {
    const live = this.entries.get(target);
    if (live) return Promise.resolve(live);
    const inFlight = this.pending.get(target);
    if (inFlight) return inFlight;

    const building = this.open(target).finally(() => {
      this.pending.delete(target);
    });
    building.catch(() => this.entries.delete(target));
    this.pending.set(target, building);
    return building;
  }

  private async open(target: string): Promise<Entry> {
    const { connection, ticket } = await this.ensureConnection();
    const entry: Entry = {
      target,
      listeners: new Set(),
      refs: 0,
      idle: null,
      // build 要读 entry 才能扇出，所以先占位、建好再填。
      client: null as unknown as RelayClient,
      ready: Promise.resolve(),
    };
    entry.client = this.build(entry, connection, ticket);
    this.entries.set(target, entry);
    entry.ready = entry.client.connect();
    entry.ready.catch(() => {});
    return entry;
  }

  private evict(entry: Entry): void {
    this.cancelIdle(entry);
    if (this.entries.get(entry.target) !== entry) return;
    this.entries.delete(entry.target);
    entry.client.close();
  }

  /**
   * 建一条通道，并把它的四个回调接到 entry 的监听者集合上。
   *
   * 扇出读的是 `entry.listeners` 而不是构造那一刻的快照：`RelayClientOptions` 的回调
   * 是构造期单值，共享之后必须变成一个集合，否则后来的使用方要么收不到、要么把前一个
   * 覆盖掉。
   */
  private build(
    entry: Entry,
    connection: RelayConnection,
    ticket: RelayTicket,
  ): RelayClient {
    const fanout =
      <T>(pick: (l: RelayListener) => ((arg: T) => void) | undefined) =>
      (arg: T) => {
        for (const listener of [...entry.listeners]) pick(listener)?.(arg);
      };
    return this.createClient({
      connection,
      target: entry.target,
      jwt: ticket.accessToken,
      onEvent: fanout<EventFrame>((l) => l.onEvent),
      onRunResultDone: fanout<RunResultDoneFrame>((l) => l.onRunResultDone),
      onAutonomousTurnStarted: fanout<AutonomousTurnStartedFrame>(
        (l) => l.onAutonomousTurnStarted,
      ),
      onStateChange: fanout<RelayState>((l) => l.onStateChange),
    });
  }

  private scheduleIdle(entry: Entry): void {
    this.cancelIdle(entry);
    entry.idle = setTimeout(() => {
      entry.idle = null;
      // 宽限期间又有人来过就不关了：refs 是当下的真相，定时器只是个提醒。
      if (entry.refs > 0) return;
      if (this.entries.get(entry.target) !== entry) return;
      this.entries.delete(entry.target);
      entry.client.close();
    }, this.idleGraceMs);
  }

  private cancelIdle(entry: Entry): void {
    if (entry.idle === null) return;
    clearTimeout(entry.idle);
    entry.idle = null;
  }
}

/** 全应用共用的那一个池子。 */
export const relayClientPool = new RelayClientPool();

/** 借一条到某个目标的通道。用完 `release()`。 */
export function acquireRelayClient(
  target: string,
  listener?: RelayListener,
  options?: AcquireOptions,
): Promise<RelayLease> {
  return relayClientPool.acquire(target, listener, options);
}

/**
 * 借一条通道跑一次请求，跑完还回去。
 *
 * 一次性调用的那几处（技能面板 / 引擎设置 / 本地路径 / 写模型目标）用它：与此前
 * `new RelayClient(...) → connect → request → close` 的差别只有一个——它不关通道，
 * 所以详情页开着的时候这些调用直接搭现成的那条。
 */
export async function withRelayClient<T>(
  target: string,
  fn: (client: RelayClient) => Promise<T>,
): Promise<T> {
  const lease = await acquireRelayClient(target);
  try {
    return await fn(lease.client);
  } finally {
    lease.release();
  }
}
