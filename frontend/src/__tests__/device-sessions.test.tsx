/**
 * `/devices/:id/sessions` 并入统一索引（规格 2026-08-17 决策 1）。
 *
 * 这条地址上曾经住着一整页「这台机器的对话」。它与索引渲染的是同一批会话，差别
 * 只是范围，而范围正是「轴」能表达的东西——因此它现在**重定向**到机器轴
 * （Devices 页与会话详情页的返回链接都还指着它）。机器轴上不再有「选中一台」
 * 这回事（规格 2026-08-21 决策 5）：每台机器各自一组，那台机器就在其中。
 *
 * 落地后的形态必须仍是「发现并保存」：那台机器上有、账号里还没保存的对话一同
 * 列出，行尾是「保存」（规格 2026-08-18 决策 11）。这一条守的是**重定向本身与它
 * 落到的形态**；索引内部的分组 / 行由 session-index.test.tsx 与 chat.test.tsx 守。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import { api } from "@/lib/api";
import { useRelayMachine, type UseRelayMachineResult } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { MACHINE_LIST_PAGE_SIZE } from "@/pages/chat/useMachineReachability";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayMachine);

const signedInMe = {
  user_id: 1,
  email: "dev@agentre.dev",
  display_name: "Dev",
  avatar_url: "",
  github_login: "dev",
  csrf_token: "t",
};

const deviceRow = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
};

const sessions = [
  {
    conversationId: "42",
    title: "重构登录页",
    agentSyncId: "ag-1",
    cwd: "/home/agent/proj",
    backendType: "claudecode",
    lifecycleState: "running",
    waitingForInput: true,
    latestSeq: 12,
  },
  {
    conversationId: "8",
    cwd: "/var/proj",
    backendType: "codex",
    lifecycleState: "idle",
    latestSeq: 5,
  },
];

const fakeClient = {
  // 关键词由**机器**筛（wire 的 SessionListRequest.keyword）：这份假机器照做，
  // 客户端收到之后不再重筛一遍。
  request: vi.fn(async (method: unknown, params?: unknown) => {
    if (method !== rpcMethods.sessionList) {
      throw new Error("unexpected method: " + method);
    }
    const keyword = (params as { keyword?: string })?.keyword ?? "";
    return {
      sessions: keyword
        ? sessions.filter((s) =>
            (s.title ?? "").toLowerCase().includes(keyword.toLowerCase()),
          )
        : sessions,
    };
  }),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  close: vi.fn(),
};

function connectedRelay(): UseRelayMachineResult {
  return {
    client: fakeClient as never,
    relayState: "connected",
    relayTicket: {
      clientId: "fp-web",
      clientName: "Browser",
      accessToken: "t",
      expiresAt: Date.now() + 120_000,
    },
    relayTicketError: null,
    reconnect: vi.fn(),
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  fakeClient.request.mockClear();
  mockUseRelay.mockReset();
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/auth/me") return signedInMe;
    if (path.startsWith("/v1/agent-sessions?")) return { total: 0, groups: [] };
    if (path === "/v1/devices") return { devices: [deviceRow] };
    if (path === "/v1/workspace/agents")
      return { agents: [{ sync_id: "ag-1", name: "后端 Agent" }] };
    if (path === "/v1/workspace/projects") return { projects: [] };
    throw new Error("unexpected: " + path);
  });
  mockUseRelay.mockReturnValue(connectedRelay());
});

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  // main.tsx 里 App 就是套在 ThemeProvider 下的，这里照搬同一层。
  return render(<App />, { wrapper: ThemeProvider });
}

describe("设备下钻地址重定向进统一索引", () => {
  it("落到 /chat 的机器轴，那台机器就是索引里的一组", async () => {
    renderAt("/devices/1/sessions");

    await waitFor(() => expect(window.location.pathname).toBe("/chat"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("axis")).toBe("machine");
    // 「选中一台」不再存在，地址上因此也不带它。
    expect(params.get("machine")).toBeNull();
    expect((await screen.findByTestId("axis-picker")).textContent).toContain(
      "Machine",
    );
    const box = await screen.findByTestId("group-device-1");
    expect(within(box).getByText("书房小主机")).toBeTruthy();
  });

  it("落地形态仍是「发现并保存」:那台机器上还没保存的对话 + 行尾「保存」", async () => {
    renderAt("/devices/1/sessions");

    // 账号里一条都没保存，但这台机器上报的全量都在（决策 11）。
    expect(await screen.findByText("重构登录页")).toBeTruthy();
    expect(screen.getByText("/var/proj · codex · Idle")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Save" }).length).toBe(2);
    // 「那台机器上有什么」只能问机器本身，与旧的下钻页同一条路。没在搜索时关键词是
    // 空串；页大小照发 —— 机器上可能有几千条，整份要回来正是机器轴卡住的原因。
    const call = fakeClient.request.mock.calls.at(-1);
    expect(call?.[0]).toBe(rpcMethods.sessionList);
    expect(call?.[1]).toEqual({ keyword: "", limit: MACHINE_LIST_PAGE_SIZE });
  });
});

// ── 机器轴的搜索 ────────────────────────────────────────────────────────────
//
// 「那台机器上有什么」只有机器自己知道，所以这一档的行来自实时 session.list。此前
// 整份拉回来再在浏览器里按标题筛（chatRows.buildMachineRows），机器上有几千条对话
// 时就是几千份摘要过线，其中绝大多数与搜索无关。关键词因此进请求，由机器自己筛；
// 页大小同理随请求走，其余的由「查看全部 N」按游标续取。
describe("机器轴的搜索下推到机器", () => {
  it("Given 机器轴上输入了搜索词, When 索引重取, Then session.list 带着关键词发出去", async () => {
    renderAt("/devices/1/sessions");
    await screen.findByText("重构登录页");
    fakeClient.request.mockClear();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search conversations" }),
      { target: { value: "登录" } },
    );

    await waitFor(
      () => {
        const last = fakeClient.request.mock.calls.at(-1);
        expect(last?.[0]).toBe(rpcMethods.sessionList);
        expect(last?.[1]).toEqual({
          keyword: "登录",
          limit: MACHINE_LIST_PAGE_SIZE,
        });
      },
      { timeout: 5000 },
    );
  });

  it("Given 搜索词被清空, When 索引重取, Then 请求回到不带关键词的整份清单", async () => {
    renderAt("/devices/1/sessions");
    await screen.findByText("重构登录页");
    const box = screen.getByRole("searchbox", { name: "Search conversations" });
    fireEvent.change(box, { target: { value: "登录" } });
    await waitFor(
      () => {
        const last = fakeClient.request.mock.calls.at(-1);
        expect(last?.[0]).toBe(rpcMethods.sessionList);
        expect(last?.[1]).toEqual({
          keyword: "登录",
          limit: MACHINE_LIST_PAGE_SIZE,
        });
      },
      { timeout: 5000 },
    );
    fakeClient.request.mockClear();

    fireEvent.change(box, { target: { value: "" } });

    // 搜索词有 250ms 去抖，再加一趟中继往返：默认 1s 的 waitFor 在整包并发跑时不够。
    await waitFor(
      () => {
        const last = fakeClient.request.mock.calls.at(-1);
        expect(last?.[0]).toBe(rpcMethods.sessionList);
        expect(last?.[1]).toEqual({
          keyword: "",
          limit: MACHINE_LIST_PAGE_SIZE,
        });
      },
      { timeout: 5000 },
    );
  });
});
