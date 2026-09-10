import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AppControls from "@/components/AppControls";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";

// 真的 ThemeProvider，不是替身：AppControls 的图标和 aria-label 都由
// context 里的 theme 决定，替换掉它这几条断言就测不到接线了。
function renderControls() {
  return render(<AppControls />, { wrapper: ThemeProvider });
}

describe("AppControls", () => {
  it("lives in normal document flow; it is not fixed-positioned any more", async () => {
    await i18n.changeLanguage("en");
    renderControls();
    const button = screen.getByRole("button", { name: /Language/i });
    const container = button.parentElement;
    expect(container?.className).not.toMatch(/\bfixed\b/);
  });

  // spec「认证外壳」：顶栏「右侧是语言与主题两个 34px 图标按钮」。
  // Button 的 icon-sm 是 32px，差两像素——不写死就会跟着 shadcn 的尺寸走。
  it.each([/Language/i, /Theme/i])(
    "renders %s at the shell's 34px",
    async (name) => {
      await i18n.changeLanguage("en");
      renderControls();
      expect(screen.getByRole("button", { name }).className).toContain(
        "size-[34px]",
      );
    },
  );
});
