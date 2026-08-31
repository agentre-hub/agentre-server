/**
 * 浏览器中继客户端:连到 server 的 /v1/relay/client,对一台 agentred 说 wire 协议。
 *
 * 职责(测试接缝 2,Go 侧对照 internal/daemon/client/client_test.go):
 *  1. 多路复用:一个 socket 上并发多个 typed Protobuf RPC 请求,按 id 路由响应,不串道。
 *  2. 断线补齐:自动重连后,对关注的会话 attach(显式接管)→ 按 seq 游标 pull,
 *     补齐的通知与实时通知走**同一套去重**(seq ≤ 游标即重复,只应用一次)。
 *  3. attach 幂等:同一会话重复 attach 不重复发请求,成功后走缓存。
 *
 * 传输:浏览器通过 `agentre-protobuf` 子协议只发/收 Protobuf RpcFrame。channelID
 * 信封是 server 内部(relay_svc wrapEnvelope/unwrapEnvelope)的职责,浏览器不感知。
 *
 * 鉴权:设备 JWT 经 Authorization: Bearer 传给 createWebSocket。浏览器原生
 * WebSocket 无法设置自定义 header —— 默认工厂忽略 headers(真实浏览器里 token
 * 要另走服务端补的浏览器可携带机制);测试注入假工厂断言 header 正确传递。
 */
import {
  DefaultSessionPullLimit,
  PROTOCOL_VERSION,
  type AnyRpcMethod,
  type EventFrame,
  type JournaledNotification,
  type RunResultDoneFrame,
  type SessionAttachResult,
  type AutonomousTurnStartedFrame,
  type ProtobufRpcFrame,
  type RuntimeEventNotificationFrame,
  type EventKind,
  EventAskUserQuestion,
  EventAskUserQuestionAnswered,
  EventCompactBoundary,
  EventContextWindowUpdated,
  EventDone,
  EventError,
  EventExecApprovalRequested,
  EventExecApprovalResolved,
  EventOutputActivity,
  EventPermissionModeChanged,
  EventPlanUpdated,
  EventRetry,
  EventRuntimeStatus,
  EventSteerConsumed,
  EventSubagentDone,
  EventSubagentModel,
  EventSubagentProgress,
  EventSubagentStarted,
  EventTextDelta,
  EventThinkingDelta,
  EventToolPermissionRequest,
  EventToolPermissionResolved,
  EventToolResult,
  EventToolUseStart,
  EventUsage,
  EventUnrecognizedBlock,
  EventUserMessage,
  NotifyAutonomousTurnDone,
  NotifyAutonomousTurnEvent,
  NotifyAutonomousTurnStarted,
  NotifyEvent,
  NotifyRunResultDone,
  ProtobufRpcCodec,
  encodeRpcCancel,
  encodeRpcMethodRequest,
  rpcMethods,
} from "@agentre-hub/agentre-wire";
import type { MessageInitShape, MessageShape } from "@bufbuild/protobuf";

import { RedialTimer } from "@/lib/redialTimer";

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

/**
 * 通知的三个投递口。RelayClientOptions 自己就是它的一个实现 —— 因此 server 镜像交出
 * 的历史帧走的是**与实时同一条**解帧与投递路径(applyJournalFrames),而不是另写一份。
 */
export interface NotificationHandlers {
  /** 实时与补齐的事件帧,去重后投递。 */
  onEvent?: (frame: EventFrame) => void;
  onRunResultDone?: (frame: RunResultDoneFrame) => void;
  onAutonomousTurnStarted?: (frame: AutonomousTurnStartedFrame) => void;
}

export interface RelayClientOptions extends NotificationHandlers {
  /** ws(s)://host/v1/relay/client?daemon_fingerprint=<fp> —— 由调用方拼好。 */
  url: string;
  /** 设备 JWT → Authorization: Bearer <jwt>。 */
  jwt: string;
  /** 断线重连前换取新的短效凭据，同时更新 query token 与握手 JWT。 */
  refreshCredentials?: () => Promise<{ url: string; jwt: string }>;
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
  createWebSocket?: (
    url: string,
    headers: Record<string, string>,
    protocols: string[],
  ) => WebSocket;
  onStateChange?: (state: RelayState) => void;
}

interface PendingRequest {
  method: AnyRpcMethod;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  cleanup?: () => void;
}

const OPEN = 1;
const PROTOBUF_SUBPROTOCOL = "agentre-protobuf";

/**
 * 一条会话在本客户端这边的全部状态。身份是 (origin, sessionId) 这一对,见
 * RelayClient.sessions 的注释。
 */
interface SessionState {
  readonly sessionId: number;
  /**
   * 发起端指纹。空串 = 「调用方自己的对端」—— 那是 wire 上**省略 origin** 的含义
   * (ResolveSessionPeer),是一个确定的身份,不是「任意」或「还不知道」。
   */
  readonly origin: string;
  /** 已收到的最后 seq(独占游标,首次 0)。 */
  cursor: number;
  /** 本次连接已成功 attach 的结果(断线清空,重连重发)。 */
  attached: SessionAttachResult | null;
  /** 正在飞的 attach 请求(in-flight 幂等)。 */
  attaching: Promise<SessionAttachResult> | null;
  /**
   * 正在进行的补齐。页面发起的补齐与跳号触发的补洞共用同一条队列:同一条会话任一
   * 时刻至多一串 pull 在飞,不让两串翻页互相踩游标。
   */
  catchingUp: Promise<void> | null;
  /** 补齐进行中又收到跳号帧:这一串补完之后再补一轮,而不是并发发第二串。 */
  refill: boolean;
  /** 在关注名单上:断线重连后自动补齐。 */
  watched: boolean;
}

/** 会话表的键。origin 在前,空串是「调用方自己的对端」那个确定身份。 */
function sessionKey(sessionId: number, origin: string): string {
  return `${origin}\u0000${sessionId}`;
}

export class RelayClient {
  private readonly opts: Required<
    Pick<RelayClientOptions, "url" | "jwt" | "deviceFingerprint">
  > &
    RelayClientOptions;
  private ws: WebSocket | null = null;
  private nextId = 1n;
  private pending = new Map<string, PendingRequest>();
  /**
   * 每条会话在本客户端这边的全部状态,按 **(发起端指纹, 会话 id)** 索引。
   *
   * 键必须是这一对,不能只是会话 id:daemon 上会话的键就是这一对
   * (ResolveSessionPeer),而会话 id 是**各端本地从 1 自增**的 —— 一台机器上同时挂着
   * 别的对端发起的同号会话是常态(会话清单列的是这台机器上的**全部**会话)。
   * 少了 origin 那一半,同一条连接上换看同号的另一条对话就会读到上一条的游标与
   * attach 结果:attach 命中缓存(新那条从来没被接管过、交回来的 latestSeq 是上一条
   * 的高水位),pull 又带着上一条的游标出发 —— 新那条比旧那条短时一行都拉不回来,
   * 页面整个空白,而且没有任何报错。
   */
  private sessions = new Map<string, SessionState>();
  /**
   * 会话 id → 此刻该由哪条会话消费这个 id 的**实时帧**。
   *
   * 实时通知(EventFrame)线上只带 `{sessionId, event, seq}`,**不带发起端指纹**,
   * 所以同号的两条会话在实时流上本身就分不开 —— 这是 wire 的缺口,不是这里能补的。
   * 本客户端的取舍:最后一次 attach 的那条赢。详情页一次只看一条对话,因此这与
   * 「用户正在看的那条」一致。真要根治得让 EventFrame 带上 origin(在 agentre 仓)。
   */
  private liveBySessionId = new Map<number, SessionState>();
  private closedByUser = false;
  private readonly redial = new RedialTimer();
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
   *
   * protocolVersion 是握手的一部分而不是可选装饰:对端按**精确匹配**校验,并且把
   * 空版本判成「对端太旧」(proto3 下缺字段与显式空串同为零值)。不带它 = 每一次
   * 建连都在 auth.account 上被拒 = 浏览器端整个不可用。版本取自 wire 包导出的
   * 常量,与本次编译进来的 schema 同源。
   */
  private authenticate(): Promise<unknown> {
    return this.request(rpcMethods.authAccount, {
      credential: this.opts.jwt,
      deviceFingerprint: this.opts.deviceFingerprint,
      protocolVersion: PROTOCOL_VERSION,
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
        this.opts.createWebSocket ??
        ((url: string, _headers: Record<string, string>, protocols: string[]) =>
          new WebSocket(url, protocols));
      const ws = factory(this.opts.url, headers, [PROTOBUF_SUBPROTOCOL]);
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
    this.redial.cancel();
    this.ws?.close();
    this.ws = null;
    // 浏览器的 ws.close() 不同步回调 onclose,而那条迟到的 onclose 已经不属于
    // 当前 socket、不会再跑收尾。connectPromise 就地清掉,否则下一次 connect()
    // 直接拿到这个已结束的 promise —— 客户端没有 socket 却自称连着。
    this.connectPromise = null;
    this.failPending(new RelayError(-1, "relay: 客户端已关闭", null));
    this.setState("disconnected");
  }

  request<M extends AnyRpcMethod>(
    method: M,
    params: MessageInitShape<M["request"]>,
    options: { signal?: AbortSignal } = {},
  ): Promise<MessageShape<M["response"]>> {
    const id = this.nextId++;
    return new Promise<MessageShape<M["response"]>>((resolve, reject) => {
      const abort = () => {
        const entry = this.pending.get(String(id));
        if (!entry) return;
        this.pending.delete(String(id));
        this.sendBytes(encodeRpcCancel(this.nextId++, id));
        reject(new DOMException("relay request aborted", "AbortError"));
      };
      if (options.signal?.aborted) {
        reject(new DOMException("relay request aborted", "AbortError"));
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(String(id), {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => options.signal?.removeEventListener("abort", abort),
      });
      try {
        this.sendBytes(encodeRpcMethodRequest(id, method, params));
      } catch (err) {
        this.pending.delete(String(id));
        options.signal?.removeEventListener("abort", abort);
        reject(err);
      }
    });
  }

  /**
   * 显式接管一条会话(幂等):成功后该会话进入关注名单,断线重连自动补齐。
   * 重复调用(含并发)不重复发请求。
   */
  attach(
    sessionId: number,
    peerFingerprint?: string,
  ): Promise<SessionAttachResult> {
    const st = this.stateOf(sessionId, peerFingerprint);
    // 实时帧只带会话 id,认不出发起端:最后接管的那条赢(见 liveBySessionId)。
    this.liveBySessionId.set(sessionId, st);
    if (st.attached) return Promise.resolve(st.attached);
    if (st.attaching) return st.attaching;
    const p = (async (): Promise<SessionAttachResult> => {
      const result = await this.request(rpcMethods.sessionAttach, {
        sessionId: BigInt(sessionId),
        peerFingerprint: st.origin,
      });
      const decoded: SessionAttachResult = {
        sessionId: Number(result.sessionId),
        backendType: result.backendType,
        lifecycleState: result.lifecycleState,
        latestSeq: Number(result.latestSeq),
      };
      st.attached = decoded;
      st.watched = true;
      return decoded;
    })();
    st.attaching = p;
    void p.then(
      () => {
        if (st.attaching === p) st.attaching = null;
      },
      () => {
        if (st.attaching === p) st.attaching = null;
      },
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
    const st = this.stateOf(sessionId, peerFingerprint);
    const running = st.catchingUp;
    if (running) {
      st.refill = true;
      return running;
    }
    const before = st.cursor;
    const p = this.pullUntilCaughtUp(st).finally(() => {
      st.catchingUp = null;
      const queued = st.refill;
      st.refill = false;
      // 这一串期间又出现过跳号:那一段还没补上,再补一轮。
      //
      // 但只在这一串**真的推动了游标**时才补:一条也没消费掉(daemon 读不出留存下界
      // → OldestSeq 报 0,而日志老前缀已被回收,拉回来的这一页第一条就比 游标+1 大)
      // 时,下一轮拉回来的还是同一页、还是一条也消费不掉 —— 不看进展就会一轮接一轮
      // 重发同一条 pull,补齐原地打转、把 daemon 与中继一起打满。补不动就停在这里,
      // 等下一条实时帧 / 下次重连再试(Go 侧 scheduleGapFill 的 filling 闸门同一纪律)。
      if (queued && st.cursor > before) {
        void this.catchUp(st.sessionId, st.origin).catch(() => {
          // 补洞失败保持关注,下一条实时帧 / 下次重连再试。
        });
      }
    });
    st.catchingUp = p;
    return p;
  }

  /**
   * 往回取一段:交回 seq **严格小于** beforeSeq 的那些帧(升序),以及还有没有更早的。
   *
   * 与 catchUp 是两件事,因此这里**不动游标、不投递、不补洞**:
   *   - 动游标 = 宣称这一段之后的都读过了,此后每条实时帧都被判成重复丢光;
   *   - 走投递 = 那套 seq 闸门会把整段判成跳号,反手从游标往后再拉一遍整条日志,
   *     正好是「只拉尾巴」要避免的事。
   * 帧原样交回,由调用方自己前插(详情页往上滚续读)。
   *
   * 对端的 pull 只能从一个游标**往后**翻,所以「往回取 limit 条」= 从
   * beforeSeq-1-limit 起翻一页,再把越过上界的那些切掉。越界那条不切的话,调用方
   * 会把它前插到手上那一段的前面,转录就乱序了。
   */
  async pullBefore(
    sessionId: number,
    beforeSeq: number,
    limit: number,
    peerFingerprint?: string,
  ): Promise<{ frames: JournaledNotification[]; hasBefore: boolean }> {
    const origin = peerFingerprint?.trim() ?? "";
    const res = await this.request(rpcMethods.sessionPull, {
      sessionId: BigInt(sessionId),
      peerFingerprint: origin,
      cursor: BigInt(Math.max(0, beforeSeq - 1 - limit)),
      limit,
    });
    const frames = res.notifications
      .map(journaledFromProtobuf)
      .filter((n) => n.seq < beforeSeq);
    if (frames.length === 0) return { frames, hasBefore: false };
    // 对端报的留存下界(报不出时按 1 算):最老那条就是它了,说明再往前真的没有了。
    const oldestSeq = Number(res.oldestSeq);
    const floor = oldestSeq > 0 ? oldestSeq : 1;
    return { frames, hasBefore: frames[0].seq > floor };
  }

  private async pullUntilCaughtUp(st: SessionState): Promise<void> {
    await this.attach(st.sessionId, st.origin);
    for (;;) {
      const sentCursor = st.cursor;
      const response = await this.request(rpcMethods.sessionPull, {
        sessionId: BigInt(st.sessionId),
        peerFingerprint: st.origin,
        cursor: BigInt(sentCursor),
        limit: DefaultSessionPullLimit,
      });
      const res = {
        notifications: response.notifications.map(journaledFromProtobuf),
        cursor: Number(response.cursor),
        hasMore: response.hasMore,
        oldestSeq: Number(response.oldestSeq),
      };
      // OldestSeq 复位:本次拉取用的游标落后于留存窗口(老前缀已被回收)时,把游标
      // 推到现存最老那一行的前一位(那截尾巴是真的没有了)。复位必须在应用这一页
      // **之前** —— 否则这一页的第一条当场被判成跳号丢掉,一条也交付不出去。
      if (res.oldestSeq > 0 && sentCursor < res.oldestSeq - 1) {
        st.cursor = res.oldestSeq - 1;
      }
      for (const n of res.notifications) {
        this.applyJournaled(st, n);
      }
      // 游标只由「应用了哪些行」推进(复位除外):照 res.cursor 盖上去会把这一页里
      // 交付不出去的行也算成已消费。
      const applied = st.cursor;
      // 防自旋:没有更多页,或游标没有推进(空页且未复位),不能无限重拉同一页。
      if (!res.hasMore || applied <= sentCursor) break;
    }
  }

  /**
   * 取(必要时新建)一条会话的状态。身份是 (origin, sessionId) 这一对 —— 省略
   * origin 不是「随便哪条同号的」,而是「调用方自己的对端」那一条(wire 的约定),
   * 因此它有自己的一格,不会与点名了发起端的那条合并。
   */
  private stateOf(sessionId: number, peerFingerprint?: string): SessionState {
    const origin = peerFingerprint?.trim() ?? "";
    const key = sessionKey(sessionId, origin);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created: SessionState = {
      sessionId,
      origin,
      cursor: 0,
      attached: null,
      attaching: null,
      catchingUp: null,
      refill: false,
      watched: false,
    };
    this.sessions.set(key, created);
    return created;
  }

  /** 一条会话此刻的游标。origin 是身份的一半,省略即「调用方自己的对端」那一条。 */
  getCursor(sessionId: number, peerFingerprint?: string): number {
    return this.stateOf(sessionId, peerFingerprint).cursor;
  }

  /** 由外部(如从 server 镜像预置)设置会话游标。 */
  setCursor(sessionId: number, seq: number, peerFingerprint?: string): void {
    this.stateOf(sessionId, peerFingerprint).cursor = seq;
  }

  // ── 内部:发送 / 接收 ────────────────────────────────────────────────────

  private sendBytes(bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== OPEN) {
      throw new RelayError(-1, "relay: 连接未就绪", null);
    }
    this.ws.send(bytes);
  }

  private handleMessage(data: unknown): void {
    let frame: ProtobufRpcFrame;
    try {
      frame = ProtobufRpcCodec.decode(binaryPayload(data));
    } catch {
      // 单帧坏掉不影响连接:丢掉继续等下一帧。
      return;
    }
    if (isNotification(frame)) {
      this.dispatchNotification(frame);
      return;
    }
    const id = String(frame.id);
    const entry = this.pending.get(id);
    if (!entry) {
      // 迟到 / 未知 id 的响应(已被 close 拒绝):丢弃。
      return;
    }
    this.pending.delete(id);
    entry.cleanup?.();
    if (frame.body.case === "error") {
      entry.reject(
        new RelayError(frame.body.code, frame.body.message, frame.body.details),
      );
      return;
    }
    if (
      frame.body.case !== "typedMethodResponse" ||
      frame.body.methodId !== entry.method.id
    ) {
      entry.reject(new RelayError(-1, "relay: 响应方法不匹配", frame));
      return;
    }
    entry.resolve(frame.body.value);
  }

  /**
   * 投递一帧通知。`target` 是补齐路径交来的那条会话 —— 它自己知道自己是谁,不必
   * 也**不能**去猜:补齐拉回来的帧与实时帧在线上长得一模一样,靠 liveBySessionId
   * 去认的话,同号的另一条会话正被看着时,这一页会算到它头上。
   */
  private dispatchNotification(
    frame: ProtobufRpcFrame,
    target?: SessionState,
  ): void {
    const decoded = decodeNotification(frame);
    if (!decoded) {
      return;
    }
    const st = target ?? this.liveStateOf(decoded.sessionId);
    this.applyDedup(st, decoded.seq, () => decoded.deliver(this.opts));
  }

  /**
   * 一帧**实时**通知该记到哪条会话上。线上只有会话 id 认得出来,所以取最后一次
   * attach 的那条;一次都没 attach 过时落到「调用方自己的对端」那一格 —— 与
   * 省略 origin 的那条请求同一个身份,不新造第三种含义。
   */
  private liveStateOf(sessionId: number): SessionState {
    return this.liveBySessionId.get(sessionId) ?? this.stateOf(sessionId);
  }

  /**
   * 一条交付不出去的通知(本客户端不认识的 method / 载荷解不动)照样占掉它那一格
   * 游标。不占的话,它后面的每一条已知通知都会被判成跳号 → 触发补洞 → 拉回同一页 →
   * 又卡在这一条上,补齐原地打转、后面的转录永远交付不出去(与 Go 侧
   * remote/reconnect.go 的 skipSeq 同一条纪律)。
   */
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
    st: SessionState,
    seq: number | undefined,
    deliver: () => void,
  ): void {
    if (seq === undefined || seq === 0) {
      deliver();
      return;
    }
    if (seq <= st.cursor) return;
    if (seq > st.cursor + 1) {
      void this.catchUp(st.sessionId, st.origin).catch(() => {
        // 补洞失败保持关注,下一条实时帧 / 下次重连再试。
      });
      return;
    }
    st.cursor = seq;
    deliver();
  }

  /** 补齐页里的一条通知:按 method 解成帧、把日志行上的 seq 盖上去,再走同一套去重投递。 */
  private applyJournaled(st: SessionState, n: JournaledNotification): void {
    const frame = journaledToFrame(n);
    if (frame) this.dispatchNotification(frame, st);
  }

  private handleClose(): void {
    // 游标与关注名单留着(重连要接着补),本次连接的 attach 结果作废:新连接上
    // 每条会话都要重新接管。
    for (const st of this.sessions.values()) {
      st.attached = null;
      st.attaching = null;
    }
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
      entry.cleanup?.();
      entry.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    this.redial.schedule(this.opts.reconnectDelayMs ?? 1000, () => {
      void this.reconnect();
    });
  }

  private async reconnect(): Promise<void> {
    try {
      if (this.opts.refreshCredentials) {
        const credentials = await this.opts.refreshCredentials();
        this.opts.url = credentials.url;
        this.opts.jwt = credentials.jwt;
      }
      await this.connect();
      // 重连后:对关注的会话逐个 attach(新连接需重发)→ 按游标补齐。
      // 单条会话补齐失败不阻断其它会话。
      for (const st of [...this.sessions.values()].filter((s) => s.watched)) {
        try {
          await this.catchUp(st.sessionId, st.origin);
        } catch {
          // 该会话补齐失败,保持关注,下一条 / 下次重连再试。
        }
      }
    } catch {
      this.scheduleReconnect();
    }
  }
}

interface DecodedNotification {
  sessionId: number;
  seq: number | undefined;
  deliver: (handlers: NotificationHandlers) => void;
}

/**
 * 按 method 把一帧通知解成「投给谁」的一次投递动作。不认识的 method / 载荷解不动时
 * 返回 null —— 那一帧交付不出去,但它那一格 seq 照样是用掉的(见 skipSeq)。
 */
function decodeNotification(
  frame: ProtobufRpcFrame,
): DecodedNotification | null {
  const body = frame.body;
  if (
    body.case === "runtimeEventNotification" ||
    body.case === "autonomousTurnEventNotification"
  ) {
    const value: EventFrame = {
      sessionId: body.sessionId,
      seq: body.seq,
      event: runtimeEventToViewEvent(body.event),
    };
    return {
      sessionId: value.sessionId,
      seq: value.seq,
      deliver: (h) => h.onEvent?.(value),
    };
  }
  if (
    body.case === "runResultDoneNotification" ||
    body.case === "autonomousTurnDoneNotification"
  ) {
    const value: RunResultDoneFrame = {
      sessionId: body.sessionId,
      providerSessionId: body.providerSessionId,
      usage: body.usage === undefined ? undefined : { ...body.usage },
      userAnchor: body.userAnchor,
      model: body.model,
      contextWindow: body.contextWindow,
      durationMs: body.durationMs,
      firstTokenMs: body.firstTokenMs,
      tokensPerSec: body.tokensPerSec,
      turnToken: Number(body.turnToken),
      stopErrMsg: body.stopErrorMessage,
      stopErrCode: body.stopErrorCode,
      seq: body.seq,
    };
    return {
      sessionId: value.sessionId,
      seq: value.seq,
      deliver: (h) => h.onRunResultDone?.(value),
    };
  }
  if (body.case === "autonomousTurnStartedNotification") {
    const value: AutonomousTurnStartedFrame = {
      sessionId: body.sessionId,
      trigger: body.trigger,
      turnToken: Number(body.turnToken),
      seq: body.seq,
    };
    return {
      sessionId: value.sessionId,
      seq: value.seq,
      deliver: (h) => h.onAutonomousTurnStarted?.(value),
    };
  }
  return null;
}

/** Protobuf `RuntimeEventNotification.event` oneof 的全部 case 名。 */
type RuntimeEventCase = RuntimeEventNotificationFrame["event"]["case"];

/**
 * oneof case 名 → `agentruntime.EventKind` 判别值。
 *
 * 两边**不是**同一套拼法，也没有可推导的规则：`toolCall` 对应的 kind 是
 * `tool_use_start`，`usageUpdate` 是 `usage`。所以这张表必须一条条对着
 * `event_wire.go` 里各 `MarshalJSON` 落的常量钉，不能靠 snake_case 转换糊过去。
 *
 * 类型标注是这张表唯一的机械保证，两头都吃紧：
 *
 *   - 键是 `RuntimeEventCase` —— Go 那边新增一个 oneof case，这里漏填就编译不过；
 *   - 值是 `EventKind` —— 写出一个词表外的字符串（曾经的 `"tool_call"`）同样
 *     编译不过。
 *
 * 少了后半截，错的判别值一路绿到线上：消费方的 `kindOf` 是断言不是校验，
 * `never` 穷尽检查够不着，最后在转录归约的 `default` 分支被当成未知事件铺成
 * 一坨 JSON —— 工具卡与提问卡就此从不渲染。
 */
const EVENT_KINDS: Record<RuntimeEventCase, EventKind> = {
  textDelta: EventTextDelta,
  thinkingDelta: EventThinkingDelta,
  outputActivity: EventOutputActivity,
  permissionModeChanged: EventPermissionModeChanged,
  retry: EventRetry,
  contextWindowUpdated: EventContextWindowUpdated,
  compactBoundary: EventCompactBoundary,
  runtimeStatus: EventRuntimeStatus,
  done: EventDone,
  error: EventError,
  userMessage: EventUserMessage,
  toolCall: EventToolUseStart,
  toolResult: EventToolResult,
  steerConsumed: EventSteerConsumed,
  userAskRequest: EventAskUserQuestion,
  userAskResolved: EventAskUserQuestionAnswered,
  toolPermissionRequest: EventToolPermissionRequest,
  toolPermissionResolved: EventToolPermissionResolved,
  execApprovalRequested: EventExecApprovalRequested,
  execApprovalResolved: EventExecApprovalResolved,
  subagentStarted: EventSubagentStarted,
  subagentProgress: EventSubagentProgress,
  subagentDone: EventSubagentDone,
  subagentModel: EventSubagentModel,
  usageUpdate: EventUsage,
  planUpdated: EventPlanUpdated,
  unrecognizedBlock: EventUnrecognizedBlock,
};

/**
 * 上面那张表的反向：判别值 → oneof case 名。回放路径（server 镜像的历史、中继
 * 补齐、往回续读）要把中间形状翻回 Protobuf 的 oneof 才能走同一条解帧路径。
 *
 * **就地反转生成，不手写第二份**。此前它是按 snake_case → camelCase 猜的，而
 * 上面那张表的注释写的正是「两边不是同一套拼法，也没有可推导的规则」：
 * `tool_use_start` 的 case 是 `toolCall`、`ask_user_question` 是 `userAskRequest`、
 * 它的答案是 `userAskResolved`。这三种因此在回放时翻成词表外的判别值，再翻回来
 * 就成了 `toolUseStart` 这种谁都不认得的东西 —— 归约器的 switch 落进 default，
 * 历史里的工具卡与提问卡铺成一坨 JSON，工具结果连挂靠的卡都没有、整块消失。
 * 实时帧不过这一跳，所以同一条对话「正在跑的那一轮好好的、翻上去全坏」。
 */
const RUNTIME_EVENT_CASES: Readonly<Record<string, RuntimeEventCase>> =
  Object.fromEntries(
    Object.entries(EVENT_KINDS).map(([eventCase, kind]) => [
      kind,
      eventCase as RuntimeEventCase,
    ]),
  );

/**
 * wire 上的 `bytes` 字段还原成载荷本身。
 *
 * 事件里每一个 `bytes` 都是 Go 侧的 `json.RawMessage`（工具入参、canonical、
 * 工具结果 meta），wire 包刻意让它们原样是 `Uint8Array` —— 那一层的契约是
 * 「wire 字节就是字节」，怎么读是宿主的事。本站读法只有这一种，所以在这里
 * 一次性还原：漏了这一步，工具卡的入参会变成一个按字节下标编号的对象。
 *
 * 空字节等于「没这个字段」（proto3 零值），坏字节按缺失处理 —— 一条读不出的
 * 入参不该把整段转录带崩。
 */
function decodeRawJSON(value: Uint8Array): unknown {
  if (value.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(value));
  } catch {
    return undefined;
  }
}

function runtimeEventToViewEvent(
  event: { case: string } & Record<string, unknown>,
): Record<string, unknown> {
  const { case: eventCase, ...fields } = event;
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Uint8Array) fields[key] = decodeRawJSON(value);
  }
  // 兜底成 case 名本身：运行期照样可能来一个比本仓新的 daemon，那时如实透出
  // 一个词表外的判别值，比谎报成某个已知 kind 好 —— 消费方的 default 分支会
  // 把它原样呈现。
  return {
    kind: EVENT_KINDS[eventCase as RuntimeEventCase] ?? eventCase,
    ...fields,
  };
}

/**
 * 日志行的 RpcNotification oneof ↔ 中间形状的方法名。
 *
 * 日志里**不只有** runtime.event:每跑完一轮就落一条轮次结束帧,自主续轮另有起止两条。
 * 两条补齐路径最终汇到同一个 (method, params) 中间形状 —— server 镜像那条由 Go 侧
 * internal/pkg/wireview 投影,中继这条由这里投影 —— 所以两边必须是同一张表。
 */
const JOURNALED_METHODS: Record<string, string> = {
  runtimeEvent: NotifyEvent,
  autonomousTurnEvent: NotifyAutonomousTurnEvent,
  runResultDone: NotifyRunResultDone,
  autonomousTurnDone: NotifyAutonomousTurnDone,
  autonomousTurnStarted: NotifyAutonomousTurnStarted,
};

/**
 * 一行 wire.JournaledNotification(typed Protobuf)→ 与 server 镜像同形的中间帧。
 *
 * 认不出的通知形态交回一条**空 params 的行**而不是抛:这一页是 `map` 一次性投影的,
 * 其中一行抛出会让整页连同 catchUp() 一起被拒 —— 详情页于是停在「没能从这台机器读到
 * 这条对话的内容」,而机器在线、内容也确实在那里。空 params 那行交付不出去,但它照样
 * 占掉自己那一格游标(见 applyDedup 的注释),后面的帧不会被判成跳号。
 */
function journaledFromProtobuf(input: unknown): JournaledNotification {
  const entry = input as {
    seq: bigint;
    payload?: { payload?: { case?: string; value?: Record<string, unknown> } };
  };
  const seq = Number(entry.seq);
  const payload = entry.payload?.payload;
  const method =
    payload?.case === undefined ? "" : (JOURNALED_METHODS[payload.case] ?? "");
  const value = payload?.value;
  if (method === "" || value === undefined) {
    return { seq, method, params: {} };
  }
  if (method === NotifyEvent || method === NotifyAutonomousTurnEvent) {
    const event = value.event as { case: string; value?: object } | undefined;
    if (event === undefined) return { seq, method, params: {} };
    return {
      seq,
      method,
      params: {
        sessionId: Number(value.sessionId),
        seq,
        event: runtimeEventToViewEvent({
          case: event.case,
          ...(event.value ?? {}),
        }),
      },
    };
  }
  if (method === NotifyAutonomousTurnStarted) {
    return {
      seq,
      method,
      params: {
        sessionId: Number(value.sessionId),
        seq,
        trigger: value.trigger,
        turnToken: Number(value.turnToken ?? 0),
      },
    };
  }
  const usage = value.usage as Record<string, number> | undefined;
  return {
    seq,
    method,
    params: {
      sessionId: Number(value.sessionId),
      seq,
      providerSessionId: value.providerSessionId,
      ...(usage === undefined ? {} : { usage: { ...usage } }),
      userAnchor: value.userAnchor,
      model: value.model,
      contextWindow: value.contextWindow,
      turnToken: Number(value.turnToken ?? 0),
      // 与 Go 侧 wireview.doneView 同名:中间形状是两条路径的会合点,少一个别名就是
      // 镜像那条路上的停止原因读不出来。
      stopErrMsg: value.stopErrorMessage,
      stopErrCode: value.stopErrorCode,
      // 本轮统计。漏掉这三格只在**刷新之后**看得见:实时那一轮 meta 是全的,页面一刷、
      // 同一条消息从这条补齐路径重建出来,耗时就掉回 0.0s、首字与速率整行消失。
      durationMs: value.durationMs,
      firstTokenMs: value.firstTokenMs,
      tokensPerSec: value.tokensPerSec,
    },
  };
}

/**
 * 中间形状的一行 → 与实时流同一套解帧/投递路径认得的帧。日志行上的 seq 盖在帧上
 * (params 里那份是投影时补的,不是权威)。
 *
 * 认不出的 method / 解不动的载荷交回 null:调用方按「交付不出去也占掉这一格游标」
 * 处理(applyJournaled / applyJournalFrames),不报错、不跳号。
 */
function journaledToFrame(n: JournaledNotification): ProtobufRpcFrame | null {
  if (!n.params || typeof n.params !== "object") return null;
  const value = n.params as Record<string, unknown>;
  if (typeof value.sessionId !== "number") return null;
  const sessionId = value.sessionId;
  if (n.method === NotifyEvent || n.method === NotifyAutonomousTurnEvent) {
    if (!value.event || typeof value.event !== "object") return null;
    return {
      id: 0n,
      body: {
        case:
          n.method === NotifyEvent
            ? "runtimeEventNotification"
            : "autonomousTurnEventNotification",
        sessionId,
        seq: n.seq,
        event: viewEventToRuntimeEvent(
          value.event as Record<string, unknown>,
        ) as never,
      },
    } as ProtobufRpcFrame;
  }
  if (n.method === NotifyAutonomousTurnStarted) {
    return {
      id: 0n,
      body: {
        case: "autonomousTurnStartedNotification",
        sessionId,
        seq: n.seq,
        trigger: str(value.trigger),
        turnToken: BigInt(num(value.turnToken)),
      },
    } as ProtobufRpcFrame;
  }
  if (n.method !== NotifyRunResultDone && n.method !== NotifyAutonomousTurnDone)
    return null;
  const usage = value.usage as Record<string, number> | undefined;
  return {
    id: 0n,
    body: {
      case:
        n.method === NotifyRunResultDone
          ? "runResultDoneNotification"
          : "autonomousTurnDoneNotification",
      sessionId,
      seq: n.seq,
      providerSessionId: str(value.providerSessionId),
      ...(usage === undefined ? {} : { usage: { ...usage } }),
      userAnchor: str(value.userAnchor),
      model: str(value.model),
      contextWindow: num(value.contextWindow),
      turnToken: BigInt(num(value.turnToken)),
      stopErrorMessage: str(value.stopErrMsg),
      stopErrorCode: num(value.stopErrCode),
      durationMs: num(value.durationMs),
      firstTokenMs: num(value.firstTokenMs),
      tokensPerSec: num(value.tokensPerSec),
    },
  } as ProtobufRpcFrame;
}

/** 投影按「零值省略」写(wireview.putNonempty/putNonzero),读回时补回零值。 */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function viewEventToRuntimeEvent(
  event: Record<string, unknown>,
): { case: string } & Record<string, unknown> {
  const { kind, ...fields } = event;
  // 词表外的判别值原样当 case 名交出去：运行期照样可能来一个比本仓新的 daemon，
  // 而 runtimeEventToViewEvent 的兜底也是原样透出 —— 两头都不改写，回放才是恒等的。
  const eventCase =
    typeof kind === "string" ? (RUNTIME_EVENT_CASES[kind] ?? kind) : "";
  return { case: eventCase, ...fields };
}

function binaryPayload(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("relay: WebSocket payload must be binary");
}

function isNotification(frame: ProtobufRpcFrame): boolean {
  return frame.body.case.endsWith("Notification");
}

/**
 * 应用 server 镜像交出的一页历史帧(wire.JournaledNotification 原样),投给与实时流
 * 同一批 handler;返回这一页里最大的 seq。
 *
 * 调用方拿这个 seq 预置中继客户端的游标(setCursor),实时流便从它之后接上 —— server
 * 手里已经有的那一段不会再从执行端拉一遍,而真跳了号的那一段仍由客户端回执行端补洞。
 *
 * 与客户端内部补齐的唯一不同是这里**不做游标去重**:这一页来自 server,与本客户端的
 * 游标不是同一条线,去重只会把整段历史当成重复丢光。交付不出去的帧(不认识的 method /
 * 载荷解不动)照样计入返回值 —— 它那一格是真用掉了,漏算的话预置的游标停在它前面,
 * 随后每一条实时帧都被判成跳号。
 */
export function applyJournalFrames(
  frames: readonly JournaledNotification[],
  handlers: NotificationHandlers,
): number {
  let last = 0;
  for (const n of frames) {
    if (typeof n.seq === "number" && n.seq > last) last = n.seq;
    const frame = journaledToFrame(n);
    if (frame) decodeNotification(frame)?.deliver(handlers);
  }
  return last;
}
