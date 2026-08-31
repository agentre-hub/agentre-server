/**
 * 一台机器一条中继 WebSocket。
 *
 * 为什么需要它:`RelayClient` 自己在一条 socket 上按 request id 多路复用，可那是
 * **一条连接之内**的复用；跨功能没有任何东西在管。此前详情页、目录选择器、技能面板、
 * 引擎设置、派发各自 `new RelayClient`，于是同一台 agentred 在同一个页面上会有好几条
 * 物理连接，每条都要重取一次票、重升级一次 WS、再重握一次 `auth.account`——而 daemon
 * 那端本来就是一条链路多路复用所有虚拟通道的（relaytransport.Multiplexer），多开的
 * 这几条纯粹是浏览器这侧自己加的。
 *
 * 形状照 Go 侧的 `remote_device_svc.ConnPool`：按目标引用计数，最后一个使用方走了
 * 之后**不立刻关**，留一段空闲宽限。一次性调用（点开一次技能面板）因此不会在连接
 * 刚建好就把它关掉，紧接着的下一次又从取票重来。
 *
 * 关连接的权力只在池子手里。使用方拿到的是一份租约，`release()` 说的是「我不用了」，
 * 不是「关掉它」——旧代码里那些 `finally { client.close() }` 一旦共享就会把别人正在
 * 收事件的连接关掉。
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
import { ensureRelayTicket, type RelayTicket } from "@/lib/relayTicket";
import { relayClientUrl } from "@/lib/relayUrl";

/** 空闲宽限：与 Go 侧 ConnPool 的 idleTimeout 同值。 */
const DEFAULT_IDLE_GRACE_MS = 30_000;

/**
 * 一个使用方的收件口。全是可选的：一次性调用只是想借条连接发个请求，什么都不听。
 */
export interface RelayListener {
  onEvent?: (frame: EventFrame) => void;
  onRunResultDone?: (frame: RunResultDoneFrame) => void;
  onAutonomousTurnStarted?: (frame: AutonomousTurnStartedFrame) => void;
  onStateChange?: (state: RelayState) => void;
  /**
   * 连接被重建（手动重连）时交出新的那一条。
   *
   * 有这一条，`reconnect()` 才不会把同一台机器上**别的**使用方甩下：不然它手里那份
   * 租约会指着一条已经关掉的连接，而它自己的 effect 依赖没变、不会重新 acquire。
   */
  onClient?: (client: RelayClient) => void;
}

/** 一份租约。`client` 是取值器：重连换掉底下那条时，租约照样指向当前那一条。 */
export interface RelayLease {
  readonly client: RelayClient;
  readonly ticket: RelayTicket;
  release(): void;
}

export interface RelayClientPoolDeps {
  idleGraceMs?: number;
  ensureTicket?: () => Promise<RelayTicket>;
  /**
   * 只按指纹拼 URL。票**不在** URL 上 —— 它走子协议（见 relayUrl.ts），所以这里
   * 不再需要它。
   */
  clientUrl?: (fingerprint: string) => string;
  createClient?: (opts: RelayClientOptions) => RelayClient;
}

export interface AcquireOptions {
  /**
   * 等这条连接**握完手**再交出租约，默认 true。
   *
   * 一次性调用要 true：拿到就发请求，没连上等于白发。长连接的使用方（详情页）要
   * false —— 它不等，拿到 client 就挂上去，首次连不上交给 `RelayClient` 自己退避
   * 重连、页面从 `onStateChange` 读到 "reconnecting"。等连上再交付会把这条路堵死：
   * 首次失败当场被说成 "disconnected"（横幅写「已经不再自动重试」），而它明明正在
   * 重试。
   */
  waitForConnect?: boolean;
}

interface Entry {
  fingerprint: string;
  client: RelayClient;
  ticket: RelayTicket;
  listeners: Set<RelayListener>;
  refs: number;
  idle: ReturnType<typeof setTimeout> | null;
  /** 当前这条连接的首次握手。`waitForConnect` 那一档等的就是它。 */
  ready: Promise<void>;
}

export class RelayClientPool {
  private readonly idleGraceMs: number;
  private readonly ensureTicket: () => Promise<RelayTicket>;
  private readonly clientUrl: (fingerprint: string) => string;
  private readonly createClient: (opts: RelayClientOptions) => RelayClient;

  private readonly entries = new Map<string, Entry>();
  /** 正在建的那一条。并发 acquire 共用它，不抢建第二条。 */
  private readonly pending = new Map<string, Promise<Entry>>();

  constructor(deps: RelayClientPoolDeps = {}) {
    this.idleGraceMs = deps.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.ensureTicket = deps.ensureTicket ?? ensureRelayTicket;
    this.clientUrl = deps.clientUrl ?? relayClientUrl;
    this.createClient = deps.createClient ?? ((opts) => new RelayClient(opts));
  }

  /** 池子里此刻活着的连接数。观测用。 */
  get size(): number {
    return this.entries.size;
  }

  async acquire(
    fingerprint: string,
    listener: RelayListener = {},
    options: AcquireOptions = {},
  ): Promise<RelayLease> {
    const entry = await this.entryFor(fingerprint);
    entry.listeners.add(listener);
    entry.refs++;
    this.cancelIdle(entry);

    let released = false;
    const scheduleIdle = () => this.scheduleIdle(entry);
    const lease: RelayLease = {
      get client() {
        return entry.client;
      },
      get ticket() {
        return entry.ticket;
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
    // 而客户端此后自己重连上了 —— 拿它判断会把一条好连接说成连不上。
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
   * 从头再连一次：关掉当前这条，重取票、重建，并把新的交给还在场的每个监听者。
   *
   * 引用计数与监听者集合原样留着——「重连」换的是底下那条 socket，不是「大家都不用了」。
   */
  async reconnect(fingerprint: string): Promise<boolean> {
    const entry = this.entries.get(fingerprint);
    if (!entry) return false;
    const superseded = entry.client;
    const ticket = await this.ensureTicket();
    entry.ticket = ticket;
    // 先换上新的、再关掉旧的：反过来的话，旧那条 close 播出的 "disconnected"
    // 此刻还被认作现役，会盖掉调用方刚说出口的「正在连」。
    entry.client = this.build(entry, ticket);
    superseded.close();
    entry.ready = entry.client.connect();
    entry.ready.catch(() => {});
    for (const listener of [...entry.listeners])
      listener.onClient?.(entry.client);
    return true;
  }

  /** 收掉全部连接（登出）。 */
  closeAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.cancelIdle(entry);
      entry.client.close();
    }
    this.entries.clear();
    this.pending.clear();
  }

  private entryFor(fingerprint: string): Promise<Entry> {
    const live = this.entries.get(fingerprint);
    if (live) return Promise.resolve(live);
    const inFlight = this.pending.get(fingerprint);
    if (inFlight) return inFlight;

    const building = this.open(fingerprint).finally(() => {
      this.pending.delete(fingerprint);
    });
    // 连不上就不留在池子里：留着的话这台机器在这一屏里永远打不开，而用户手里的
    // 「重试」会变成一颗每次都复读同一句失败的按钮。
    building.catch(() => this.entries.delete(fingerprint));
    this.pending.set(fingerprint, building);
    return building;
  }

  private async open(fingerprint: string): Promise<Entry> {
    const ticket = await this.ensureTicket();
    const entry: Entry = {
      fingerprint,
      ticket,
      listeners: new Set(),
      refs: 0,
      idle: null,
      // build 要读 entry 才能扇出，所以先占位、建好再填。
      client: null as unknown as RelayClient,
      ready: Promise.resolve(),
    };
    entry.client = this.build(entry, ticket);
    this.entries.set(fingerprint, entry);
    // 握手在这里**发起**但不在这里等：等不等由每个使用方自己说（AcquireOptions）。
    // 先挂一个空 catch，否则没人等的那一档会留下一个未处理的拒绝。
    entry.ready = entry.client.connect();
    entry.ready.catch(() => {});
    return entry;
  }

  private evict(entry: Entry): void {
    this.cancelIdle(entry);
    if (this.entries.get(entry.fingerprint) !== entry) return;
    this.entries.delete(entry.fingerprint);
    entry.client.close();
  }

  /**
   * 建一条连接，并把它的四个回调接到 entry 的监听者集合上。
   *
   * 扇出读的是 `entry.listeners` 而不是构造那一刻的快照：`RelayClientOptions` 的回调
   * 是构造期单值，共享之后必须变成一个集合，否则后来的使用方要么收不到、要么把前一个
   * 覆盖掉。
   */
  private build(entry: Entry, ticket: RelayTicket): RelayClient {
    // 这一条自己是谁。扇出前先问「我还是现役吗」——被 reconnect 顶替掉的那条
    // 随后会收到自己的 close，而 close 会播一次 "disconnected"。那一声要是照发，
    // 详情页刚设成 "connecting" 的状态当场被改写成红色终态，说的和用户按的按钮
    // 恰好相反。被顶替的连接说什么都不再作数，通知同理。
    const self: { client: RelayClient | null } = { client: null };
    const fanout =
      <T>(pick: (l: RelayListener) => ((arg: T) => void) | undefined) =>
      (arg: T) => {
        if (entry.client !== self.client) return;
        for (const listener of [...entry.listeners]) pick(listener)?.(arg);
      };
    self.client = this.createClient({
      url: this.clientUrl(entry.fingerprint),
      jwt: ticket.accessToken,
      deviceFingerprint: ticket.clientId,
      refreshCredentials: async () => {
        const fresh = await this.ensureTicket();
        entry.ticket = fresh;
        return {
          url: this.clientUrl(entry.fingerprint),
          jwt: fresh.accessToken,
        };
      },
      onEvent: fanout<EventFrame>((l) => l.onEvent),
      onRunResultDone: fanout<RunResultDoneFrame>((l) => l.onRunResultDone),
      onAutonomousTurnStarted: fanout<AutonomousTurnStartedFrame>(
        (l) => l.onAutonomousTurnStarted,
      ),
      onStateChange: fanout<RelayState>((l) => l.onStateChange),
    });
    return self.client;
  }

  private scheduleIdle(entry: Entry): void {
    this.cancelIdle(entry);
    entry.idle = setTimeout(() => {
      entry.idle = null;
      // 宽限期间又有人来过就不关了：refs 是当下的真相，定时器只是个提醒。
      if (entry.refs > 0) return;
      if (this.entries.get(entry.fingerprint) !== entry) return;
      this.entries.delete(entry.fingerprint);
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

/** 借一条到这台机器的中继连接。用完 `release()`。 */
export function acquireRelayClient(
  fingerprint: string,
  listener?: RelayListener,
  options?: AcquireOptions,
): Promise<RelayLease> {
  return relayClientPool.acquire(fingerprint, listener, options);
}

/**
 * 借一条连接跑一次请求，跑完还回去。
 *
 * 一次性调用的那几处（技能面板 / 引擎设置 / 本地路径 / 写模型目标）用它：与此前
 * `new RelayClient(...) → connect → request → close` 的差别只有一个——它不关连接，
 * 所以详情页开着的时候这些调用直接搭现成的那条。
 */
export async function withRelayClient<T>(
  fingerprint: string,
  fn: (client: RelayClient) => Promise<T>,
): Promise<T> {
  const lease = await acquireRelayClient(fingerprint);
  try {
    return await fn(lease.client);
  } finally {
    lease.release();
  }
}
