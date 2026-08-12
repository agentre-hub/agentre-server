/**
 * WorkspaceComingSoon 已不再被任何路由使用：/audit 现在走真实 Audit 页（bKvB4），
 * /chat 由 Chat 页负责。组件本身仍保留在代码里（未删除），这里只留一个最小回归：
 * 即使它被直接渲染，TopBar title 槽仍显示传入的标题、正文显示占位说明——防止将来
 * 复用该占位组件时外壳接错。
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";
import WorkspaceComingSoon from "@/pages/WorkspaceComingSoon";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  // 外壳的锦上添花数据（follows/devices/me）一律失败 → 无数据态，不阻塞渲染。
  mockedApi.mockRejectedValue(new Error("network down"));
});

describe("WorkspaceComingSoon（已不再路由，组件级回归）", () => {
  it("直接渲染时 TopBar title 槽显示传入标题，正文显示占位说明", async () => {
    render(
      <MemoryRouter initialEntries={["/audit"]}>
        <ThemeProvider>
          <WorkspaceComingSoon
            titleKey="nav.audit"
            bodyKey="workspaceComingSoon.auditBody"
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(i18n.t("workspaceComingSoon.auditBody")),
    ).toBeTruthy();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Audit")).toBeTruthy();
  });
});
