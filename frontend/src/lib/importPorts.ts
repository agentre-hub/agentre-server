import {
  reduceFrames,
  type ImportCandidatesResult,
  type ImportOutcome,
  type ImportPreviewResult,
  type SessionImportPorts,
  type TranscriptFrame,
} from "@agentre-hub/agentre-ui";

import { api } from "@/lib/api";
import { newConversationId } from "@/lib/conversationId";
import type { NewConvAgent } from "@/components/session/newconv/types";

/**
 * 「导入本地会话」在本站这一侧的适配器（规格 2026-08-26 的远端一半）。
 *
 * 共享包只认 `SessionImportPorts` 那几件事，不认识本站的 REST；这里把它接到
 * `/v1/session-import/*` 上 —— 与 `enginePorts.ts` / `transcriptPorts.ts` 同一条
 * 路子：包里 id 一律是字符串，本站的设备 / 会话 id 是数字，转换只在这一处发生。
 *
 * # 谁在导
 *
 * **握着那份转录的机器**。本站从不拥有会话，它只镜像会话：浏览器铸号、机器执行、
 * 内容经镜像流上来（与「新对话」一字不差的形状）。所以 `runImport` 只是把浏览器
 * 铸的号与选中的候选交上去，回来的会话经既有的镜像通路出现在会话索引里。
 *
 * # 三个可选 port 一个都不声明
 *
 * 没有那个 port 就没有那个入口（包里明写的能力开关），比摆一颗点了不动的按钮好：
 *
 *   - `onImportProgress`：导入是一次同步的 HTTP 调用，本站没有按轮上报的通道。
 *   - `cancelImport`：接不上取消 —— 请求已经在那台机器上跑，本站中断不了它。
 *   - `pickDirectory`：换目录要弹那台机器的目录选择器，本族端点里没有这件事。
 */

/** `/v1/session-import/candidates` 的一行。 */
interface CandidateDTO {
  backend: string;
  provider_session_id: string;
  title?: string;
  cwd?: string;
  started_at?: number;
  ended_at?: number;
  turns: number;
  origin?: string;
  locator: string;
  imported?: boolean;
  imported_session_id?: string;
}

interface ScanIssueDTO {
  backend?: string;
  status: string;
  reason?: string;
}

interface CandidatesDTO {
  candidates?: CandidateDTO[];
  issues?: ScanIssueDTO[];
}

interface GapDTO {
  kind: string;
  count: number;
  detail?: string;
}

interface MetaDTO {
  backend: string;
  provider_session_id: string;
  title?: string;
  cwd?: string;
  model?: string;
  turns: number;
  tool_calls: number;
  compactions: number;
  started_at?: number;
  ended_at?: number;
  origin?: string;
  gaps?: GapDTO[];
  imported?: boolean;
  imported_session_id?: string;
}

interface FrameDTO {
  seq: number;
  method: string;
  params: TranscriptFrame;
}

interface PreviewDTO {
  meta: MetaDTO;
  frames?: FrameDTO[];
  previewed_turns: number;
  remaining_turns: number;
}

interface RunDTO {
  conversation_id: string;
  peer_fingerprint: string;
  cwd?: string;
  title?: string;
  provider_session_id?: string;
  imported_turns: number;
  already_imported?: boolean;
}

/** 一台可以被问的机器。与共享包 `MachineInfo` 同形，索引那份名单直接喂得进来。 */
export interface ImportMachine {
  id: number;
  name: string;
  online: boolean;
}

export interface SessionImportDeps {
  /** 账号下能跑会话的机器。 */
  devices: ImportMachine[];
  /** `/v1/workspace/agents` 的清单，用来给「导完接着跑」挑目标。 */
  agents: NewConvAgent[];
  /**
   * 打开一条会话。**两个参数**：本站的会话详情路由是 `/devices/:did/sessions/:sid`，
   * 光有会话号到不了那儿。
   */
  openSession(deviceId: number, sessionId: string): void;
}

/**
 * 造本站的 ports。
 *
 * `openSession` 那一格是包里唯一一处宿主要自己补上下文的地方：包只交回会话号
 * （它不知道本站的路由要设备 id），所以这里记住**最近一次问的是哪台机器** ——
 * 三个入口（列候选 / 预览 / 导入）都带着 deviceId，而「打开已导入的那条」永远
 * 发生在它们之后。
 */
export function createBrowserSessionImportPorts(
  deps: SessionImportDeps,
): SessionImportPorts {
  let lastDeviceId = deps.devices[0]?.id ?? 0;
  const remember = (deviceId: string): string => {
    const parsed = Number(deviceId);
    if (Number.isFinite(parsed) && parsed > 0) lastDeviceId = parsed;
    return deviceId;
  };

  return {
    devices: deps.devices.map((d) => ({
      id: String(d.id),
      name: d.name,
      online: d.online,
      // 浏览器不是任何一台机器：这份名单里没有「本机」那一档，对话框因此落到
      // 第一台（它自己的 `?? ports.devices[0]` 兜底）。
      local: false,
    })),
    agents: deps.agents.map((a) => ({
      id: a.sync_id,
      name: a.name,
      color: a.avatar_color,
      // Agent 的后端取「当前生效的那一档」——包按候选后端过滤，与另一个后端的
      // 候选配不上的 agent 不会列出来。一档都没有的 agent 后端留空。
      backend: agentBackend(a),
    })),

    listCandidates: async (req): Promise<ImportCandidatesResult> => {
      const qs = new URLSearchParams({ device_id: remember(req.deviceId) });
      if (req.backends.length > 0) qs.set("backends", req.backends.join(","));
      if (req.cwdPrefix) qs.set("cwd_prefix", req.cwdPrefix);
      if (req.titleQuery) qs.set("title_query", req.titleQuery);
      const res = await api<CandidatesDTO>(
        `/v1/session-import/candidates?${qs.toString()}`,
      );
      return {
        candidates: (res.candidates ?? []).map((c) => ({
          backend: c.backend,
          providerSessionId: c.provider_session_id,
          title: c.title ?? "",
          cwd: c.cwd ?? "",
          startedAt: c.started_at ?? 0,
          endedAt: c.ended_at ?? 0,
          turns: c.turns,
          origin: c.origin ?? "",
          locator: c.locator,
          imported: c.imported ?? false,
          importedSessionId: c.imported_session_id ?? "",
        })),
        issues: (res.issues ?? []).map((i) => ({
          backend: i.backend ?? "",
          // 这一档只有 unavailable：server 的 ScanIssueItem 只出这一个值，
          // 「那台机器不认识导入方法族」是协议违约、走错误而不是出一档。包的
          // ImportScanStatus 现在也收成了这一个值（agentre e96dcd33）。
          status: "unavailable" as const,
          reason: i.reason ?? "",
        })),
      };
    },

    preview: async (req): Promise<ImportPreviewResult> => {
      const qs = new URLSearchParams({
        device_id: remember(req.deviceId),
        backend: req.backend,
        locator: req.locator,
      });
      const res = await api<PreviewDTO>(
        `/v1/session-import/preview?${qs.toString()}`,
      );
      const meta = res.meta;
      return {
        meta: {
          backend: meta.backend,
          providerSessionId: meta.provider_session_id,
          title: meta.title ?? "",
          cwd: meta.cwd ?? "",
          model: meta.model ?? "",
          turns: meta.turns,
          toolCalls: meta.tool_calls,
          compactions: meta.compactions,
          startedAt: meta.started_at ?? 0,
          endedAt: meta.ended_at ?? 0,
          origin: meta.origin ?? "",
          gaps: (meta.gaps ?? []).map((g) => ({
            kind: g.kind,
            count: g.count,
            detail: g.detail ?? "",
            // 缺口的说明文案由包按 kind 出；这里只如实转述那台机器给的细节。
            text: g.detail ?? "",
          })),
          // 那份转录的工作目录在**那台机器**上，本站探不到它还在不在。
          // 报 true 是这里唯一诚实的答案：报 false 会让界面说「目录已不存在」，
          // 而它多半好端端地在那儿——何况换目录这条出路（pickDirectory）本站也
          // 没有声明。
          cwdExists: true,
          imported: meta.imported ?? false,
          importedSessionId: meta.imported_session_id ?? "",
        },
        // 帧与账号镜像那条转录端点逐字段同形，因此喂的是**同一个**归约器：
        // 预览渲染的是本站真实转录那条链，不是另一个只画文本的简版。
        messages: reduceFrames(
          (res.frames ?? [])
            .filter((f) => f.method === "runtime.event")
            .map((f) => f.params),
          0,
        ),
        previewedTurns: res.previewed_turns,
        remainingTurns: res.remaining_turns,
      };
    },

    runImport: async (req): Promise<ImportOutcome> => {
      const res = await api<RunDTO>("/v1/session-import/run", {
        method: "POST",
        body: JSON.stringify({
          device_id: Number(remember(req.deviceId)),
          backend: req.backend,
          locator: req.locator,
          // 号由浏览器铸，与「新对话」同一条规矩（服务端与 daemon 都不发号）。
          conversation_id: newConversationId(),
          agent_sync_id: req.agentId,
        }),
      });
      return {
        sessionId: res.conversation_id,
        alreadyImported: res.already_imported ?? false,
        // 只读那一档是「工作目录没了所以不能续跑」，而那件事由那台机器判；
        // 本站这条路上没有它，如实报 false。
        readOnly: false,
        cwd: res.cwd ?? "",
        importedTurns: res.imported_turns,
      };
    },

    openSession: (sessionId) => deps.openSession(lastDeviceId, sessionId),
  };
}

/** 取一个 Agent 当前生效那一档的后端类型；一档都没有时留空。 */
function agentBackend(agent: NewConvAgent): string {
  const targets = agent.exec_targets ?? [];
  const current = targets.find((t) => t.current && t.backend_type);
  if (current?.backend_type) return current.backend_type;
  return targets.find((t) => t.backend_type)?.backend_type ?? "";
}
