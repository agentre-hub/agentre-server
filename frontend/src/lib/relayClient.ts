/**
 * 一条**虚拟通道**上的中继客户端:对通道那一头的那台机器说 wire 协议。
 *
 * socket 不归它:账号级连接由 RelayConnection 持有,一个账号一条(决策 10 + 13),
 * 这里只借它开一条通道并声明目标(`conversation:<uuid>` 或 `machine:<fingerprint>`)。
 * 从前这里自己拨 socket,于是同时看三台机器就是三条物理连接。
 *
 * 职责(测试接缝 2,Go 侧对照 internal/daemon/client/client_test.go):
 *  1. 多路复用:一条通道上并发多个 typed Protobuf RPC 请求,按 id 路由响应,不串道。
 *  2. 断线补齐:连接重连后,对关注的对话 attach(显式接管)→ 按 seq 游标 pull,
 *     补齐的通知与实时通知走**同一套去重**(seq ≤ 游标即重复,只应用一次)。
 *  3. attach 幂等:同一对话重复 attach 不重复发请求,成功后走缓存。
 *
 * 鉴权:握手是**逐通道**的(auth.account)——一条连接上的两条通道接的是两台不同的
 * 机器,各自要向自己那台出示凭据。
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
  type TurnStartedFrame,
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
  NotifyTurnStarted,
  NotifyEvent,
  NotifyRunResultDone,
  ProtobufRpcCodec,
  encodeRpcCancel,
  encodeRpcMethodRequest,
  rpcMethods,
} from "@agentre-hub/agentre-wire";
import type { MessageInitShape, MessageShape } from "@bufbuild/protobuf";

import type {
  RelayChannelHandle,
  RelayConnection,
  RelayState,
} from "@/lib/relayConnection";

export type { RelayState } from "@/lib/relayConnection";

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
  /**
   * 实时与补齐的事件帧,去重后投递。
   *
   * 第二个参数是这一帧**发生**的时刻(Unix 毫秒),不是收到它的时刻 —— 两者只在实时
   * 那条路上相等。补齐带的是原点报的时刻(server 镜像的一页 / 客户端自己回机器补的
   * 那一页都带),实时帧没有可带的,就是此刻。三条路只有这一层同时认得,所以分流在
   * 这里做,不让每个宿主各判一次。
   *
   * 0 = 那一端还没升级到会报它。0 一路读作「不知道」,渲染成不显示时间;补一个当下
   * 会给一条两天前的对话盖上今天的时间。
   *
   * 参数**可选**:说不上时刻的调用方(测试替身、别的合成路径)就是不传,由读者当 0
   * 处理 —— 强制它们编一个数出来,编出来的只会是假的。
   */
  onEvent?: (frame: EventFrame, createtime?: number) => void;
  onRunResultDone?: (frame: RunResultDoneFrame, createtime?: number) => void;
  onAutonomousTurnStarted?: (
    frame: AutonomousTurnStartedFrame,
    createtime?: number,
  ) => void;
  /**
   * 客户端要的那一轮开始了（wire 2026-09-02 新增）。
   *
   * 与 `onAutonomousTurnStarted` 分开一口，因为两者说的不是同一件事：那一条是后台
   * 任务替用户开的一轮，这一条可能就是**本浏览器**刚发的那条消息（daemon 扇给这条
   * 会话的全部订阅者，发起方自己也在里面）。读者据此自己判要不要动。
   */
  onTurnStarted?: (frame: TurnStartedFrame, createtime?: number) => void;
}
export interface RelayClientOptions extends NotificationHandlers {
  /**
   * 共用的那条账号级连接。这个客户端跑在它的**一条虚拟通道**上（决策 10）：
   * 从前每个客户端自己开一条 socket，于是同时看三台机器就是三条。
   */
  connection: RelayConnectionLike;
  /**
   * 这条通道的目标：`conversation:<uuid>` 或 `machine:<fingerprint>`
   * （见 relayTarget 的入口分流）。服务端据此把这条通道接到承载它的机器上。
   */
  target: string;
  /**
   * 出示给 daemon 的账号凭据（auth.account）。握手是**逐通道**的：一条连接上的
   * 两条通道接的是两台不同的机器，各自要向自己那台出示凭据。
   */
  jwt: string;
  onStateChange?: (state: RelayState) => void;
}

/** RelayClient 用得到的那一小块连接能力（ISP）。 */
export type RelayConnectionLike = Pick<
  RelayConnection,
  "state" | "connect" | "openChannel"
>;

interface PendingRequest {
  method: AnyRpcMethod;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  cleanup?: () => void;
}

/**
 * 一条对话在本客户端这边的全部状态。
 *
 * 身份就是 `conversationId` 一个值（决策 1）：它全局唯一，所以「同一条连接上换看
 * 同号的另一条对话」那类并轨**由构造消失**——从前的键是 (origin, sessionId) 一对，
 * 因为会话号是各端本地自增的。origin 留下来只作**请求参数**（wire 的
 * ResolveSessionPeer：省略 = 调用方自己的对端），不再是身份的一半。
 */
interface SessionState {
  readonly conversationId: string;
  /**
   * 发起端指纹。空串 = 「调用方自己的对端」—— 那是 wire 上**省略 origin** 的含义
   * (ResolveSessionPeer),是一个确定的身份,不是「任意」或「还不知道」。
   */
  origin: string;
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

export class RelayClient {
  private readonly opts: RelayClientOptions;
  private readonly connection: RelayConnectionLike;
  private channel: RelayChannelHandle | null = null;
  private nextId = 1n;
  private pending = new Map<string, PendingRequest>();
  /**
   * 每条对话在本客户端这边的全部状态，按 `conversation_id` 索引。
   *
   * 一个值就够了：`conversation_id` 全局唯一（决策 1），所以「同一条连接上换看同号
   * 的另一条对话会读到上一条的游标与 attach 结果」那条路径由构造消失，不是防得更
   * 好了，是没有了。实时通知也因此认得出自己属于哪一条，不再需要「最后一次 attach
   * 的那条赢」这种取舍。
   */
  private sessions = new Map<string, SessionState>();
  private closedByUser = false;
  private authenticating: Promise<void> | null = null;
  private currentState: RelayState = "disconnected";

  constructor(opts: RelayClientOptions) {
    this.opts = opts;
    this.connection = opts.connection;
  }

  /**
   * 向 daemon 出示账号凭据,把它认成本浏览器的对端(auth.account,与 Go 侧
   * daemon/client 的中继路径同一握手)。必须在任何 runtime.* 与 session.* 之前完成 ——
   * daemon 对非 auth.* 方法一律 requireAuth。
   *
   * 请求体里**不再给对端身份**（决策 8：`AuthAccountRequest.device_fingerprint`
   * 已删）——身份必须来自被验证的凭据，而不是请求体里的一句自报。
   *
   * protocolVersion 是握手的一部分而不是可选装饰:对端按 [min_supported, protocol]
   * 两个窗口的交集判定,空版本被判成「对端太旧」(proto3 下缺字段与显式空串同为零值)。
   * 版本取自 wire 包导出的常量,与本次编译进来的 schema 同源。
   */
  private authenticate(): Promise<unknown> {
    return this.request(rpcMethods.authAccount, {
      credential: this.opts.jwt,
      protocolVersion: PROTOCOL_VERSION,
      minSupportedProtocolVersion: PROTOCOL_VERSION,
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

  /**
   * 接上这条通道：连接就绪 → 开通道并声明目标 → auth.account。
   *
   * 「connected」只在握手成功后才对外暴露,connect() 也只在此时 resolve;消费者的
   * session.* 请求因此必然晚于握手完成,不会抢在 auth.account 之前到达 daemon 被
   * Unauthorized 拒掉(实测竞态)。
   */
  connect(): Promise<void> {
    if (this.authenticating) return this.authenticating;
    this.closedByUser = false;
    this.setState("connecting");
    const run = (async () => {
      await this.connection.connect();
      if (this.closedByUser) return;
      this.openChannel();
      await this.handshake();
    })();
    this.authenticating = run;
    void run.then(
      () => {
        if (this.authenticating === run) this.authenticating = null;
      },
      () => {
        if (this.authenticating === run) this.authenticating = null;
      },
    );
    return run;
  }

  /**
   * 重开被服务端单独关掉的那条通道。
   *
   * 通道级失败（目标不存在 / 离线 / 转发失败）只关掉这一条通道，它随即从连接的
   * 通道表里消失——换一条 socket 也带不回它（`RelayConnection.connect` 只重新声明
   * 表里还在的那些）。因此「重新连接」这条路必须自己把它开回来。
   *
   * 通道还在时是空操作：那是「换 socket」那一路，重做握手由通道的 onOpen 负责，
   * 这里再来一次就是多一次 auth.account。
   */
  reopen(): Promise<void> {
    if (this.channel) return Promise.resolve();
    return this.connect();
  }

  /** 主动关掉这条通道。连接本身留着——它是账号级的，别人还在用。 */
  close(): void {
    this.closedByUser = true;
    this.channel?.close();
    this.channel = null;
    this.authenticating = null;
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
   * 显式接管一条对话(幂等):成功后该对话进入关注名单,断线重连自动补齐。
   * 重复调用(含并发)不重复发请求。
   */
  attach(
    conversationId: string,
    peerFingerprint?: string,
  ): Promise<SessionAttachResult> {
    const st = this.stateOf(conversationId, peerFingerprint);
    if (st.attached) return Promise.resolve(st.attached);
    if (st.attaching) return st.attaching;
    const p = (async (): Promise<SessionAttachResult> => {
      const result = await this.request(rpcMethods.sessionAttach, {
        conversationId,
        peerFingerprint: st.origin,
      });
      const decoded: SessionAttachResult = {
        conversationId: result.conversationId,
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
   * 按 seq 游标补齐一条对话:attach → pull 翻页直到 HasMore=false。
   * 补齐的通知与实时同一套去重(seq ≤ 游标即丢弃、seq > 游标+1 即跳号)。
   *
   * 同一对话的补齐串行:已有一串在飞时复用它,并记下「补完再补一轮」——
   * 跳号触发的补洞与页面发起的补齐因此不会并发翻页、互相踩游标。
   */
  catchUp(conversationId: string, peerFingerprint?: string): Promise<void> {
    const st = this.stateOf(conversationId, peerFingerprint);
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
        void this.catchUp(st.conversationId, st.origin).catch(() => {
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
    conversationId: string,
    beforeSeq: number,
    limit: number,
    peerFingerprint?: string,
  ): Promise<{ frames: JournaledNotification[]; hasBefore: boolean }> {
    const origin = peerFingerprint?.trim() ?? "";
    const res = await this.request(rpcMethods.sessionPull, {
      conversationId,
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
    // 接回实时流与读历史是两件事,**接不回不等于读不到**。
    //
    // agentred 每次重启都把非终态会话标成 interrupted,而 daemon 的 Attach 对
    // interrupted 一律回 ErrNoActiveTurn ——「那一轮的子进程随上一个 daemon 进程消亡
    // 了」——它同一处也写明:历史仍可 Pull。这里抛出去,下面一条 pull 都发不出,详情页
    // 停在「没能从这台机器读到这条对话的内容」,而机器在线、历史也确实在那里;存量一旦
    // 全沉淀成 interrupted(开发机重启若干次之后就是),每一条对话都打不开。
    //
    // 详情页那一层已按同一条纪律防过一次(interrupted 不问 attach、问了失败也只吞掉),
    // 但那挡不住这里:跳过 attach 意味着 st.attached 始终为空,补齐进来照样问一遍。
    // 形状与同仓库的 mirror_svc.catchUp 一致:少一次实时接管而已,补齐照走。
    try {
      await this.attach(st.conversationId, st.origin);
    } catch {
      // 真正断掉的连接会让紧接着的 pull 一并失败,那时才是「读不到」。
    }
    for (;;) {
      const sentCursor = st.cursor;
      const response = await this.request(rpcMethods.sessionPull, {
        conversationId: st.conversationId,
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
   * 取(必要时新建)一条对话的状态。身份是 `conversation_id` 一个值；点名的发起端
   * 只是请求参数，点名一次就记住（省略 origin 的含义是「调用方自己的对端」，那是
   * 一个确定身份，不能拿它去覆盖已经知道的发起端）。
   */
  private stateOf(
    conversationId: string,
    peerFingerprint?: string,
  ): SessionState {
    const origin = peerFingerprint?.trim() ?? "";
    const existing = this.sessions.get(conversationId);
    if (existing) {
      if (origin !== "" && existing.origin === "") existing.origin = origin;
      return existing;
    }
    const created: SessionState = {
      conversationId,
      origin,
      cursor: 0,
      attached: null,
      attaching: null,
      catchingUp: null,
      refill: false,
      watched: false,
    };
    this.sessions.set(conversationId, created);
    return created;
  }

  /** 一条对话此刻的游标。 */
  getCursor(conversationId: string, peerFingerprint?: string): number {
    return this.stateOf(conversationId, peerFingerprint).cursor;
  }

  /** 由外部(如从 server 镜像预置)设置对话游标。 */
  setCursor(
    conversationId: string,
    seq: number,
    peerFingerprint?: string,
  ): void {
    this.stateOf(conversationId, peerFingerprint).cursor = seq;
  }

  // ── 内部:通道 / 发送 / 接收 ──────────────────────────────────────────

  /** 开这条客户端自己那条通道，并把目标声明出去。 */
  private openChannel(): void {
    if (this.channel) return;
    this.channel = this.connection.openChannel(this.opts.target, {
      // 每一次（重）连：新 socket 上服务端认不得旧通道，握手要重做，关注的对话
      // 要按游标补齐。
      onOpen: () => void this.handshake().catch(() => {}),
      onFrame: (payload) => this.handleMessage(payload),
      onClose: () => this.handleChannelClosed(),
      onConnectionState: (state) => this.handleConnectionState(state),
    });
  }

  /** 握手 + 重连后的补齐。失败时把这条通道判为断开，由连接那层退避重连。 */
  private async handshake(): Promise<void> {
    try {
      await this.authenticate();
    } catch (err) {
      this.setState("reconnecting");
      throw err instanceof RelayError
        ? err
        : new RelayError(-1, "relay: auth.account 失败", err);
    }
    this.setState("connected");
    for (const st of [...this.sessions.values()].filter((s) => s.watched)) {
      try {
        await this.catchUp(st.conversationId, st.origin);
      } catch {
        // 该对话补齐失败,保持关注,下一条 / 下次重连再试。
      }
    }
  }

  private handleConnectionState(state: RelayState): void {
    if (this.closedByUser) return;
    // "connected" 由握手那一步自己说：连接建立 ≠ 这条通道可用。
    if (state === "connected") return;
    for (const st of this.sessions.values()) {
      st.attached = null;
      st.attaching = null;
    }
    this.failPending(new RelayError(-1, "relay: 连接已断开", null));
    this.setState(state);
  }

  /**
   * 服务端关掉了这条通道：目标不存在 / 离线 / 转发失败 / 不许寻址。这是**通道级**
   * 的失败，同一条连接上别人的通道照常收发，所以这里既不重连也不动连接。
   *
   * 状态置 `disconnected` 而不是 `reconnecting`：在这个宿主里 `reconnecting` 的
   * 意思是「有人正在重试」（见 use-relay.ts），而通道级失败之后没有任何人在重试
   * ——连接本身好得很，服务端只是关掉了这一条。规格说的是「客户端据此只把那一条
   * 通道标为不可达」，`disconnected` 正是这个宿主里「连过又放弃了」那一格，页面
   * 据它给出重新连接的入口（走 reopen）。
   */
  private handleChannelClosed(): void {
    this.channel = null;
    for (const st of this.sessions.values()) {
      st.attached = null;
      st.attaching = null;
    }
    this.failPending(new RelayError(-1, "relay: 通道已被服务端关闭", null));
    if (this.closedByUser) return;
    this.setState("disconnected");
  }

  private sendBytes(bytes: Uint8Array): void {
    if (!this.channel) throw new RelayError(-1, "relay: 连接未就绪", null);
    try {
      this.channel.send(bytes);
    } catch (err) {
      throw new RelayError(-1, "relay: 连接未就绪", err);
    }
  }

  private handleMessage(payload: Uint8Array): void {
    let frame: ProtobufRpcFrame;
    try {
      frame = ProtobufRpcCodec.decode(payload);
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
   * 投递一帧通知。`target` 是补齐路径交来的那条对话 —— 它自己知道自己是谁,不必
   * 也**不能**去猜。实时帧带的 `conversation_id` 全局唯一,认得出自己属于哪一条。
   */
  private dispatchNotification(
    frame: ProtobufRpcFrame,
    target?: SessionState,
    createtime?: number,
  ): void {
    const decoded = decodeNotification(frame);
    if (!decoded) {
      return;
    }
    const st = target ?? this.stateOf(decoded.conversationId);
    // 实时帧没有可带的时刻:它刚从中继上过来,唯一的误差是一跳网络,所以此刻就是它
    // 的时刻。补齐那一路由调用方把原点报的值传进来(见 applyJournaled)。
    const at = createtime ?? Date.now();
    this.applyDedup(st, decoded.seq, () => decoded.deliver(this.opts, at));
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
      void this.catchUp(st.conversationId, st.origin).catch(() => {
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
    // 时刻取日志行报的那个,**不**退回当下:这一页可能是一段离线期间的成批补齐,
    // 拿此刻去盖会让整段转录显示成同一分钟。报不出来时是 0,读作「不知道」。
    if (frame) this.dispatchNotification(frame, st, n.createtime ?? 0);
  }

  private failPending(err: RelayError): void {
    for (const [, entry] of this.pending) {
      entry.cleanup?.();
      entry.reject(err);
    }
    this.pending.clear();
  }
}

interface DecodedNotification {
  conversationId: string;
  seq: number | undefined;
  deliver: (handlers: NotificationHandlers, createtime: number) => void;
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
      conversationId: body.conversationId,
      seq: body.seq,
      event: runtimeEventToViewEvent(body.event),
    };
    return {
      conversationId: value.conversationId,
      seq: value.seq,
      deliver: (h, at) => h.onEvent?.(value, at),
    };
  }
  if (
    body.case === "runResultDoneNotification" ||
    body.case === "autonomousTurnDoneNotification"
  ) {
    const value: RunResultDoneFrame = {
      conversationId: body.conversationId,
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
      conversationId: value.conversationId,
      seq: value.seq,
      deliver: (h, at) => h.onRunResultDone?.(value, at),
    };
  }
  if (body.case === "autonomousTurnStartedNotification") {
    const value: AutonomousTurnStartedFrame = {
      conversationId: body.conversationId,
      trigger: body.trigger,
      turnToken: Number(body.turnToken),
      seq: body.seq,
    };
    return {
      conversationId: value.conversationId,
      seq: value.seq,
      deliver: (h, at) => h.onAutonomousTurnStarted?.(value, at),
    };
  }
  if (body.case === "turnStartedNotification") {
    const value: TurnStartedFrame = {
      conversationId: body.conversationId,
      seq: body.seq,
    };
    return {
      conversationId: value.conversationId,
      seq: value.seq,
      deliver: (h, at) => h.onTurnStarted?.(value, at),
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
  turnStarted: NotifyTurnStarted,
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
    createtime?: bigint | number;
    payload?: { payload?: { case?: string; value?: Record<string, unknown> } };
  };
  const seq = Number(entry.seq);
  // 这一帧在**原点**发生的时刻。这条路是客户端自己回那台机器补的一页,行上这一格
  // 正是 agentred 的 daemon_notification_journal.createtime —— 转录里那个 HH:mm 的
  // 来源。报不出来的对端交出 0,读作「不知道」。
  const createtime = Number(entry.createtime ?? 0);
  const payload = entry.payload?.payload;
  const method =
    payload?.case === undefined ? "" : (JOURNALED_METHODS[payload.case] ?? "");
  const value = payload?.value;
  if (method === "" || value === undefined) {
    return { seq, method, createtime, params: {} };
  }
  if (method === NotifyEvent || method === NotifyAutonomousTurnEvent) {
    const event = value.event as { case: string; value?: object } | undefined;
    if (event === undefined) return { seq, method, createtime, params: {} };
    return {
      seq,
      method,
      createtime,
      params: {
        conversationId: String(value.conversationId ?? ""),
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
      createtime,
      params: {
        conversationId: String(value.conversationId ?? ""),
        seq,
        trigger: value.trigger,
        turnToken: Number(value.turnToken ?? 0),
      },
    };
  }
  if (method === NotifyTurnStarted) {
    // 「开始了」本身就是全部内容:这一轮的模型 / 用量 / 计时都要到终态帧才知道,
    // 用户那句话紧接着作为本轮第一条事件到达。
    return {
      seq,
      method,
      createtime,
      params: { conversationId: String(value.conversationId ?? ""), seq },
    };
  }
  const usage = value.usage as Record<string, number> | undefined;
  return {
    seq,
    method,
    createtime,
    params: {
      conversationId: String(value.conversationId ?? ""),
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
  if (typeof value.conversationId !== "string" || value.conversationId === "")
    return null;
  const conversationId = value.conversationId;
  if (n.method === NotifyEvent || n.method === NotifyAutonomousTurnEvent) {
    if (!value.event || typeof value.event !== "object") return null;
    return {
      id: 0n,
      body: {
        case:
          n.method === NotifyEvent
            ? "runtimeEventNotification"
            : "autonomousTurnEventNotification",
        conversationId,
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
        conversationId,
        seq: n.seq,
        trigger: str(value.trigger),
        turnToken: BigInt(num(value.turnToken)),
      },
    } as ProtobufRpcFrame;
  }
  if (n.method === NotifyTurnStarted) {
    return {
      id: 0n,
      body: { case: "turnStartedNotification", conversationId, seq: n.seq },
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
      conversationId,
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
    if (frame) decodeNotification(frame)?.deliver(handlers, n.createtime ?? 0);
  }
  return last;
}
