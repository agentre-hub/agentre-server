/**
 * 手机首页本地优先（规格 2026-11-25 决策 A1、A5、A6，W25；对比稿 d9 B 帧 1、3、4）。
 *
 *   - 冷启动：上次的列表与名单从本机存储立即画出来，不等网络；实时标记置灰、分组标题旁
 *     「同步中」、页头副行「更新中」+ 细进度条。
 *   - 新数据到了就地替换：新行淡入、离开的行淡出，其余行原地不动（同一个 DOM 节点）。
 *   - 完全离线打开：副行沿用「没有网络 · HH:MM 的内容」，时间取本地数据的时间。
 *   - 名单还没到 / 取不到：机器数写「—」，不写 0。
 *   - 存储不可用、换了账号：静默退回每次联网（骨架等网络）。
 *
 * 「上次」由同一个页面在线跑一遍造出来（持久化与读回走的是真实代码），再换一个新的
 * 标签页（名单的内存缓存作废、页面重挂）去打开。IndexedDB 用 fake-indexeddb，每条
 * 用例一份新的。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import type { MeStatus } from "@/hooks/use-me";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { deviceRoster } from "@/lib/devices";
import { accountStore, bindAccount } from "@/lib/localStore";
import { invalidateRosters } from "@/lib/rosterFetch";
import Chat from "@/pages/Chat";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));
vi.mock("@/components/session/SessionDetailView", () => ({
  default: () => <div data-testid="mobile-session-detail" />,
}));
// 身份由用例直接给：账号绑定（bindAccount）也由用例自己做，等于「本地身份已读到」。
const identity = vi.hoisted(() => ({ status: "ready" as MeStatus }));
vi.mock("@/hooks/use-me", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-me")>();
  return {
    ...actual,
    useMe: () => ({
      me: {
        user_id: 1,
        email: "a@b.c",
        display_name: "A",
        avatar_url: "",
        github_login: "",
        csrf_token: "c",
      },
      status: identity.status,
      attempt: 0,
      inFlight: false,
      retry: () => {},
    }),
  };
});

const mockedApi = vi.mocked(api);
const g = globalThis as Record<string, unknown>;
const originalMatchMedia = window.matchMedia;

function mockViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const agentred = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
};
const agents = [
  {
    sync_id: "ag-1",
    name: "后端 Agent",
    avatar_color: "#4f46e5",
    has_available_target: true,
    exec_targets: [],
  },
];
const row = (id: string, title: string, extra: Record<string, unknown>) => ({
  peer_fingerprint: "fp-1",
  device_fingerprint: "fp-1",
  conversation_id: id,
  title,
  agent_sync_id: "ag-1",
  backend_type: "claudecode",
  ...extra,
});
const waiting = row("42", "等你批", {
  lifecycle_state: "running",
  waiting_for_input: true,
  last_message_at: 1754800000000,
});
const running = row("43", "跑着呢", {
  lifecycle_state: "running",
  last_message_at: 1754700000000,
});
const oldRead = row("45", "老对话", {
  lifecycle_state: "idle",
  last_message_at: 1754000000000,
  last_read_at: 1754000001000,
});
const arrived = row("46", "新来的", {
  lifecycle_state: "running",
  last_message_at: 1754750000000,
});

type Handler = (path: string) => Promise<unknown>;

/** 服务端：索引按给定的行回答，名单照常。 */
function server(saved: unknown[], devices: unknown[] = [agentred]): Handler {
  return async (path) => {
    if (path.startsWith("/v1/agent-sessions?")) {
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      if (params.get("per_group") === "1") return { total: saved.length };
      return {
        total: saved.length,
        groups: saved.length
          ? [{ scope: "time", total: saved.length, items: saved }]
          : [],
      };
    }
    if (path === "/v1/devices") return { devices };
    if (path === "/v1/workspace/agents") return { agents };
    if (path === "/v1/workspace/projects") return { projects: [] };
    throw new Error("unexpected: " + path);
  };
}

/** 所有请求扣在手里，直到 release(服务端) 才按那份服务端回答。 */
function holdNetwork() {
  const pending: Array<{
    path: string;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  let answer: Handler | null = null;
  mockedApi.mockImplementation((path: string) => {
    if (answer) return answer(path) as never;
    return new Promise((resolve, reject) => {
      pending.push({ path, resolve, reject });
    }) as never;
  });
  return {
    async release(next: Handler) {
      answer = next;
      for (const p of pending.splice(0)) {
        next(p.path).then(p.resolve, p.reject);
      }
    },
  };
}

function renderChat() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <ThemeProvider>
        <Routes>
          <Route path="/chat/:conversationId?" element={<Chat />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/**
 * 「上次」：在线打开一次，等列表与设备名单都落进存储，然后关掉这个标签页
 * （卸载页面、作废内存里的名单）。
 */
async function openOnceOnline(saved: unknown[]) {
  mockedApi.mockImplementation(server(saved) as never);
  const { unmount } = renderChat();
  await screen.findByText((saved[0] as { title: string }).title);
  await waitFor(async () => {
    expect(await deviceRoster.stored()).toBeTruthy();
    expect((await accountStore.list("session-index")).length).toBeGreaterThan(
      0,
    );
  });
  unmount();
  invalidateRosters(null);
  mockedApi.mockReset();
}

function rowItem(title: string): HTMLElement {
  const li = screen.getByText(title).closest("li");
  if (!li) throw new Error("no row for " + title);
  return li;
}

const onLine = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  "onLine",
);
function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockViewport(true);
  g.indexedDB = new IDBFactory();
  g.IDBKeyRange = IDBKeyRange;
  bindAccount(1);
  identity.status = "ready";
  mockedApi.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  bindAccount(null);
  delete g.indexedDB;
  delete g.IDBKeyRange;
  window.matchMedia = originalMatchMedia;
  delete (navigator as { onLine?: boolean }).onLine;
  if (onLine)
    Object.defineProperty(Object.getPrototypeOf(navigator), "onLine", onLine);
});

describe("冷启动：本地数据先画出来", () => {
  it("网络还没回来：上次的列表与名单立即出现，标记置灰、分组「同步中」、页头「更新中」+ 进度条", async () => {
    await openOnceOnline([waiting, running, oldRead]);
    holdNetwork();
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    const list = screen.getByTestId("chat-phone-list");
    expect(list.querySelector('[data-slot="session-row-skeleton"]')).toBeNull();
    expect(rowItem("等你批").getAttribute("data-stale")).toBe("true");
    expect(rowItem("跑着呢").getAttribute("data-stale")).toBe("true");
    expect(
      within(screen.getByTestId("phase-needsYou")).getByText("Syncing"),
    ).toBeTruthy();
    const subtitle = screen.getByTestId("chat-phone-subtitle");
    expect(subtitle.textContent).toContain("Updating");
    // 机器数来自本地的设备名单，不是「—」也不是 0。
    expect(subtitle.textContent).toContain("1 / 1 machines online");
    expect(
      within(screen.getByTestId("chat-mobile-header")).getByTestId(
        "index-refresh-bar",
      ),
    ).toBeTruthy();
    // 本地行不变淡（那是「换范围在途」的呈现），照样点得开。
    expect(screen.getByTestId("chat-phone-rows").className).not.toContain(
      "opacity-55",
    );
  });

  it("新数据到了就地替换：新行淡入、离开的行淡出后消失，其余行原地不动，标记复色", async () => {
    await openOnceOnline([waiting, running, oldRead]);
    const net = holdNetwork();
    renderChat();
    await screen.findByText("等你批");
    const keptNode = rowItem("老对话");

    await act(async () => net.release(server([waiting, arrived, oldRead])));

    await waitFor(() =>
      expect(rowItem("新来的").getAttribute("data-entering")).toBe("true"),
    );
    expect(rowItem("新来的").className).toContain("fade-in");
    // 离开的那一行先淡出，再从列表里拿掉。
    expect(rowItem("跑着呢").getAttribute("data-leaving")).toBe("true");
    expect(rowItem("跑着呢").className).toContain("fade-out");
    await waitFor(() => expect(screen.queryByText("跑着呢")).toBeNull());
    // 留下的行是同一个节点：没有整片重搭。
    expect(rowItem("老对话")).toBe(keptNode);
    expect(rowItem("老对话").getAttribute("data-entering")).toBeNull();
    expect(rowItem("等你批").getAttribute("data-stale")).toBeNull();
    expect(screen.queryByText("Syncing")).toBeNull();
    expect(screen.getByTestId("chat-phone-subtitle").textContent).not.toContain(
      "Updating",
    );
    expect(screen.queryByTestId("index-refresh-bar")).toBeNull();
  });

  it("新数据没取回来：本地行留着、标记仍灰，不再说「同步中」「更新中」，失败横幅可重试", async () => {
    await openOnceOnline([waiting, oldRead]);
    mockedApi.mockRejectedValue(new Error("boom"));
    renderChat();

    expect(await screen.findByTestId("index-load-error")).toBeTruthy();
    expect(screen.getByText("等你批")).toBeTruthy();
    expect(rowItem("等你批").getAttribute("data-stale")).toBe("true");
    expect(screen.queryByText("Syncing")).toBeNull();
    expect(screen.getByTestId("chat-phone-subtitle").textContent).not.toContain(
      "Updating",
    );
    expect(screen.queryByTestId("index-refresh-bar")).toBeNull();
    expect(screen.queryByTestId("chat-load-failed")).toBeNull();
  });

  it("完全离线打开：本地列表照画，副行「没有网络 · HH:MM 的内容」取本地数据的时间，不挂失败横幅", async () => {
    const saved = new Date();
    saved.setHours(9, 7, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(saved.getTime());
    await openOnceOnline([waiting, oldRead]);
    vi.restoreAllMocks();

    setOnline(false);
    mockedApi.mockRejectedValue(new TypeError("Failed to fetch"));
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    const subtitle = screen.getByTestId("chat-phone-subtitle");
    await waitFor(() =>
      expect(subtitle.textContent).toContain("No network · content from 09:07"),
    );
    expect(rowItem("等你批").getAttribute("data-stale")).toBe("true");
    expect(screen.queryByText("Syncing")).toBeNull();
    expect(screen.queryByTestId("index-load-error")).toBeNull();
    expect(screen.queryByTestId("index-refresh-bar")).toBeNull();
  });
});

describe("退回每次联网", () => {
  it("存储不可用：照旧骨架等网络，到了不带任何置灰", async () => {
    delete g.indexedDB;
    const net = holdNetwork();
    renderChat();

    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-row-skeleton"]'),
      ).not.toBeNull(),
    );
    await act(async () => net.release(server([waiting])));
    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(rowItem("等你批").getAttribute("data-stale")).toBeNull();
    expect(screen.queryByText("Syncing")).toBeNull();
  });

  it("换了账号：读不到上一个账号的列表，骨架等网络", async () => {
    await openOnceOnline([waiting]);
    bindAccount(2);
    holdNetwork();
    renderChat();

    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-row-skeleton"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByText("等你批")).toBeNull();
  });
});

describe("数量未知写「—」（W25）", () => {
  it("设备名单还没到：机器数写「— / —」，不写 0 / 0", async () => {
    holdNetwork();
    renderChat();

    const subtitle = await screen.findByTestId("chat-phone-subtitle");
    expect(subtitle.textContent).toContain("— / — machines online");
    expect(subtitle.textContent).not.toContain("0 / 0");
  });

  it("设备名单取不到：仍写「— / —」", async () => {
    const base = server([waiting]);
    mockedApi.mockImplementation(((path: string) =>
      path === "/v1/devices"
        ? Promise.reject(new Error("boom"))
        : base(path)) as never);
    renderChat();

    await screen.findByText("等你批");
    expect(screen.getByTestId("chat-phone-subtitle").textContent).toContain(
      "— / — machines online",
    );
  });
});

describe("「网络不稳定」细条", () => {
  it("手机首页把它摆在自己的页头正下方，只有一条", async () => {
    identity.status = "unstable";
    mockedApi.mockImplementation(server([waiting]) as never);
    renderChat();

    await screen.findByText("等你批");
    const strips = screen.getAllByTestId("identity-unstable");
    expect(strips).toHaveLength(1);
    expect(screen.getByTestId("chat-mobile-header").nextElementSibling).toBe(
      strips[0],
    );
  });
});

describe("桌面", () => {
  it("同一份本地数据也先画出来，但不带置灰与「同步中」", async () => {
    mockViewport(false);
    await openOnceOnline([waiting]);
    holdNetwork();
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.queryByText("Syncing")).toBeNull();
    expect(document.querySelector("[data-stale]")).toBeNull();
  });
});
