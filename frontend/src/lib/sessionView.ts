/**
 * 会话视图状态（R11）：七类失败与失效各自可区分，不折叠成同一个错误。
 *
 * 由纯函数 deriveSessionViewStatus 从底层信号导出，便于 vitest 直接构造各状态断言
 * 文案互不相同（测试接缝 6）。七类失败/失效状态：
 *   - machineOffline —— 目标 agentred 离线（既有措辞保持不变）
 *   - reconnecting / lost / connected —— 浏览器与 server 之间断线
 *   - loggedOut —— 账号已登出
 *   - desktopAppNotRunning —— 目标桌面端存在，但 Agentre App 没运行
 *   - pinnedAgentredUnavailable —— 桌面端在场且历史可读，但新写入无法送到钉住的 agentred
 *   - deviceRevoked —— 设备已从账号撤销，会话永久只读
 *
 * 优先级：账号登出 > 设备撤销 > 目标不可达 > 中继连接态 > 钉住的 agentred 不可写。
 * 账号没了其余全无意义；设备撤销时会话永久只读；目标不可达时
 * 中继必然连不上；钉住的 agentred 状态只在桌面中继仍连接时成立。
 */
import { SessionLifecycle, statusConfig } from "@agentre-hub/agentre-ui";
import {
  ErrCodePeerExecutionUnavailable,
  type SessionSummary,
} from "@agentre-hub/agentre-wire";

import {
  attentionReasonOf,
  toAgentStatus,
  type AttentionRowInput,
} from "@/lib/attentionAdapter";
import { RelayError, type RelayState } from "@/lib/relayClient";

// ── 对端返回的错误码 ───────────────────────────────────────────────────────
//
// 「执行目标不可用」那个码曾经在这里手抄过一份 —— 它当时是 internal/peer/inbound.go
// 的私有常量，改了那边这里不会有任何地方变红，只会静默降级成普通拒绝（横幅再也
// 不出现）。现在它已经移进 wire 包并纳入生成，从 constants.gen.ts import。
//
// 下面这个留在本地是**对的**，不是漏搬：它不是对端发出的码，而是本站自己的分类
// 阈值 —— 「对端收到并拒绝了」与「请求根本没走到对端」的分界，属于中继客户端的
// 语义，wire 协议里没有对应物。

/**
 * 远端 RPC 错误码段的上界(含):码 ≤ 此值 = 对端真的收到并拒绝了这次请求。
 * 中继客户端自己造的失败(连接未就绪 / 已断开 / 已关闭)用 -1,不在这一段里 ——
 * 「daemon 拒绝了」与「请求根本没走到 daemon」据此区分。
 */
const MaxPeerErrorCode = -32000;

export type SessionViewStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "lost"
  | "machineOffline"
  | "desktopAppNotRunning"
  | "pinnedAgentredUnavailable"
  | "deviceRevoked"
  | "loggedOut";

export interface SessionViewInput {
  /** 中继连接状态（RelayClient.onStateChange 的直接透传）。 */
  relayState: RelayState;
  /** /v1/auth/me 是否有效（false = 账号已登出）。 */
  meValid: boolean;
  /** 目标设备是否在线；desktop=false 表示 App 没运行，agentred=false 表示机器离线。 */
  machineOnline: boolean | null;
  targetKind?: "agentred" | "desktop" | string;
  /** 桌面端仍可读历史，但该会话钉住的 agentred 当前不可用于新写入。 */
  pinnedAgentredUnavailable?: boolean;
  /** 设备已从账号撤销，会话永久只读。 */
  deviceRevoked?: boolean;
  /**
   * 这一屏要连的那条通道**已经定下来了**吗。默认 true（不传 = 有目标）。
   *
   * false 说的是「目标还没解析出来」：入口分流要等账号那一行认领落定，而换对话
   * 时它整个重来一遍。这一段里 `use-relay` 手上没有目标，`relayState` 停在初值
   * "disconnected" —— 那是「还没开始连」，不是「连过又放弃了」。
   */
  relayTargetResolved?: boolean;
}

export function deriveSessionViewStatus(
  input: SessionViewInput,
): SessionViewStatus {
  const {
    relayState,
    meValid,
    machineOnline,
    targetKind,
    pinnedAgentredUnavailable,
    deviceRevoked,
    relayTargetResolved,
  } = input;
  if (!meValid) return "loggedOut";
  if (deviceRevoked) return "deviceRevoked";
  if (machineOnline === false) {
    return targetKind === "desktop" ? "desktopAppNotRunning" : "machineOffline";
  }
  if (relayState === "connected" && pinnedAgentredUnavailable) {
    return "pinnedAgentredUnavailable";
  }
  switch (relayState) {
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "connecting":
      return "connecting";
    default:
      /*
        default 就是 relayState === "disconnected"。它有两种来历，说的不是同一件事：

          - **还没开始连**：`use-relay` 手上还没有目标，状态停在初值 "disconnected"。
          - **连过又放弃了**：这才是 "lost"，横幅据此说「已经不再自动重试」。

        分不开的时候两种都算 lost，于是每打开或每切一条对话都先闪一条红色横幅。
        瞬态与终态因此糊成一档，最刺眼的那一档警报变成了必经画面。

        「还没开始连」有两副面孔，两条判据各接一段：

          - **刚挂载**：`/v1/devices` 还没回来，`machineOnline` 是 null。机器在不
            在线是页面启动时问的第一件事，它还没有答案就说明这一屏根本还没开始连。
          - **换对话**：`machineOnline` 属于设备轴、不随会话重置，切同一台机器上
            的另一条对话时它一直是 true，上一条判据接不住。这一段真正还没定下来
            的是**通道目标**（认领要重来一遍），所以由调用方直说。
      */
      if (relayTargetResolved === false) return "connecting";
      return machineOnline === null ? "connecting" : "lost";
  }
}

/**
 * 一次写入请求（runtime.run / runtime.steer）失败的分类。三类互不相同，界面据此
 * 给出各自的反馈，而不是把所有失败折叠成同一个态：
 *
 *  - executionUnavailable —— 对端明确回了「执行目标不可用」的专属码（-32015）。
 *    只有这一类才是「这条会话钉住的 agentred 当前不可用」。
 *  - rejected —— 对端收到了请求并拒绝了它（任意远端 RPC 错误码）。detail 是对端
 *    自己的说明，已由它本地化过，原样交给用户看。
 *  - transport —— 请求根本没走到对端（socket 未就绪 / 刚断 / 客户端已关闭，或抛出
 *    的压根不是 RelayError）。这一类**不能**当成「对端拒绝了」重试：请求可能已经
 *    送达，重发会多出一条消息。
 *
 * 为什么不按 message 文本判「会话正忙」：daemon 的 ChatSendInFlight 经
 * `internal/daemon/rpc/conn.go` 落成 -32603 + **本地化**的 message，没有专属错误码。
 * 按字符串匹配既脆又跟着对端语言变，所以正忙不在这里判——见 SessionDetailView
 * 的选路 + 一次回落。
 */
export type SendFailureKind = "executionUnavailable" | "rejected" | "transport";

export interface SendFailure {
  kind: SendFailureKind;
  /** 对端自己的说明（仅 rejected 有）。 */
  detail?: string;
}

export function classifySendFailure(err: unknown): SendFailure {
  if (!(err instanceof RelayError)) return { kind: "transport" };
  if (err.code === ErrCodePeerExecutionUnavailable) {
    return { kind: "executionUnavailable" };
  }
  if (err.code > MaxPeerErrorCode) return { kind: "transport" };
  const detail = err.message.trim();
  return detail ? { kind: "rejected", detail } : { kind: "rejected" };
}

/** 共享实现统一两端的单位边界、未来时间语义与 formatter 缓存。 */
export { formatIntlRelativeTime as formatRelativeTime } from "@agentre-hub/agentre-ui";

/**
 * 会话索引 UX 的纯函数：筛选 chips、搜索、行标题、状态点。全部无副作用，便于
 * vitest 直接断言行为（见 session-status.test.tsx 的「sessionView 纯函数」一组）。
 */

/**
 * 筛选的取值。all = 不过滤；running = 运行中且不等待输入；waiting = 正在等你处理；
 * unread = 最后一次活动晚于这个账号最后一次读它。
 *
 * `unread` 曾经是个假名字：那一档叫过「未读」，判据却是 `waitingForInput`，规格
 * 2026-08-17 决策 3 因此把名字改成了「等你处理」——当时 web 侧没有已读状态。现在
 * 它有了自己的列（migration 202608200001 的 last_read_at），判据是共享包
 * `computeAttention` 的 `unread` 那一档，两端对「未读」的说法因此是同一个。
 *
 * 「未读」与「等你处理」是**两件事**：一条你已经看过、只是停在那儿等输入的对话
 * 不是未读；一条跑出了新结果但不等输入的是。索引摆的是「未读」；「等你处理」与它
 * 一起进侧栏那颗角标（AppShell 的 badge / badgeLabel），在那里分开说。
 *
 * 光有「两件事」还不够——2026-09-04 之前这三处各写各的判据：侧栏数
 * `waiting_for_input`，chip 数 `last_message_at > last_read_at`，行上的记号走
 * `computeAttention`。三个数互不相等，而且没有任何地方会报错。现在只有一条判据
 * （服务端 `attentionExpr`，前端一律经由 `attentionReasonOf`）。
 */
export type SessionFilter = "all" | "running" | "waiting" | "unread";

/**
 * 一条会话是否落在某个筛选下。判据与服务端 `agent_session_repo` 的 `scoped` 逐字一致：
 * 只有机器轴那一档在本地筛（那份清单是机器实时报的，没经过服务端）。
 *
 * 「正在等输入」是运行之上的实时叠加：它不进「运行中」（等你处理优先），
 * 只进「等你处理」；其余按生命周期是否 running 判定。
 */
export function matchesSessionFilter(
  s: AttentionRowInput,
  filter: SessionFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "waiting") return !!s.waitingForInput;
  // 「未读」不在这里判：它是共享包 computeAttention 最弱的那一档，判据带着比它强的
  // 那几档的否定（在跑的、等你按的、跑挂的都不算）。本地另写一遍 `updatedAt >
  // lastReadAt` 是此前的做法，代价是同一批行在机器轴与其余三个轴上筛出来的结果不同，
  // 而 chip 上那个数又是第三处判据数出来的。
  if (filter === "unread") return attentionReasonOf(s) === "unread";
  return s.lifecycleState === "running" && !s.waitingForInput;
}

/**
 * 会话行搜索（任务 6）：把一行会话的可搜字段（标题 / cwd / 后端 / 设备名 / 所在
 * Agent 名）交给 matchesRowSearch，判断是否命中。空查询恒为 true（不过滤）。
 * 大小写不敏感。桌面列表的搜索框只做这件真实的事——匹配本页会话行，不伪造搜索。
 */
export function matchesRowSearch(
  fields: Array<string | undefined>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => !!f && f.toLowerCase().includes(q));
}

/** i18n 的取词函数。这一层只用得上这一个形状，不引整个 react-i18next 的类型。 */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 每一档生命周期在本站的说法。词表取共享包的 `SessionLifecycle`（它转出来正是为了
 * 让宿主挑文案时不必再抄一份字面量），文案 key 留在本站 —— 桌面端那一处叫
 * `remoteDevices.desktop.session.*`，两端的措辞本来就不是同一套。
 */
const LIFECYCLE_LABEL_KEY: Record<string, string> = {
  [SessionLifecycle.running]: "session.list.running",
  [SessionLifecycle.idle]: "session.list.idle",
  [SessionLifecycle.interrupted]: "session.list.interrupted",
  [SessionLifecycle.failed]: "session.list.failed",
};

function lifecycleLabel(state: string, t: Translate): string {
  const key = LIFECYCLE_LABEL_KEY[state];
  // 不认识的旧状态如实显示原文，不猜。
  return key ? t(key) : state;
}

/**
 * 会话状态的本地化文字。
 *
 * 移动端行尾靠它兜底：共享包 `StatusDot` 的可访问名是 `waiting status` 这类固定
 * 英文状态码（包的既定约定），所以行上必须另有一处本地化的、看得见的状态文字——
 * 状态不能只剩一个颜色（规格 2026-08-17「已知的可见变化」3）。
 * 「正在等输入」盖过生命周期，与 statusDotClass / toAgentStatus 同一条判定。
 */
export function sessionStatusLabel(
  s: { lifecycleState: string; waitingForInput?: boolean },
  t: Translate,
): string {
  return s.waitingForInput
    ? t("session.list.waiting")
    : lifecycleLabel(s.lifecycleState, t);
}

/**
 * 会话行的标题。标题由首条消息派生，所以还没发出第一句的会话既没有标题也没有
 * Agent 标识，如实退化为「工作目录 · 后端 · 状态」——不猜标题、不填占位名。
 */
export function sessionTitle(
  s: Pick<SessionSummary, "title" | "cwd" | "backendType" | "lifecycleState">,
  t: Translate,
): string {
  if (s.title?.trim()) return s.title;
  return t("session.list.untitled", {
    cwd: s.cwd?.trim() ? s.cwd : "—",
    backend: s.backendType?.trim() ? s.backendType : "—",
    status: lifecycleLabel(s.lifecycleState, t),
  });
}

/**
 * 会话状态 → 共享包 `SessionRow` / `StatusDot` 的 AgentStatus。
 *
 * 判定本身住在共享包（`lifecycleToAgentStatus`），与桌面端逐字同源 —— 此前两端各
 * 有一份 switch，2026-09-04 它们真的分了叉：本站把 `interrupted` 也折进出错那一档，
 * 而那是 agentred 每次重启后所有非终态会话的**常态**（daemon.New 的 R10 整批标记），
 * `Mirror.Revive` 对仍是 interrupted 的又刻意不试接入。联调机上重启一次，账号里
 * 29 条对话在同一个 305 毫秒窗口里全变红且永不复原。红只留给 `failed`。
 *
 * 留在本站的只有**入参形状**：账号镜像那一行把「有东西等你按」记成 `waitingForInput`，
 * 包那一侧叫 `waiting`。名字的转译是宿主的事，判定不是。
 *
 * 归中性档不等于这条对话没话说：状态文字仍由 `sessionStatusLabel` 分家（「已中断」
 * 与「空闲」是两句话），点只回答「要不要紧」。
 */
export { toAgentStatus };

/**
 * 行首状态点的颜色。判定走上面那一处，类名走共享包的 `statusConfig`。
 *
 * 此前这里是一份独立的 switch，与 `toAgentStatus` 是同一套判定的两个投影，
 * 靠「并排放着，改一处时另一处就在眼前」维持一致 —— 那是纪律，不是机械保证。
 * 色值同理：本站抄一份类名，桌面端改了色流不过来。现在两样都只有一处。
 */
export function statusDotClass(s: {
  lifecycleState: string;
  waitingForInput?: boolean;
}): string {
  return statusConfig[toAgentStatus(s)].dotClassName;
}

/**
 * token 计数的显示格式。实现来自共享包 `@agentre-hub/agentre-ui`，本站不再留一份
 * —— 此前这里与桌面端 `chat.tsx` 是**逐字节相同**的两段代码。
 */
export { formatTokens } from "@agentre-hub/agentre-ui";

/**
 * Composer 底栏那条「上下文用量」。判据在共享包里（本站与桌面端 `chat-panel-
 * context-usage.ts` 此前是逐条对照写出来的两份），本站只是把它按原名转出来：
 *
 *   - 窗口 <= 0 → 整块不显示。0 是「runtime 还没探到」（Go 侧 ContextWindowUpdated
 *     的原话），不是「窗口为 0」；拿它当分母就是画一条编出来的进度条。
 *   - 用量取**从后往前**第一条报得出 totalInputTokens 的助手消息。前面那些是这一轮
 *     之前的快照，用它们会让进度条往回跳。
 *   - 一条都没报过 → `{ used: 0, max }`。窗口本身已经是真的了，摆一条 0% 的进度条
 *     比整块消失更接近事实。
 *
 * 包里那份多一个可选的 `liveUsage`（桌面端流式 usage 那条通道），本站不传 ——
 * 中转事件流里没有它，不传时行为与本站原先那份逐条相同。
 */
export { computeContextUsage } from "@agentre-hub/agentre-ui";
