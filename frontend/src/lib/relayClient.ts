/**
 * 浏览器中继客户端:连到 server 的 /v1/relay/client,对一台 agentred 说 wire 协议。
 *
 * 职责(测试接缝 2,Go 侧对照 internal/daemon/client/client_test.go):
 *  1. 多路复用:一个 socket 上并发多个 JSON-RPC 请求,按 id 路由响应,不串道。
 *  2. 断线补齐:自动重连后,对关注的会话 attach(显式接管)→ 按 seq 游标 pull,
 *     补齐的通知与实时通知走**同一套去重**(seq ≤ 游标即重复,只应用一次)。
 *  3. attach 幂等:同一会话重复 attach 不重复发请求,成功后走缓存。
 *
 * 传输:浏览器这条连接只发/收**裸二进制 JSON-RPC 帧**(UTF-8 字节)。channelID
 * 信封是 server 内部(relay_svc wrapEnvelope/unwrapEnvelope)的职责,浏览器不感知。
 *
 * 鉴权:设备 JWT 经 Authorization: Bearer 传给 createWebSocket。浏览器原生
 * WebSocket 无法设置自定义 header —— 默认工厂忽略 headers(真实浏览器里 token
 * 要另走服务端补的浏览器可携带机制);测试注入假工厂断言 header 正确传递。
 */
import {
  DefaultSessionPullLimit,
  MethodSessionAttach,
  MethodSessionPull,
  NotifyAutonomousTurnDone,
  NotifyAutonomousTurnEvent,
  NotifyAutonomousTurnStarted,
  NotifyEvent,
  NotifyRunResultDone,
  type EventFrame,
  type JournaledNotification,
  type RunResultDoneFrame,
  type SessionAttachResult,
  type WireFrame,
  type AutonomousTurnStartedFrame,
  decodeAutonomousTurnStartedFrame,
  decodeEventFrame,
  decodeFrame,
  decodeRunResultDoneFrame,
  decodeSessionAttachResult,
  decodeSessionPullResult,
  encodeFrame,
} from "@/lib/wire";

export type RelayState =
  "connecting" | "connected" | "disconnected" | "reconnecting";

export class RelayError extends Error {
  constructor(
    public code: number,
    message: string,
    public raw?: unknown,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export interface RelayClientOptions {
  /** ws(s)://host/v1/relay/client?daemon_fingerprint=<fp> —— 由调用方拼好。 */
  url: string;
  /** 设备 JWT → Authorization: Bearer <jwt>。 */
  jwt: string;
  /**
   * 本浏览器自己的设备指纹,随 auth.account 出示(与 Go 侧 daemon/client 的中继
   * 路径同一握手:连接建立后先 auth.account 再用 runtime.* 与 session.* 方法)。
   * 没有它 daemon 无法把这条连接认成一个对端,后续请求都被 requireAuth 拒掉。
   */
  deviceFingerprint: string;
  /** 断线自动重连(默认 true)。 */
  reconnect?: boolean;
  /** 重连退避间隔毫秒(默认 1000)。 */
  reconnectDelayMs?: number;
  /**
   * 创建 WebSocket 的工厂。默认用浏览器原生 WebSocket(忽略 headers,见文件头);
   * 测试注入假实现断言 URL / 鉴权头 / 二进制帧。
   */
  createWebSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  /** 实时与补齐的事件帧,去重后投递。 */
  onEvent?: (frame: EventFrame) => void;
  onRunResultDone?: (frame: RunResultDoneFrame) => void;
  onAutonomousTurnStarted?: (frame: AutonomousTurnStartedFrame) => void;
  onStateChange?: (state: RelayState) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

const OPEN = 1;

export class RelayClient {
  private readonly opts: Required<
    Pick<RelayClientOptions, "url" | "jwt" | "deviceFingerprint">
  > &
    RelayClientOptions;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  /** sessionId → 已收到的最后 seq(独占游标,首次 0)。 */
  private cursors = new Map<number, number>();
  /** sessionId → 本次连接已成功 attach 的结果(断线清空,重连重发)。 */
  private attached = new Map<number, SessionAttachResult>();
  /** 正在 attach 的请求(in-flight 幂等)。 */
  private attaching = new Map<number, Promise<SessionAttachResult>>();
  /** 关注名单:断线重连后逐个补齐。 */
  private watched = new Set<number>();
  /**
   * sessionId → 正在进行的补齐。页面发起的补齐与跳号触发的补洞共用同一条队列:
   * 同一会话任一时刻至多一串 pull 在飞,不让两串翻页互相踩游标。
   */
  private catchingUp = new Map<number, Promise<void>>();
  /** 补齐进行中又收到跳号帧的会话:这一串补完之后再补一轮,而不是并发发第二串。 */
  private refill = new Set<number>();
  /**
   * sessionId → 该会话的 origin 对端指纹(别的对端发起的会话才有)。
   *
   * daemon 上的会话键是 (发起端指纹, 会话 id),而 ResolveSessionPeer 的入口约定是
   * 「省略 origin = 调用方自己的对端」。清单(SessionSummary.peerFingerprint)是客户端
   * 学 origin 的唯一来源,学到之后必须原样带回此后每一次 attach / pull / 控制请求 ——
   * 否则接的是本浏览器名下那条同号空会话。断线重连要重发 attach,因此这里记着它。
   */
  private origins = new Map<number, string>();
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private currentState: RelayState = "disconnected";

  constructor(opts: RelayClientOptions) {
    this.opts = {
      reconnect: true,
      reconnectDelayMs: 1000,
      ...opts,
    };
  }

  /**
   * 向 daemon 出示账号凭据,把它认成本浏览器的对端(auth.account,与 Go 侧
   * daemon/client 的中继路径同一握手)。必须在任何 runtime.* 与 session.* 之前完成 ——
   * daemon 对非 auth.* 方法一律 requireAuth。
   */
  private authenticate(): Promise<unknown> {
    return this.request("auth.account", {
      credential: this.opts.jwt,
      deviceFingerprint: this.opts.deviceFingerprint,
    });
  }

  get state(): RelayState {
    return this.currentState;
  }

  private setState(state: RelayState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.opts.onStateChange?.(state);
  }

  /** 建立(或重连)WebSocket;已在连接中时返回同一个 promise。 */
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.closedByUser = false;
    this.setState("connecting");
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const headers = { Authorization: `Bearer ${this.opts.jwt}` };
      const factory =
        this.opts.createWebSocket ?? ((url: string) => new WebSocket(url));
      const ws = factory(this.opts.url, headers);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        // 连接建立 ≠ 可用。daemon 对非 auth.* 方法一律 requireAuth,而 auth.account
        // 与随后的 session.* / runtime.* 是并发处理的 —— 在握手返回前就把 relayState
        // 置 connected,页面会立刻发 session.list,抢在 auth.account 之前到达 daemon
        // 被 Unauthorized 拒掉(实测竞态)。所以「connected」只在 auth.account 成功后才
        // 对外暴露,connect() 也只在此时 resolve;消费者的 session.* 请求因此必然晚于
        // 握手完成,不再抢跑。
        void this.authenticate()
          .then(() => {
            this.setState("connected");
            resolve();
          })
          .catch((err) => {
            this.connectPromise = null;
            reject(
              err instanceof RelayError
                ? err
                : new RelayError(-1, "relay: auth.account 失败", err),
            );
            // 握手失败:关掉这条未认证的连接,走 handleClose → reconnecting → 自动
            // 重连,页面据此触发 R11 探测(被吊销 / 账号不匹配 / 凭据过期)。
            ws.close();
          });
      };
      ws.onerror = () => {
        // 尚未 open 就出错:让 connect() 失败,并清掉 connectPromise,使下一次
        // 重试能真正新建连接(否则重连会一直拿到同一个已拒绝的 promise)。
        if (ws.readyState !== OPEN) {
          this.connectPromise = null;
          reject(new RelayError(-1, "relay: WebSocket 连接失败", null));
        }
      };
      ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
      ws.onclose = () => {
        // 只有**当前**这条 socket 的收尾才作数:连接失败重试时,被换掉的旧
        // socket 的 close 事件总在新连接建立之后才到。照单全收会把一条刚连上的
        // 连接判成断线 —— 未决请求被拒、状态翻成 disconnected,页面当场「连不上」。
        if (this.ws !== ws) return;
        this.ws = null;
        this.connectPromise = null;
        this.handleClose();
      };
    });
    return this.connectPromise;
  }

  /** 主动关闭,不再自动重连。 */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    // 浏览器的 ws.close() 不同步回调 onclose,而那条迟到的 onclose 已经不属于
    // 当前 socket、不会再跑收尾。connectPromise 就地清掉,否则下一次 connect()
    // 直接拿到这个已结束的 promise —— 客户端没有 socket 却自称连着。
    this.connectPromise = null;
    this.failPending(new RelayError(-1, "relay: 客户端已关闭", null));
    this.setState("disconnected");
  }

  /** 发一个 JSON-RPC 请求(带 id),响应/错误按 id 路由回来。 */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(String(id), { method, resolve, reject });
      try {
        this.sendFrame({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(String(id));
        reject(err);
      }
    });
  }

  /** 发一个无 id 的 JSON-RPC 通知(不带响应)。 */
  notify(method: string, params?: unknown): void {
    this.sendFrame({ jsonrpc: "2.0", method, params });
  }

  /**
   * 显式接管一条会话(幂等):成功后该会话进入关注名单,断线重连自动补齐。
   * 重复调用(含并发)不重复发请求。
   */
  attach(
    sessionId: number,
    peerFingerprint?: string,
  ): Promise<SessionAttachResult> {
    const origin = this.rememberOrigin(sessionId, peerFingerprint);
    const cached = this.attached.get(sessionId);
    if (cached) return Promise.resolve(cached);
    const inflight = this.attaching.get(sessionId);
    if (inflight) return inflight;
    const p = (async (): Promise<SessionAttachResult> => {
      const result = await this.request(MethodSessionAttach, {
        sessionId,
        ...(origin ? { peerFingerprint: origin } : {}),
      });
      const decoded = decodeSessionAttachResult(result);
      this.attached.set(sessionId, decoded);
      this.watched.add(sessionId);
      return decoded;
    })();
    this.attaching.set(sessionId, p);
    void p.then(
      () => this.attaching.delete(sessionId),
      () => this.attaching.delete(sessionId),
    );
    return p;
  }

  /**
   * 按 seq 游标补齐一条会话:attach → pull 翻页直到 HasMore=false。
   * 补齐的通知与实时同一套去重(seq ≤ 游标即丢弃、seq > 游标+1 即跳号)。
   *
   * 同一会话的补齐串行:已有一串在飞时复用它,并记下「补完再补一轮」——
   * 跳号触发的补洞与页面发起的补齐因此不会并发翻页、互相踩游标。
   */
  catchUp(sessionId: number, peerFingerprint?: string): Promise<void> {
    const origin = this.rememberOrigin(sessionId, peerFingerprint);
    const running = this.catchingUp.get(sessionId);
    if (running) {
      this.refill.add(sessionId);
      return running;
    }
    const p = this.pullUntilCaughtUp(sessionId, origin).finally(() => {
      this.catchingUp.delete(sessionId);
      // 这一串期间又出现过跳号:那一段还没补上,再补一轮(游标已推进,不会原地打转)。
      if (this.refill.delete(sessionId)) {
        void this.catchUp(sessionId).catch(() => {
          // 补洞失败保持关注,下一条实时帧 / 下次重连再试。
        });
      }
    });
    this.catchingUp.set(sessionId, p);
    return p;
  }

  private async pullUntilCaughtUp(
    sessionId: number,
    origin: string | undefined,
  ): Promise<void> {
    await this.attach(sessionId, origin);
    for (;;) {
      const sentCursor = this.cursors.get(sessionId) ?? 0;
      const raw = await this.request(MethodSessionPull, {
        sessionId,
        ...(origin ? { peerFingerprint: origin } : {}),
        cursor: sentCursor,
        limit: DefaultSessionPullLimit,
      });
      const res = decodeSessionPullResult(raw);
      // OldestSeq 复位:本次拉取用的游标落后于留存窗口(老前缀已被回收)时,把游标
      // 推到现存最老那一行的前一位(那截尾巴是真的没有了)。复位必须在应用这一页
      // **之前** —— 否则这一页的第一条当场被判成跳号丢掉,一条也交付不出去。
      if (
        res.oldestSeq !== undefined &&
        res.oldestSeq > 0 &&
        sentCursor < res.oldestSeq - 1
      ) {
        this.cursors.set(sessionId, res.oldestSeq - 1);
      }
      for (const n of res.notifications ?? []) {
        this.applyJournaled(n);
      }
      // 游标只由「应用了哪些行」推进(复位除外):照 res.cursor 盖上去会把这一页里
      // 交付不出去的行也算成已消费。
      const applied = this.cursors.get(sessionId) ?? 0;
      // 防自旋:没有更多页,或游标没有推进(空页且未复位),不能无限重拉同一页。
      if (!res.hasMore || applied <= sentCursor) break;
    }
  }

  /**
   * 记住(并回读)一条会话的 origin 指纹。传入空值时沿用已记住的那一个 —— 重连后的
   * 自动补齐、以及页面上后续的 pull 都不必再把它带一遍。
   */
  private rememberOrigin(
    sessionId: number,
    peerFingerprint?: string,
  ): string | undefined {
    const fp = peerFingerprint?.trim();
    if (fp) this.origins.set(sessionId, fp);
    return this.origins.get(sessionId);
  }

  /** 一条会话的 origin 对端指纹(自己发起的会话为 undefined)。 */
  originOf(sessionId: number): string | undefined {
    return this.origins.get(sessionId);
  }

  getCursor(sessionId: number): number {
    return this.cursors.get(sessionId) ?? 0;
  }

  /** 由外部(如持久化恢复)设置会话游标。 */
  setCursor(sessionId: number, seq: number): void {
    this.cursors.set(sessionId, seq);
  }

  // ── 内部:发送 / 接收 ────────────────────────────────────────────────────

  private sendFrame(frame: WireFrame): void {
    if (!this.ws || this.ws.readyState !== OPEN) {
      throw new RelayError(-1, "relay: 连接未就绪", null);
    }
    const bytes = new TextEncoder().encode(encodeFrame(frame));
    this.ws.send(bytes.buffer);
  }

  private handleMessage(data: unknown): void {
    let frame: WireFrame;
    try {
      frame = decodeFrame(JSON.parse(decodeBinary(data)));
    } catch {
      // 单帧坏掉不影响连接:丢掉继续等下一帧。
      return;
    }
    if (frame.method) {
      this.dispatchNotification(frame);
      return;
    }
    const id =
      frame.id === null || frame.id === undefined ? "" : String(frame.id);
    const entry = this.pending.get(id);
    if (!entry) {
      // 迟到 / 未知 id 的响应(已被 close 拒绝):丢弃。
      return;
    }
    this.pending.delete(id);
    if (frame.error) {
      entry.reject(
        new RelayError(frame.error.code, frame.error.message, frame.error),
      );
    } else {
      entry.resolve(frame.result);
    }
  }

  private dispatchNotification(frame: WireFrame): void {
    try {
      switch (frame.method) {
        case NotifyEvent:
        case NotifyAutonomousTurnEvent: {
          const ev = decodeEventFrame(frame.params);
          this.applyDedup(ev.sessionId, ev.seq, () => this.opts.onEvent?.(ev));
          return;
        }
        case NotifyRunResultDone:
        case NotifyAutonomousTurnDone: {
          const done = decodeRunResultDoneFrame(frame.params);
          this.applyDedup(done.sessionId, done.seq, () =>
            this.opts.onRunResultDone?.(done),
          );
          return;
        }
        case NotifyAutonomousTurnStarted: {
          const started = decodeAutonomousTurnStartedFrame(frame.params);
          this.applyDedup(started.sessionId, started.seq, () =>
            this.opts.onAutonomousTurnStarted?.(started),
          );
          return;
        }
      }
    } catch {
      // 载荷解不动:不投递,但照样占掉这一格 seq(见 skipSeq),不让一条坏帧
      // 把它后面的整段转录卡在补洞里。
    }
    this.skipSeq(frame.params);
  }

  /**
   * 一条交付不出去的通知(本客户端不认识的 method / 载荷解不动)照样占掉它那一格
   * 游标。不占的话,它后面的每一条已知通知都会被判成跳号 → 触发补洞 → 拉回同一页 →
   * 又卡在这一条上,补齐原地打转、后面的转录永远交付不出去(与 Go 侧
   * remote/reconnect.go 的 skipSeq 同一条纪律)。
   */
  private skipSeq(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const head = params as { sessionId?: unknown; seq?: unknown };
    if (typeof head.sessionId !== "number" || typeof head.seq !== "number") {
      return;
    }
    this.applyDedup(head.sessionId, head.seq, () => {
      // 占位:这一格已被消费,但没有可投递的内容。
    });
  }

  /**
   * seq 闸门(与 Go 侧 remote/reconnect.go 的 dispatchNotification 同一套规则):
   *   - seq == 游标 + 1 → 消费并推进游标;
   *   - seq >  游标 + 1 → **跳号**:不消费,改从游标发起一次补齐,补平后再顺序交付。
   *     直接推进游标会把中间那一段判成「重复」永久丢掉 —— 打开一条正在跑的会话时,
   *     attach 之后的第一条实时帧 seq 远高于本地游标(浏览器刚打开,游标是 0),
   *     用户看到的转录会从半截开始;
   *   - seq <= 游标      → 重复投递,丢弃。
   * 老 daemon 不带 seq(可选追加字段)时无游标可言,一律投递。
   */
  private applyDedup(
    sessionId: number,
    seq: number | undefined,
    deliver: () => void,
  ): void {
    if (seq === undefined || seq === 0) {
      deliver();
      return;
    }
    const cursor = this.cursors.get(sessionId) ?? 0;
    if (seq <= cursor) return;
    if (seq > cursor + 1) {
      void this.catchUp(sessionId).catch(() => {
        // 补洞失败保持关注,下一条实时帧 / 下次重连再试。
      });
      return;
    }
    this.cursors.set(sessionId, seq);
    deliver();
  }

  /** 补齐页里的一条通知:按 method 解成帧、把日志行上的 seq 盖上去,再走同一套去重投递。 */
  private applyJournaled(n: JournaledNotification): void {
    let frame: WireFrame;
    try {
      frame = decodeFrame({
        jsonrpc: "2.0",
        method: n.method,
        params: n.params,
      });
    } catch {
      return;
    }
    if (frame.params && typeof frame.params === "object") {
      (frame.params as Record<string, unknown>).seq = n.seq;
    }
    this.dispatchNotification(frame);
  }

  private handleClose(): void {
    this.attached.clear();
    this.attaching.clear();
    this.failPending(new RelayError(-1, "relay: 连接已断开", null));
    if (this.closedByUser || this.opts.reconnect === false) {
      this.setState("disconnected");
      return;
    }
    this.setState("reconnecting");
    this.scheduleReconnect();
  }

  private failPending(err: RelayError): void {
    for (const [, entry] of this.pending) {
      entry.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, this.opts.reconnectDelayMs ?? 1000);
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connect();
      // 重连后:对关注的会话逐个 attach(新连接需重发)→ 按游标补齐。
      // 单条会话补齐失败不阻断其它会话。
      for (const sid of this.watched) {
        try {
          await this.catchUp(sid);
        } catch {
          // 该会话补齐失败,保持关注,下一条 / 下次重连再试。
        }
      }
    } catch {
      this.scheduleReconnect();
    }
  }
}

function decodeBinary(data: unknown): string {
  if (typeof data === "string") return data;
  // 用 Object.prototype.toString 判定而不是 instanceof ArrayBuffer:跨 realm(如
  // jsdom 测试环境)的 ArrayBuffer 对 instanceof 是 false,但字节内容完全合法。
  if (
    data instanceof ArrayBuffer ||
    Object.prototype.toString.call(data) === "[object ArrayBuffer]"
  ) {
    return new TextDecoder().decode(data as ArrayBuffer);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  // jsdom / 某些环境把二进制包成 {data: ArrayBuffer}。
  if (data && typeof data === "object" && "data" in data) {
    return decodeBinary((data as { data: unknown }).data);
  }
  throw new TypeError("relay: 无法解码收到的二进制帧");
}
