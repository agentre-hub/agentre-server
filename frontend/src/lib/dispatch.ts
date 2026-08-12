/**
 * R15 / R16 的派发逻辑（从 web 发起新对话）。
 *
 * 与 Go 侧 workspace_svc.WebDispatchPlan 的视图对象同构：
 *   - 计划按序列出执行目标链每一档的原因（available / offline / unpaired /
 *     skipped_for_web / project_path_missing），Chosen 为 null = 全部档都不可用；
 *   - R15d 守卫：device_id 为空的「本机」档在浏览器语境下跳过，只在 agentred 里
 *     按顺序取第一档可用的；
 *   - R16：runtime.run 成功后立刻把自己这条会话关注上（账号级名单），于是它不经
 *     「关注」就出现在「对话」页——浏览器不持有任何会话内容，这条也符合硬不变量
 *     （server 存的仍是「指向」，不是会话内容）。
 *   - R17：不注入 mcpServers（org / subagent / hook 的真身在桌面端），发起前由
 *     界面说明（见 NewConversationDialog 的确认步）。
 *
 * 路径（Cwd）随确认派发阶段的计划到达浏览器，供屏幕 25 呈现与派发 runtime.run——
 * 这是 R19 红线在主动派活场景下的唯一例外（见 workspace_svc.WebDispatchChoice）。
 */
import { api } from "@/lib/api";
import { RelayClient } from "@/lib/relayClient";
import { relayClientUrl } from "@/lib/relayUrl";
import { deviceDisplayName, type WebDevice } from "@/lib/webDevice";
import { decodeRunAck, MethodRun, type RunParams } from "@/lib/wire";

export type DispatchAvailability =
  | "available"
  | "offline"
  | "unpaired"
  | "skipped_for_web"
  | "project_path_missing";

export interface DispatchTier {
  rank: number;
  device_id?: number;
  device_name?: string;
  backend_type?: string;
  /** 目标设备种类（desktop / agentred）；无设备的档（本机相对 / 未配对）没有它。 */
  kind?: string;
  availability: DispatchAvailability;
  current: boolean;
}

export interface DispatchChoice {
  device_fingerprint: string;
  device_id: number;
  device_name: string;
  backend_type: string;
  /** 目标设备种类：desktop → org/subagent/hook 可用（R17），agentred → 不可用。 */
  kind?: string;
  cwd?: string;
}

export interface DispatchPlan {
  agent_sync_id: string;
  tiers: DispatchTier[];
  chosen: DispatchChoice | null;
  projects: { sync_id: string; name: string; configured: boolean }[];
}

/** 取某 Agent（+ 可选项目）的派发计划。project_sync_id 为空 = picker 阶段只看机器。 */
export async function fetchDispatchPlan(
  agentSyncId: string,
  projectSyncId?: string,
): Promise<DispatchPlan> {
  const qs = new URLSearchParams({ agent_sync_id: agentSyncId });
  if (projectSyncId) qs.set("project_sync_id", projectSyncId);
  return api<DispatchPlan>(`/v1/workspace/dispatch-target?${qs.toString()}`);
}

/** R15d 守卫：跳过 device_id 为空的档，取按序第一档可用的 agentred。 */
export function pickFirstAvailable(tiers: DispatchTier[]): DispatchTier | null {
  return tiers.find((t) => t.availability === "available") ?? null;
}

/** 新建会话的本地会话标识：正整数、非零（wire sessionId 语义，按对端隔离）。 */
export function newSessionId(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
}

/** 标题派生：首行 + 视觉截断（镜像桌面端 sessionTitleFromFirstMessage）。 */
export function deriveTitle(text: string): string {
  const first = text.trim().split("\n")[0]?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

export interface DispatchedSession {
  sessionId: number;
  deviceId: number;
  deviceFingerprint: string;
}

export interface DispatchInput {
  plan: DispatchPlan;
  message: string;
  sourceDevice: WebDevice;
}

/**
 * 发起：连到选中的那台 agentred → runtime.run（新会话）→ 立刻关注自己这条（R16）。
 * 连接失败 / 派发失败都会抛错，由界面就地说明，不静默。
 */
export async function dispatchNewConversation(
  input: DispatchInput,
): Promise<DispatchedSession> {
  const choice = input.plan.chosen;
  if (!choice) throw new Error("no available exec target");
  const params: RunParams = {
    sessionId: newSessionId(),
    title: deriveTitle(input.message),
    agentSyncId: input.plan.agent_sync_id,
    cwd: choice.cwd ?? "",
    userText: input.message.trim(),
    // daemon 端按 {"type": ...} 解 backend（integration_test 的既有契约）。
    backend: { type: choice.backend_type },
    sourceDevice: input.sourceDevice.fingerprint,
    sourceDeviceName: deviceDisplayName(),
    // R17：不注入 mcpServers —— org / subagent / hook 是真身在桌面端的内置工具，
    // web 发起的对话用不了它们（发起前已由界面说明）。
  };
  const client = new RelayClient({
    url: relayClientUrl(
      choice.device_fingerprint,
      input.sourceDevice.accessToken,
    ),
    jwt: input.sourceDevice.accessToken,
    deviceFingerprint: input.sourceDevice.fingerprint,
    reconnect: false,
  });
  try {
    await client.connect();
    const raw = await client.request(MethodRun, params);
    const ack = decodeRunAck(raw);
    // R16 的自关注是派发**成功之后**的收尾:ack 一到手,那台机器上就已经真真切切
    // 多了一条会话。关注写失败只是这条不会自动出现在「对话」页(用户仍能在会话详情
    // 里手动关注),把它报成派发失败会让界面说「联系不上这台机器,请重试」——用户一
    // 重试就凭空再开一条真会话,第一条还留在机器上跑。因此这一步不参与成败判定。
    try {
      await api("/v1/follows", {
        method: "POST",
        body: JSON.stringify({
          device_fingerprint: choice.device_fingerprint,
          session_id: String(ack.sessionId),
        }),
      });
    } catch {
      // 关注没写上:会话已经建起来了,交给调用方照常跳转。
    }
    return {
      sessionId: ack.sessionId,
      deviceId: choice.device_id,
      deviceFingerprint: choice.device_fingerprint,
    };
  } finally {
    client.close();
  }
}
