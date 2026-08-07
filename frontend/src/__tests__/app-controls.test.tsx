import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AppControls from "@/components/AppControls";
import i18n from "@/i18n";

// 见 auth-layout.test.tsx 顶部注释：绕开与本任务无关的 jsdom/Node localStorage 环境缺陷。
vi.mock("@/lib/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/theme")>();
  return {
    ...actual,
    useTheme: () => ({
      theme: "system" as const,
      resolved: "light" as const,
      setTheme: vi.fn(),
    }),
  };
});

describe("AppControls", () => {
  it("lives in normal document flow; it is not fixed-positioned any more", async () => {
    await i18n.changeLanguage("en");
    render(<AppControls />);
    const button = screen.getByRole("button", { name: /Language/i });
    const container = button.parentElement;
    expect(container?.className).not.toMatch(/\bfixed\b/);
  });
});
