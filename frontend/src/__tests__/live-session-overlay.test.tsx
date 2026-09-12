/**
 * 「我刚发出去的这一轮」在左栏立刻看得见（2026-09-08）。
 *
 * 此前控制台索引的行**只**来自 server 镜像：状态、时间、排序全都要等
 * `mirror_changed` 信号重拉一遍才动。联调机 2026-09-08 实测的两个后果：
 *
 *   - 发出去到点亮之间隔着一个来回（2s）；镜像因为那条会话还是 `interrupted`
 *     而没接上时（agentred 重启后的常态），整轮都是灰的，一次都不亮；
 *   - 时间与排序**一直**不动 —— 库里 `last_message_at` 停在上一次 Sync 的值。
 *     服务端那一半已经跟上（mirror_svc.followTurn 在轮次边界前移它），但那仍是
 *     一个来回，而且刷新之前这一屏自己知道的事没有地方说。
 *
 * 桌面端不吃这个亏：`session-status-store` 在发送成功那一刻就乐观置 running
 * （"不依赖后端在 turn 起手时 emit session_status"）。这一族是同一条路子在本站的
 * 落法 —— 这个浏览器**亲眼看到**的东西叠在镜像之上。
 */
import { render, renderHook, screen } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayChannel, type UseRelayChannelResult } from "@/hooks/use-relay";
import i18n from "@/i18n";
import {
  forgetLiveTurn,
  noteLiveTurn,
  resetLiveTurns,
  seedLiveTurn,
  useLiveTurns,
  type LiveTurn,
} from "@/lib/liveSessions";
import { overlayLiveRow, type MirrorIndexRow } from "@/pages/chat/chatRows";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import Chat from "@/pages/Chat";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});
vi.mock("@/components/session/SessionDetailView", () => ({
  __esModule: true,
  default: () => <div data-testid="embedded-session-detail" />,
}));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayChannel);

const agentred = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
};

function mirrored(over: Record<string, unknown> = {}) {
  return {
    peer_fingerprint: "fp-1",
    device_fingerprint: "fp-1",
    conversation_id: "42",
    title: "重构登录页",
    agent_sync_id: "ag-1",
    backend_type: "claudecode",
    lifecycle_state: "idle",
    last_message_at: 1754800000000,
    // 都读过了：行首那颗点是 attention 投影，未读的行画的是黄点（waiting），
    // 不设它的话「亮起来了没有」这件事根本看不出来。
    last_read_at: 1754999999999,
    ...over,
  };
}

function row(over: Partial<MirrorIndexRow> = {}): MirrorIndexRow {
  return {
    key: "42",
    conversationId: "42",
    sessionId: 0,
    deviceId: 1,
    fingerprint: "fp-1",
    machineFingerprint: "fp-1",
    agentSyncId: "ag-1",
    projectSyncId: "",
    updatedAt: 1754800000000,
    title: "重构登录页",
    lifecycleState: "idle",
    saved: true,
    ...over,
  };
}

function connectedRelay(): UseRelayChannelResult {
  return {
    client: {
      request: vi.fn(),
      attach: vi.fn(),
      catchUp: vi.fn(),
      close: vi.fn(),
    } as never,
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

function stubApi(items: unknown[]) {
  mockedApi.mockImplementation(async (path) => {
    if (path.startsWith("/v1/agent-sessions?")) {
      return {
        total: items.length,
        groups: [{ scope: "time", total: items.length, items }],
      };
    }
    if (path === "/v1/devices") return { devices: [agentred] };
    if (path === "/v1/workspace/agents") return { agents: [] };
    if (path === "/v1/workspace/projects") return { projects: [] };
    throw new Error("unexpected: " + path);
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  mockUseRelay.mockImplementation(() => connectedRelay());
  resetLiveTurns();
});

/** 左栏此刻列出来的行：标题 + 状态点的读屏名，按屏幕上的顺序。 */
function listedRows(): string[] {
  return [...document.querySelectorAll("[data-nav-target]")].map((el) => {
    const dot = el.querySelector('[aria-label$="status"]');
    return `${el.textContent?.match(/重构登录页|另一条对话/)?.[0] ?? "?"}|${
      dot?.getAttribute("aria-label") ?? "no-dot"
    }`;
  });
}

describe("实时覆盖层：这个浏览器亲眼看到的那一轮", () => {
  describe("纯投影 overlayLiveRow", () => {
    it("没有亲眼所见时行原样交回（同一个引用，下游 memo 不必白算一遍）", () => {
      const r = row();
      expect(overlayLiveRow(r, undefined)).toBe(r);
    });

    it("在跑：生命周期改 running，时间推到看见它的那一刻", () => {
      const live: LiveTurn = { running: true, at: 1754800009000 };
      const out = overlayLiveRow(row(), live);
      expect(out.lifecycleState).toBe("running");
      expect(out.updatedAt).toBe(1754800009000);
    });

    it("不在跑了：撤回 running 那一半（镜像重新说了算），时间那一半留着", () => {
      const live: LiveTurn = { running: false, at: 1754800009000 };
      const out = overlayLiveRow(row({ lifecycleState: "interrupted" }), live);
      expect(out.lifecycleState).toBe("interrupted");
      expect(out.updatedAt).toBe(1754800009000);
    });

    it("时间只前移不倒退：镜像比这一屏看到的还新时听镜像的", () => {
      const live: LiveTurn = { running: true, at: 1754700000000 };
      expect(overlayLiveRow(row(), live).updatedAt).toBe(1754800000000);
    });

    it("「等你处理」不碰：轮次边界说不出这一维，覆盖层不替它回答", () => {
      const live: LiveTurn = { running: true, at: 1754800009000 };
      const out = overlayLiveRow(row({ waitingForInput: true }), live);
      expect(out.waitingForInput).toBe(true);
    });
  });

  describe("什么算「有动静」", () => {
    function store() {
      return renderHook(() => useLiveTurns()).result;
    }

    // 打开一条闲置对话时 attach 会按清单快照喊一句「它没在跑」，补齐回放里的每一个
    // 终态帧也会各喊一次。这些都不是发生过的事 —— 记下来就等于「点开一条对话就把它
    // 顶到列表最前面并标成未读」（联调机 2026-09-08 实测到的那一版就是这样）。
    it("此前没说过在跑，又说没在跑：一个字都不记", () => {
      const live = store();
      act(() => noteLiveTurn("42", false));
      expect(live.current.get("42")).toBeUndefined();
    });

    // 同一轮里这句话会被喊三遍（run 的应答、回声、开轮帧）。每次都重记的话，
    // 时间会在一轮里反复往前跳。
    it("同一轮里重复说「在跑」：时间不再往前跳", () => {
      const live = store();
      act(() => noteLiveTurn("42", true));
      const first = live.current.get("42")!.at;
      act(() => noteLiveTurn("42", true));
      expect(live.current.get("42")!.at).toBe(first);
    });

    // 一条已经跑了十分钟的对话，你现在才打开它 —— 那不是一次新的活动。
    it("attach 的清单快照只点亮，不动时间", () => {
      const live = store();
      act(() => seedLiveTurn("42", true));
      expect(live.current.get("42")).toEqual({ running: true, at: 0 });
    });

    // 但它收场是亲眼看到的：回复就是那一刻落下的。
    it("快照点亮之后真的跑完了：这一次记时间", () => {
      const live = store();
      act(() => seedLiveTurn("42", true));
      act(() => noteLiveTurn("42", false));
      expect(live.current.get("42")!.running).toBe(false);
      expect(live.current.get("42")!.at).toBeGreaterThan(0);
    });
  });

  it("发出去当场：那一行点亮 running 并排到最上面，不等镜像的来回", async () => {
    stubApi([
      mirrored({
        conversation_id: "42",
        title: "重构登录页",
        last_message_at: 1754800000000,
      }),
      mirrored({
        conversation_id: "43",
        title: "另一条对话",
        last_message_at: 1754900000000,
      }),
    ]);
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <ThemeProvider>
          <Routes>
            <Route path="/chat" element={<Chat />} />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: /重构登录页/ });
    expect(listedRows()).toEqual([
      "另一条对话|idle status",
      "重构登录页|idle status",
    ]);

    act(() => noteLiveTurn("42", true));

    expect(listedRows()).toEqual([
      "重构登录页|running status",
      "另一条对话|idle status",
    ]);
  });

  it("不再盯着它了：running 撤回，位置留在它该在的地方", async () => {
    stubApi([
      mirrored({
        conversation_id: "42",
        title: "重构登录页",
        last_message_at: 1754800000000,
      }),
      mirrored({
        conversation_id: "43",
        title: "另一条对话",
        last_message_at: 1754900000000,
      }),
    ]);
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <ThemeProvider>
          <Routes>
            <Route path="/chat" element={<Chat />} />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /重构登录页/ });

    act(() => noteLiveTurn("42", true));
    expect(listedRows()[0]).toBe("重构登录页|running status");

    act(() => forgetLiveTurn("42"));
    // running 那一半撤回了 —— 此后这条会话是死是活这个浏览器不知道，镜像重新说了算。
    // 点变黄不是残留：时间被推到了「刚才」而这一屏没标已读，那正是「未读」的定义
    // （真实流程里详情会在轮末标一次已读）。位置留在最上面，那是既成事实。
    const after = listedRows();
    expect(after[0]).toBe("重构登录页|waiting status");
    expect(after[1]).toBe("另一条对话|idle status");
  });
});
