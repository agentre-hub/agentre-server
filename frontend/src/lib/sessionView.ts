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
import { statusConfig, type AgentStatus } from "@agentre-hub/agentre-ui";
import {
  ErrCodePeerExecutionUnavailable,
  type SessionSummary,
} from "@agentre-hub/agentre-wire";

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

          - **还没开始连**：页面刚挂载，`use-relay` 的初值就是 "disconnected"，
            此时 `/v1/devices` 也还没回来，`machineOnline` 是 null。
          - **连过又放弃了**：这才是 "lost"，横幅据此说「已经不再自动重试」。

        分不开的时候两种都算 lost，于是每一次打开任何一条对话都先闪一条红色横幅，
        横跨取设备 + 取中继票两个往返。瞬态与终态因此糊成一档，最刺眼的那一档
        警报变成了必经画面。

        判据用 `machineOnline === null`：机器在不在线是页面启动时问的第一件事，
        它还没有答案就说明这一屏根本还没开始连。
      */
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
 * 它有了自己的列（migration 202608200001 的 last_read_at），判据与桌面端
 * attention-store 的 `lastMessageAt > lastReadAt` 逐字一致，两端对「未读」的说法
 * 因此是同一个。
 *
 * 「未读」与「等你处理」是**两件事**：一条你已经看过、只是停在那儿等输入的对话
 * 不是未读；一条跑出了新结果但不等输入的是。索引摆的是「未读」，总览那条操作条
 * 摆的仍是「等你处理」——两个页面问的本来就不是同一个问题。
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
  s: {
    lifecycleState: string;
    waitingForInput?: boolean;
    /** 还没保存进账号的那些不算未读：它们压根不在你的账号里。 */
    saved?: boolean;
    updatedAt?: number;
    lastReadAt?: number;
  },
  filter: SessionFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "waiting") return !!s.waitingForInput;
  if (filter === "unread") {
    if (s.saved === false) return false;
    return (s.updatedAt ?? 0) > (s.lastReadAt ?? 0);
  }
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

function lifecycleLabel(state: string, t: Translate): string {
  switch (state) {
    case "running":
      return t("session.list.running");
    case "idle":
      return t("session.list.idle");
    case "interrupted":
      return t("session.list.interrupted");
    default:
      // 不认识的旧状态如实显示原文，不猜。
      return state;
  }
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
 * 这是本站关于「这条会话算什么状态」的**唯一**判定：等待输入盖过一切、
 * running=运行中、interrupted=出错，其余（idle 与不认识的旧状态）=闲置。
 */
export function toAgentStatus(s: {
  lifecycleState: string;
  waitingForInput?: boolean;
}): AgentStatus {
  if (s.waitingForInput) return "waiting";
  switch (s.lifecycleState) {
    case "running":
      return "running";
    case "interrupted":
      return "error";
    default:
      return "idle";
  }
}

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
