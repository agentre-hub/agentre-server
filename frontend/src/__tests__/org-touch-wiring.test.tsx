import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import { api } from "@/lib/api";
import * as accountChannel from "@/lib/accountChannel";
import i18n from "@/i18n";
import Org from "@/pages/Org";
import type { OrgChartResponse } from "@/pages/org/types";

/**
 * 审计第 10 项：Agent 详情里执行目标与工具的控件在手机上太小。共享包的
 * OrgExecTargetRow / OrgToolList 有 touch 档（柄与 ✕ 44×44、授权视觉 28px 点按区
 * 44px），宿主在手机上要把它打开；「添加执行目标」在本站，视觉 32px、点按区 44px。
 * 桌面不传 touch，保持原样。
 */
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn() };
});

const mockedApi = vi.mocked(api);
const mockedStartChannel = vi.mocked(accountChannel.startAccountChannel);

const chart: OrgChartResponse = {
  departments: [],
  agents: [
    {
      sync_id: "agent-alice",
      name: "Alice",
      sort_order: 0,
      exec_targets: [
        {
          sync_id: "t1",
          rank: 1,
          backend_sync_id: "b1",
          backend_name: "Claude Code",
          backend_type: "claudecode",
          device_id: 7,
          device_name: "mac-mini",
          device_unspecified: false,
          availability: "available",
          current: true,
        },
        {
          sync_id: "t2",
          rank: 2,
          backend_sync_id: "b3",
          backend_name: "Codex",
          backend_type: "codex",
          device_id: 8,
          device_name: "linux-box",
          device_unspecified: false,
          availability: "available",
          current: false,
        },
      ],
    },
  ],
};

const cls = (el: Element) => el.getAttribute("class")?.split(/\s+/) ?? [];

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

function renderAgent() {
  return render(
    <MemoryRouter initialEntries={["/org/agent/agent-alice"]}>
      <ThemeProvider>
        <Routes>
          <Route path="/org/:kind?/:syncId?" element={<Org />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockedStartChannel.mockReset();
  mockedStartChannel.mockReturnValue({ stop: vi.fn() });
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/workspace/org" && (!init || init.method === undefined))
      return chart;
    if (path === "/v1/workspace/org/backends")
      return { backends: [{ sync_id: "b2", name: "Codex" }] };
    if (path === "/v1/devices") return { devices: [] };
    if (init?.method === "POST") return { sync_id: "new", version: 1 };
    throw new Error(`unexpected request: ${path}`);
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("Agent 详情：执行目标与工具的触屏档", () => {
  it("手机上柄与移除 44×44，授权视觉 28px，「添加执行目标」视觉 32px、点按区 44px", async () => {
    mockViewport(true);
    renderAgent();
    const [handle] = await screen.findAllByRole("button", {
      name: /Reorder target/,
    });
    expect(cls(handle)).toContain("size-11");
    const grant = screen.getAllByRole("button", { name: /^Grant / })[0];
    expect(cls(grant)).toContain("h-7");
    expect(cls(grant)).toContain("before:-inset-y-2");
    const section = document.querySelector<HTMLElement>(
      '[data-slot="org-detail-col-execution"]',
    )!;
    const add = within(section).getByRole("button", {
      name: /Add execution target/,
    });
    expect(cls(add)).toContain("h-8");
    expect(cls(add)).toContain("relative");
    expect(cls(add)).toContain("before:-inset-y-1.5");
  });

  it("桌面不传 touch：柄不是 44px，「添加执行目标」仍是 28px", async () => {
    mockViewport(false);
    renderAgent();
    const [handle] = await screen.findAllByRole("button", {
      name: /Reorder target/,
    });
    expect(cls(handle)).not.toContain("size-11");
    const grant = screen.getAllByRole("button", { name: /^Grant / })[0];
    expect(cls(grant)).not.toContain("h-7");
    const section = document.querySelector<HTMLElement>(
      '[data-slot="org-detail-col-execution"]',
    )!;
    const add = within(section).getByRole("button", {
      name: /Add execution target/,
    });
    expect(cls(add)).toContain("h-7");
    expect(cls(add)).not.toContain("h-8");
  });
});
