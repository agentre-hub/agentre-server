/**
 * 「导入本地会话」适配器单测（规格 2026-08-26 的远端一半）。
 *
 * 盯的是包与本站之间那层翻译最容易错的四件事：
 *   - 设备级错误统一为 unavailable；
 *   - 预览的帧喂进的是本站**真实转录那一条**归约器，不是另一个只画文本的简版；
 *   - 会话号由浏览器铸（服务端与 daemon 都不发号）；
 *   - 「打开已导入的那条」要带着设备 id —— 本站的会话详情路由光有会话号到不了。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import {
  createBrowserSessionImportPorts,
  type ImportMachine,
} from "@/lib/importPorts";
import type { NewConvAgent } from "@/components/session/newconv/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const device: ImportMachine = { id: 11, name: "build box", online: true };

const agent: NewConvAgent = {
  sync_id: "agent-1",
  name: "前端 Agent",
  has_available_target: true,
  exec_targets: [
    { rank: 1, availability: "offline", backend_type: "codex" },
    {
      rank: 2,
      availability: "available",
      backend_type: "claudecode",
      current: true,
    },
  ],
};

function newPorts(opened: { deviceId: number; sessionId: string }[] = []) {
  return createBrowserSessionImportPorts({
    devices: [device],
    agents: [agent],
    openSession: (deviceId, sessionId) => opened.push({ deviceId, sessionId }),
  });
}

beforeEach(() => {
  mockedApi.mockReset();
});

describe("候选清单", () => {
  it("把筛选拼进 query，并把候选与逐档理由原样带回来", async () => {
    mockedApi.mockResolvedValueOnce({
      candidates: [
        {
          backend: "claudecode",
          provider_session_id: "prov-1",
          title: "写个爬虫",
          cwd: "/repos/spider",
          turns: 12,
          locator: "loc-1",
          imported: true,
          imported_session_id: "4242",
        },
      ],
      issues: [{ backend: "codex", status: "unavailable", reason: "没装" }],
    });

    const result = await newPorts().listCandidates({
      deviceId: "11",
      backends: ["claudecode", "codex"],
      cwdPrefix: "/repos",
      titleQuery: "爬",
    });

    expect(mockedApi).toHaveBeenCalledWith(
      "/v1/session-import/candidates?device_id=11&backends=claudecode%2Ccodex&cwd_prefix=%2Frepos&title_query=%E7%88%AC",
    );
    expect(result.candidates[0]).toMatchObject({
      providerSessionId: "prov-1",
      cwd: "/repos/spider",
      locator: "loc-1",
      imported: true,
      importedSessionId: "4242",
    });
    expect(result.issues).toEqual([
      { backend: "codex", status: "unavailable", reason: "没装" },
    ]);
  });
});

describe("预览", () => {
  it("帧喂进本站真实转录那条归约器：用户那一行与助手正文各成一条消息", async () => {
    mockedApi.mockResolvedValueOnce({
      meta: {
        backend: "claudecode",
        provider_session_id: "prov-1",
        title: "写个爬虫",
        cwd: "/repos/spider",
        turns: 12,
        tool_calls: 40,
        compactions: 0,
        gaps: [{ kind: "encrypted_thinking", count: 3, detail: "3 段" }],
      },
      frames: [
        {
          seq: 1,
          method: "runtime.event",
          params: {
            sessionId: 0,
            event: { kind: "user_message", text: "帮我写个爬虫" },
          },
        },
        {
          seq: 2,
          method: "runtime.event",
          params: { sessionId: 0, event: { kind: "text_delta", text: "好的" } },
        },
        {
          seq: 3,
          method: "runtime.event",
          params: { sessionId: 0, event: { kind: "done" } },
        },
      ],
      previewed_turns: 1,
      remaining_turns: 11,
    });

    const result = await newPorts().preview({
      deviceId: "11",
      backend: "claudecode",
      locator: "loc-1",
    });

    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result.messages[0].blocks).toEqual([
      { type: "text", text: "帮我写个爬虫" },
    ]);
    expect(result.messages[1].blocks).toEqual([{ type: "text", text: "好的" }]);
    expect(result.meta.gaps).toEqual([
      { kind: "encrypted_thinking", count: 3, detail: "3 段", text: "3 段" },
    ]);
    expect(result.remainingTurns).toBe(11);
  });

  it("说不出还剩几轮时原样交回 -1，不折成 0", async () => {
    mockedApi.mockResolvedValueOnce({
      meta: {
        backend: "codex",
        provider_session_id: "prov-2",
        turns: 0,
        tool_calls: 0,
        compactions: 0,
      },
      frames: [],
      previewed_turns: 1,
      remaining_turns: -1,
    });

    const result = await newPorts().preview({
      deviceId: "11",
      backend: "codex",
      locator: "loc-2",
    });

    expect(result.remainingTurns).toBe(-1);
  });
});

describe("执行导入", () => {
  it("浏览器铸号并把选中的候选交上去", async () => {
    mockedApi.mockResolvedValueOnce({
      conversation_id: "22222222-2222-7222-8222-222222222222",
      peer_fingerprint: "sha256:aaaa",
      cwd: "/repos/spider",
      imported_turns: 12,
    });

    const outcome = await newPorts().runImport({
      deviceId: "11",
      backend: "claudecode",
      locator: "loc-1",
      agentId: "agent-1",
      projectId: "",
      cwd: "",
      requestId: "req-1",
    });

    const [path, init] = mockedApi.mock.calls[0];
    expect(path).toBe("/v1/session-import/run");
    const body = JSON.parse(String(init?.body));
    expect(init?.method).toBe("POST");
    expect(body).toMatchObject({
      device_id: 11,
      backend: "claudecode",
      locator: "loc-1",
      agent_sync_id: "agent-1",
    });
    // 号由浏览器铸：UUIDv7 的规范形式（决策 1）。
    expect(body.conversation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(outcome).toEqual({
      sessionId: "22222222-2222-7222-8222-222222222222",
      alreadyImported: false,
      readOnly: false,
      cwd: "/repos/spider",
      importedTurns: 12,
    });
  });
});

describe("打开已导入的那条", () => {
  it("带着刚问过的那台机器 —— 本站的会话详情路由光有会话号到不了", async () => {
    const opened: { deviceId: number; sessionId: string }[] = [];
    const ports = newPorts(opened);
    mockedApi.mockResolvedValueOnce({ candidates: [], issues: [] });
    await ports.listCandidates({
      deviceId: "11",
      backends: [],
      cwdPrefix: "",
      titleQuery: "",
    });

    ports.openSession("22222222-2222-7222-8222-222222222222");

    expect(opened).toEqual([
      { deviceId: 11, sessionId: "22222222-2222-7222-8222-222222222222" },
    ]);
  });
});

describe("能力开关", () => {
  it("三个可选 port 一个都不声明 —— 摆一颗点了不动的按钮比没有更糟", () => {
    const ports = newPorts();
    expect(ports.onImportProgress).toBeUndefined();
    expect(ports.cancelImport).toBeUndefined();
    expect(ports.pickDirectory).toBeUndefined();
  });

  it("Agent 的后端取当前生效那一档：与候选后端配不上的 agent 由包自己滤掉", () => {
    expect(newPorts().agents[0]).toMatchObject({
      id: "agent-1",
      backend: "claudecode",
    });
  });
});
