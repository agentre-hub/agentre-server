/**
 * wire:agentre ↔ agentred RPC 协议的 TypeScript 编解码。
 *
 * 与 Go 侧 `internal/pkg/agentruntime/runtimes/remote/wire/wire.go` **逐字段同构**:
 * 帧类型、字段名(lowerCamelCase)、可选性(omitempty)完全照抄 Go 的 JSON tag。
 * 正确性由 `frontend/src/__tests__/wire-codec.test.ts` 保证 —— 它读 Go 侧生成器
 * (`agentre` 仓 wire 包里的 golden_test.go)产出的黄金样本,断言 TS 解出的结构与
 * Go 真实 marshaler 的字节完全一致。
 *
 * 未知字段不丢弃:解码时把 codec 不认识的 JSON 键原样留在对象顶层
 * (WireObject 的索引签名),编码时随已知字段一起序列化出去。老版本 agentred /
 * 未来扩展多加的字段不会在这一层被吃掉。
 */
export interface WireObject {
  /** 本 codec 不认识的键原样保留;编码时随已知字段一起输出。 */
  [key: string]: unknown;
}

// ── RPC method 名(与 Go wire.Method* 同源)─────────────────────────────────

export const MethodSessionList = "runtime.session.list";
export const MethodSessionPull = "runtime.session.pull";
export const MethodSessionPendingWaiters = "runtime.session.pendingWaiters";
export const MethodSessionAttach = "runtime.session.attach";
export const MethodRun = "runtime.run";
export const MethodSubmitAnswer = "runtime.submitAnswer";
export const MethodSubmitToolPermission = "runtime.submitToolPermission";

/** daemon → 浏览器 通知。 */
export const NotifyEvent = "runtime.event";
export const NotifyRunResultDone = "runtime.runResultDone";
export const NotifyAutonomousTurnStarted = "runtime.autonomousTurn.started";
export const NotifyAutonomousTurnEvent = "runtime.autonomousTurn.event";
export const NotifyAutonomousTurnDone = "runtime.autonomousTurn.done";

/** 会话生命周期(与 Go SessionLifecycle* 同源)。 */
export const SessionLifecycleRunning = "running";
export const SessionLifecycleIdle = "idle";
export const SessionLifecycleInterrupted = "interrupted";

export const DefaultSessionPullLimit = 200;
export const MaxSessionPullLimit = 1000;

// ── 解码基础设施 ────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function asObject(v: unknown, what: string): JsonObject {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new TypeError(`wire: ${what} 应是 JSON 对象,实际是 ${typeof v}`);
  }
  return v as JsonObject;
}

function reqNum(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TypeError(`wire: ${what} 缺少必填数字字段`);
  }
  return v;
}

function reqStr(v: unknown, what: string): string {
  if (typeof v !== "string") {
    throw new TypeError(`wire: ${what} 缺少必填字符串字段`);
  }
  return v;
}

function optNum(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined;
  return reqNum(v, what);
}

function optStr(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  return reqStr(v, what);
}

function optBool(v: unknown, what: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new TypeError(`wire: ${what} 布尔字段类型错误`);
  }
  return v;
}

/**
 * 通用解码骨架:复制原对象(未知字段因此保留在顶层),再把已知字段逐个
 * 强类型化(coerce)。coerce 里对缺失可选字段赋值 undefined,对象里不会有
 * 这条键 —— 与 Go omitempty 省略零值的行为一致。
 */
function decodeWire<T>(
  v: unknown,
  what: string,
  coerce: (o: JsonObject) => void,
): T {
  const src = asObject(v, what);
  const out: JsonObject = { ...src };
  coerce(out);
  return out as unknown as T;
}

// ── 帧类型与解码 ────────────────────────────────────────────────────────────

/** mirror provider.Usage(Go UsageWire)。 */
export interface UsageWire extends WireObject {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export function decodeUsageWire(v: unknown): UsageWire {
  return decodeWire<UsageWire>(v, "UsageWire", (o) => {
    o.promptTokens = reqNum(o.promptTokens, "UsageWire.promptTokens");
    o.completionTokens = reqNum(
      o.completionTokens,
      "UsageWire.completionTokens",
    );
    o.reasoningTokens = reqNum(o.reasoningTokens, "UsageWire.reasoningTokens");
    o.cachedTokens = reqNum(o.cachedTokens, "UsageWire.cachedTokens");
    o.cacheCreationTokens = reqNum(
      o.cacheCreationTokens,
      "UsageWire.cacheCreationTokens",
    );
    o.totalTokens = reqNum(o.totalTokens, "UsageWire.totalTokens");
  });
}

/** mirror blocks.StoredBlock(`{type,data}` 信封)。 */
export interface StoredBlock extends WireObject {
  type: string;
  data?: unknown;
}

/** mirror HistoryMessageWire。 */
export interface HistoryMessageWire extends WireObject {
  role: string;
  blocks?: StoredBlock[];
}

function decodeHistoryMessageWire(v: unknown): HistoryMessageWire {
  return decodeWire<HistoryMessageWire>(v, "HistoryMessageWire", (o) => {
    o.role = reqStr(o.role, "HistoryMessageWire.role");
    if (o.blocks !== undefined) {
      if (!Array.isArray(o.blocks)) {
        throw new TypeError("wire: HistoryMessageWire.blocks 应是数组");
      }
      o.blocks = (o.blocks as unknown[]).map(decodeStoredBlock);
    }
  });
}

function decodeStoredBlock(v: unknown): StoredBlock {
  return decodeWire<StoredBlock>(v, "StoredBlock", (o) => {
    o.type = reqStr(o.type, "StoredBlock.type");
  });
}

/**
 * mirror RunParams(Go wire.go)。backend 是 json.RawMessage 透传,TS 侧原样保留。
 * mcpServers 里的 MCPServerSpec 没有 JSON tag(Go 默认 PascalCase),这里不做深度
 * 类型化,原样透传 —— 编解码同构不依赖它。
 */
export interface RunParams extends WireObject {
  backend?: unknown;
  agentId?: number;
  sessionId: number;
  cwd?: string;
  /** R7:会话标题,桌面端每轮携带,daemon 幂等覆盖。 */
  title?: string;
  /** 块 1 的账号级 Agent 同步标识(决策 3 的 ULID,不是本地自增 agent_id)。 */
  agentSyncId?: string;
  systemPrompt?: string;
  /** 决策 8:续话要用的 provider 原生会话身份。 */
  providerSessionId?: string;
  userText?: string;
  userBlocks?: unknown[];
  history?: HistoryMessageWire[];
  compact?: boolean;
  forkAnchor?: string;
  permissionMode?: string;
  collaborationMode?: string;
  mcpServers?: unknown[];
  enabledPlugins?: Record<string, boolean>;
  llmProviderKey?: string;
  /** R18:「开新一轮」发起方设备指纹。 */
  sourceDevice?: string;
  /** R18:发起方设备显示名(如「Chrome · macOS」)。 */
  sourceDeviceName?: string;
}

export function decodeRunParams(v: unknown): RunParams {
  return decodeWire<RunParams>(v, "RunParams", (o) => {
    o.agentId = optNum(o.agentId, "RunParams.agentId");
    o.sessionId = reqNum(o.sessionId, "RunParams.sessionId");
    o.cwd = optStr(o.cwd, "RunParams.cwd");
    o.title = optStr(o.title, "RunParams.title");
    o.agentSyncId = optStr(o.agentSyncId, "RunParams.agentSyncId");
    o.systemPrompt = optStr(o.systemPrompt, "RunParams.systemPrompt");
    o.providerSessionId = optStr(
      o.providerSessionId,
      "RunParams.providerSessionId",
    );
    o.userText = optStr(o.userText, "RunParams.userText");
    if (o.history !== undefined) {
      if (!Array.isArray(o.history)) {
        throw new TypeError("wire: RunParams.history 应是数组");
      }
      o.history = (o.history as unknown[]).map(decodeHistoryMessageWire);
    }
    o.compact = optBool(o.compact, "RunParams.compact");
    o.forkAnchor = optStr(o.forkAnchor, "RunParams.forkAnchor");
    o.permissionMode = optStr(o.permissionMode, "RunParams.permissionMode");
    o.collaborationMode = optStr(
      o.collaborationMode,
      "RunParams.collaborationMode",
    );
    if (
      o.enabledPlugins !== undefined &&
      typeof o.enabledPlugins !== "object"
    ) {
      throw new TypeError("wire: RunParams.enabledPlugins 应是对象");
    }
    o.llmProviderKey = optStr(o.llmProviderKey, "RunParams.llmProviderKey");
    o.sourceDevice = optStr(o.sourceDevice, "RunParams.sourceDevice");
    o.sourceDeviceName = optStr(
      o.sourceDeviceName,
      "RunParams.sourceDeviceName",
    );
  });
}

/** mirror RunAck。 */
export interface RunAck extends WireObject {
  sessionId: number;
  providerSessionId?: string;
  launchPermissionMode?: string;
  providerFallbackKey?: string;
}

export function decodeRunAck(v: unknown): RunAck {
  return decodeWire<RunAck>(v, "RunAck", (o) => {
    o.sessionId = reqNum(o.sessionId, "RunAck.sessionId");
    o.providerSessionId = optStr(
      o.providerSessionId,
      "RunAck.providerSessionId",
    );
    o.launchPermissionMode = optStr(
      o.launchPermissionMode,
      "RunAck.launchPermissionMode",
    );
    o.providerFallbackKey = optStr(
      o.providerFallbackKey,
      "RunAck.providerFallbackKey",
    );
  });
}

/** mirror SessionSummary(R7 + 决策 8 的新列:title / agentSyncId / providerSessionId)。 */
export interface SessionSummary extends WireObject {
  sessionId: number;
  /** 别的对端发起的会话才带(账号可见性下学 origin 的来源)。 */
  peerFingerprint?: string;
  agentId?: number;
  title?: string;
  agentSyncId?: string;
  providerSessionId?: string;
  cwd?: string;
  backendType?: string;
  lifecycleState: string;
  waitingForInput?: boolean;
  latestSeq: number;
}

export function decodeSessionSummary(v: unknown): SessionSummary {
  return decodeWire<SessionSummary>(v, "SessionSummary", (o) => {
    o.sessionId = reqNum(o.sessionId, "SessionSummary.sessionId");
    o.peerFingerprint = optStr(
      o.peerFingerprint,
      "SessionSummary.peerFingerprint",
    );
    o.agentId = optNum(o.agentId, "SessionSummary.agentId");
    o.title = optStr(o.title, "SessionSummary.title");
    o.agentSyncId = optStr(o.agentSyncId, "SessionSummary.agentSyncId");
    o.providerSessionId = optStr(
      o.providerSessionId,
      "SessionSummary.providerSessionId",
    );
    o.cwd = optStr(o.cwd, "SessionSummary.cwd");
    o.backendType = optStr(o.backendType, "SessionSummary.backendType");
    o.lifecycleState = reqStr(
      o.lifecycleState,
      "SessionSummary.lifecycleState",
    );
    o.waitingForInput = optBool(
      o.waitingForInput,
      "SessionSummary.waitingForInput",
    );
    o.latestSeq = reqNum(o.latestSeq, "SessionSummary.latestSeq");
  });
}

/** mirror SessionListResult。 */
export interface SessionListResult extends WireObject {
  sessions: SessionSummary[];
}

export function decodeSessionListResult(v: unknown): SessionListResult {
  return decodeWire<SessionListResult>(v, "SessionListResult", (o) => {
    if (!Array.isArray(o.sessions)) {
      throw new TypeError("wire: SessionListResult.sessions 应是数组");
    }
    o.sessions = (o.sessions as unknown[]).map(decodeSessionSummary);
  });
}

/** mirror SessionPullParams。cursor 是**已收到**的最后一个 seq(独占),首次传 0。 */
export interface SessionPullParams extends WireObject {
  sessionId: number;
  peerFingerprint?: string;
  cursor: number;
  limit?: number;
}

export function decodeSessionPullParams(v: unknown): SessionPullParams {
  return decodeWire<SessionPullParams>(v, "SessionPullParams", (o) => {
    o.sessionId = reqNum(o.sessionId, "SessionPullParams.sessionId");
    o.peerFingerprint = optStr(
      o.peerFingerprint,
      "SessionPullParams.peerFingerprint",
    );
    o.cursor = reqNum(o.cursor, "SessionPullParams.cursor");
    o.limit = optNum(o.limit, "SessionPullParams.limit");
  });
}

/** mirror JournaledNotification。params **不含 seq** —— seq 是日志行自己的列。 */
export interface JournaledNotification extends WireObject {
  seq: number;
  method: string;
  params: unknown;
}

export function decodeJournaledNotification(v: unknown): JournaledNotification {
  return decodeWire<JournaledNotification>(v, "JournaledNotification", (o) => {
    o.seq = reqNum(o.seq, "JournaledNotification.seq");
    o.method = reqStr(o.method, "JournaledNotification.method");
  });
}

/** mirror SessionPullResult。 */
export interface SessionPullResult extends WireObject {
  notifications?: JournaledNotification[];
  cursor: number;
  hasMore: boolean;
  oldestSeq?: number;
}

export function decodeSessionPullResult(v: unknown): SessionPullResult {
  return decodeWire<SessionPullResult>(v, "SessionPullResult", (o) => {
    if (o.notifications !== undefined) {
      if (!Array.isArray(o.notifications)) {
        throw new TypeError("wire: SessionPullResult.notifications 应是数组");
      }
      o.notifications = (o.notifications as unknown[]).map(
        decodeJournaledNotification,
      );
    }
    o.cursor = reqNum(o.cursor, "SessionPullResult.cursor");
    o.hasMore = optBool(o.hasMore, "SessionPullResult.hasMore") ?? false;
    o.oldestSeq = optNum(o.oldestSeq, "SessionPullResult.oldestSeq");
  });
}

/** mirror SessionAttachParams(显式接管)。 */
export interface SessionAttachParams extends WireObject {
  sessionId: number;
  peerFingerprint?: string;
}

export function decodeSessionAttachParams(v: unknown): SessionAttachParams {
  return decodeWire<SessionAttachParams>(v, "SessionAttachParams", (o) => {
    o.sessionId = reqNum(o.sessionId, "SessionAttachParams.sessionId");
    o.peerFingerprint = optStr(
      o.peerFingerprint,
      "SessionAttachParams.peerFingerprint",
    );
  });
}

/** mirror SessionAttachResult。 */
export interface SessionAttachResult extends WireObject {
  sessionId: number;
  backendType?: string;
  lifecycleState: string;
  latestSeq: number;
}

export function decodeSessionAttachResult(v: unknown): SessionAttachResult {
  return decodeWire<SessionAttachResult>(v, "SessionAttachResult", (o) => {
    o.sessionId = reqNum(o.sessionId, "SessionAttachResult.sessionId");
    o.backendType = optStr(o.backendType, "SessionAttachResult.backendType");
    o.lifecycleState = reqStr(
      o.lifecycleState,
      "SessionAttachResult.lifecycleState",
    );
    o.latestSeq = reqNum(o.latestSeq, "SessionAttachResult.latestSeq");
  });
}

/** mirror SessionPendingWaitersParams。 */
export interface SessionPendingWaitersParams extends WireObject {
  sessionId: number;
  peerFingerprint?: string;
}

export function decodeSessionPendingWaitersParams(
  v: unknown,
): SessionPendingWaitersParams {
  return decodeWire<SessionPendingWaitersParams>(
    v,
    "SessionPendingWaitersParams",
    (o) => {
      o.sessionId = reqNum(
        o.sessionId,
        "SessionPendingWaitersParams.sessionId",
      );
      o.peerFingerprint = optStr(
        o.peerFingerprint,
        "SessionPendingWaitersParams.peerFingerprint",
      );
    },
  );
}

/**
 * mirror SessionPendingWaitersResult。toolPermissions / askUserQuestions 里的
 * waiter 结构(agentruntime.PendingToolPermission 等)没有 JSON tag(Go 默认
 * PascalCase),这里原样透传 —— 审批 / 提问卡在消费端按需解析。
 */
export interface SessionPendingWaitersResult extends WireObject {
  toolPermissions?: unknown[];
  askUserQuestions?: unknown[];
}

export function decodeSessionPendingWaitersResult(
  v: unknown,
): SessionPendingWaitersResult {
  return decodeWire<SessionPendingWaitersResult>(
    v,
    "SessionPendingWaitersResult",
    (o) => {
      for (const k of ["toolPermissions", "askUserQuestions"]) {
        if (o[k] !== undefined && !Array.isArray(o[k])) {
          throw new TypeError(
            `wire: SessionPendingWaitersResult.${k} 应是数组`,
          );
        }
      }
    },
  );
}

/** mirror EventFrame。 */
export interface EventFrame extends WireObject {
  sessionId: number;
  event?: unknown;
  seq?: number;
}

export function decodeEventFrame(v: unknown): EventFrame {
  return decodeWire<EventFrame>(v, "EventFrame", (o) => {
    o.sessionId = reqNum(o.sessionId, "EventFrame.sessionId");
    o.seq = optNum(o.seq, "EventFrame.seq");
  });
}

/** mirror RunResultDoneFrame。 */
export interface RunResultDoneFrame extends WireObject {
  sessionId: number;
  providerSessionId?: string;
  usage?: UsageWire | null;
  userAnchor?: string;
  model?: string;
  contextWindow?: number;
  turnToken?: number;
  stopErrMsg?: string;
  stopErrCode?: number;
  seq?: number;
}

export function decodeRunResultDoneFrame(v: unknown): RunResultDoneFrame {
  return decodeWire<RunResultDoneFrame>(v, "RunResultDoneFrame", (o) => {
    o.sessionId = reqNum(o.sessionId, "RunResultDoneFrame.sessionId");
    o.providerSessionId = optStr(
      o.providerSessionId,
      "RunResultDoneFrame.providerSessionId",
    );
    if (o.usage !== undefined && o.usage !== null) {
      o.usage = decodeUsageWire(o.usage);
    }
    o.userAnchor = optStr(o.userAnchor, "RunResultDoneFrame.userAnchor");
    o.model = optStr(o.model, "RunResultDoneFrame.model");
    o.contextWindow = optNum(
      o.contextWindow,
      "RunResultDoneFrame.contextWindow",
    );
    o.turnToken = optNum(o.turnToken, "RunResultDoneFrame.turnToken");
    o.stopErrMsg = optStr(o.stopErrMsg, "RunResultDoneFrame.stopErrMsg");
    o.stopErrCode = optNum(o.stopErrCode, "RunResultDoneFrame.stopErrCode");
    o.seq = optNum(o.seq, "RunResultDoneFrame.seq");
  });
}

/** mirror AutonomousTurnStartedFrame。 */
export interface AutonomousTurnStartedFrame extends WireObject {
  sessionId: number;
  trigger?: string;
  turnToken?: number;
  seq?: number;
}

export function decodeAutonomousTurnStartedFrame(
  v: unknown,
): AutonomousTurnStartedFrame {
  return decodeWire<AutonomousTurnStartedFrame>(
    v,
    "AutonomousTurnStartedFrame",
    (o) => {
      o.sessionId = reqNum(o.sessionId, "AutonomousTurnStartedFrame.sessionId");
      o.trigger = optStr(o.trigger, "AutonomousTurnStartedFrame.trigger");
      o.turnToken = optNum(o.turnToken, "AutonomousTurnStartedFrame.turnToken");
      o.seq = optNum(o.seq, "AutonomousTurnStartedFrame.seq");
    },
  );
}

// ── JSON-RPC 信封(daemon/rpc.Frame 同 shape)──────────────────────────────

export interface WireError extends WireObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface WireFrame extends WireObject {
  jsonrpc: string;
  /** 请求/响应才有;通知缺省。Go 侧是 json.RawMessage,协议里用 number/string。 */
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: WireError | null;
}

export function decodeWireError(v: unknown): WireError {
  return decodeWire<WireError>(v, "Frame.error", (o) => {
    o.code = reqNum(o.code, "error.code");
    o.message = reqStr(o.message, "error.message");
  });
}

export function decodeFrame(v: unknown): WireFrame {
  return decodeWire<WireFrame>(v, "Frame", (o) => {
    o.jsonrpc = reqStr(o.jsonrpc, "Frame.jsonrpc");
    if (
      o.id !== undefined &&
      typeof o.id !== "number" &&
      typeof o.id !== "string" &&
      o.id !== null
    ) {
      throw new TypeError("wire: Frame.id 只支持 number/string/null");
    }
    if (o.method !== undefined) {
      o.method = reqStr(o.method, "Frame.method");
    }
    if (o.error !== undefined && o.error !== null) {
      o.error = decodeWireError(o.error);
    }
  });
}

// ── 编码 ────────────────────────────────────────────────────────────────────

/**
 * 编码即 JSON.stringify:解码对象把未知字段留在顶层,已知字段与 Go 同键名,
 * 序列化出去就是协议字节。encode 与 decode 互为逆(黄金样本测试断言
 * decode → encode → parse 与原始帧逐字段相同)。
 */
export function encodeWire(v: unknown): string {
  return JSON.stringify(v);
}

export function encodeFrame(f: WireFrame): string {
  return encodeWire(f);
}

export function encodeRunParams(p: RunParams): string {
  return encodeWire(p);
}

export function encodeRunAck(a: RunAck): string {
  return encodeWire(a);
}

export function encodeSessionPullParams(p: SessionPullParams): string {
  return encodeWire(p);
}

export function encodeSessionAttachParams(p: SessionAttachParams): string {
  return encodeWire(p);
}

export function encodeSessionPendingWaitersParams(
  p: SessionPendingWaitersParams,
): string {
  return encodeWire(p);
}

export function encodeEventFrame(f: EventFrame): string {
  return encodeWire(f);
}

export function encodeRunResultDoneFrame(f: RunResultDoneFrame): string {
  return encodeWire(f);
}

export function encodeSessionPullResult(r: SessionPullResult): string {
  return encodeWire(r);
}
