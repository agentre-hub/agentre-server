/**
 * `/devices/:id/sessions` 并入统一索引（规格 2026-08-17 决策 1）。
 *
 * 这条地址上曾经住着一整页「这台机器的对话」。它与索引渲染的是同一批会话，差别
 * 只是范围，而范围正是「轴」能表达的东西——因此它现在**重定向**到机器轴
 * （Devices 页与会话详情页的返回链接都还指着它）。
 *
 * **范围要跟着过去**：地址里的 `:deviceId` 落成 `?machine=<设备标识>`，索引因此
 * 只列那一台机器这一组。入口那句话是「查看这台机器的对话」，落地看到每一台机器
 * 就是名不副实；而机器轴本身（不带 `?machine=`）仍是每台在线机器各一组。
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
import { useRelayChannel, type UseRelayChannelResult } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { MACHINE_LIST_PAGE_SIZE } from "@/pages/chat/useMachineReachability";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayChannel);

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

/** 账号下的另一台在线机器：范围没跟过来的话，它也会摆一组出来。 */
const otherDeviceRow = {
  id: 2,
  name: "客厅小主机",
  kind: "agentred",
  fingerprint: "fp-2",
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

function connectedRelay(): UseRelayChannelResult {
  return {
    client: fakeClient as never,
    relayState: "connected",
    relayTicket: {
      peerFingerprint: "fp-web",
      clientName: "Browser",
      accessToken: "t",
      expiresAt: Date.now() + 120_000,
    },
    relayTicketError: null,
    handshakeRejection: null,
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
    if (path === "/v1/devices") return { devices: [deviceRow, otherDeviceRow] };
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
    expect((await screen.findByTestId("axis-picker")).textContent).toContain(
      "Machine",
    );
    const box = await screen.findByTestId("group-device-1");
    expect(within(box).getByText("书房小主机")).toBeTruthy();
  });

  it("入口说的是「这台机器」：范围跟着地址过来，别的机器一组都不列", async () => {
    renderAt("/devices/1/sessions");

    await screen.findByTestId("group-device-1");
    // 地址上留得住范围：刷新、分享这条链接看到的还是这一台。
    expect(new URLSearchParams(window.location.search).get("machine")).toBe(
      "1",
    );
    expect(screen.queryByTestId("group-device-2")).toBeNull();
    expect(screen.queryByText("客厅小主机")).toBeNull();
    // 那台没被点的机器也不该被问一遍：范围之外的机器不开中继通道。
    expect(mockUseRelay.mock.calls.map((c) => c[0])).not.toContain(
      "machine:fp-2",
    );
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
