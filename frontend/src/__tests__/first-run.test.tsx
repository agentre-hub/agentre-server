/**
 * 首次使用与空态的文案（规格 2026-11-25 J1、H6、F18）：
 *   - 没有 Agent 的说明与 /org 能新建的事实一致；手机上的出口按钮 44px，桌面不变。
 *   - 无标题对话在行与页头都叫「未命名对话」。
 */
import { render, screen, within } from "@testing-library/react";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentPickList } from "@/components/session/newconv/AgentPickList";
import i18n from "@/i18n";
import { sessionTitle } from "@/lib/sessionView";

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

function renderEmptyList() {
  render(
    <MemoryRouter>
      <ThemeProvider>
        <AgentPickList agents={[]} recentIds={[]} onPick={() => {}} />
      </ThemeProvider>
    </MemoryRouter>,
  );
  return screen.getByTestId("agent-pick-empty");
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("没有 Agent 的空态（F18）", () => {
  it("说明里提到能在组织页新建，不再说「都在桌面端创建」", () => {
    mockViewport(true);
    const empty = renderEmptyList();
    expect(empty.textContent).not.toContain(
      "Agents are created in the desktop app",
    );
    expect(empty.textContent).toContain("Organization");
  });

  it("手机上去设备页的按钮至少 44px 高", () => {
    mockViewport(true);
    const empty = renderEmptyList();
    const link = within(empty).getByRole("link", { name: "Go to devices" });
    expect(link.className).toContain("h-11");
  });

  it("桌面上按钮仍是小号，不变", () => {
    mockViewport(false);
    const empty = renderEmptyList();
    const link = within(empty).getByRole("link", { name: "Go to devices" });
    expect(link.className).not.toContain("h-11");
  });
});

describe("无标题对话（H6）", () => {
  const t = i18n.t.bind(i18n);
  it.each(["idle", "running", "weird"])(
    "生命周期 %s 的无标题会话都叫「未命名对话」，不拼 cwd / 后端 / 状态",
    async (lifecycleState) => {
      await i18n.changeLanguage("zh-CN");
      expect(
        sessionTitle(
          {
            title: " ",
            cwd: "/var/proj",
            backendType: "codex",
            lifecycleState,
          },
          i18n.t.bind(i18n),
        ),
      ).toBe("未命名对话");
    },
  );

  it("有标题时照用标题", () => {
    expect(
      sessionTitle(
        {
          title: "重构登录页",
          cwd: "",
          backendType: "",
          lifecycleState: "idle",
        },
        t,
      ),
    ).toBe("重构登录页");
  });
});
