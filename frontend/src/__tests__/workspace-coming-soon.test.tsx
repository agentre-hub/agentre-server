/**
 * 审计占位页（WorkspaceComingSoon）随外壳自动对齐：TopBar title 槽显示页面标题。
 * 设计文档（docs/design.md「The shell」）：title/right 可选，「DeviceSessions、
 * SessionDetail、WorkspaceComingSoon 传 title 而不传 right」——占位页不能把 TopBar
 * 标题槽留空。
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

describe("WorkspaceComingSoon（审计占位页）", () => {
  it("TopBar title 槽显示页面标题（nav.audit），正文显示占位说明", async () => {
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
    // 等外壳渲染稳定后，断言标题出现在 TopBar（banner）标题槽里——SideNav 也有一个
    // 「Audit」导航项，必须限定在 banner 内才算数。
    expect(
      await screen.findByText(i18n.t("workspaceComingSoon.auditBody")),
    ).toBeTruthy();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Audit")).toBeTruthy();
  });
});
