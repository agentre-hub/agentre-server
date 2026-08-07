import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Login from "@/pages/Login";
import { ThemeProvider } from "@/lib/theme";
import i18n from "@/i18n";

function renderLogin(search: string = "") {
  // Login.tsx 直接读 window.location.search（而不是 useLocation），
  // 所以 query 要从 window 上塞进去，MemoryRouter 的 initialEntries 喂不到它。
  Object.defineProperty(window, "location", {
    value: {
      ...window.location,
      search: search,
      assign: vi.fn(),
      href: "/login" + search,
    },
    writable: true,
  });

  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Login />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("Login", () => {
  describe("form structure", () => {
    it("shows the title", () => {
      renderLogin();
      expect(
        screen.getByRole("heading", { level: 1, name: /Sign in to AgentRe/i }),
      ).toBeTruthy();
    });

    it("shows a descriptive body line", () => {
      renderLogin();
      expect(
        screen.getByText(/Continue with your GitHub account/i),
      ).toBeTruthy();
    });

    it("shows the GitHub login button", () => {
      renderLogin();
      expect(
        screen.getByRole("button", { name: /Sign in with GitHub/i }),
      ).toBeTruthy();
    });

    // spec「认证外壳」的卡片表：「宽度按屏内容定：登录 424…」，
    // 以及「间距」：「卡片内间距桌面 36–40，移动 24–28」。
    // max-w-sm 是 384，而一个常量 p-9 会把 36 的桌面留白照搬到手机上。
    it("is 424 wide and pads 24 on mobile, 36 from sm: up", () => {
      renderLogin();
      const card = screen.getByRole("heading", { level: 1 }).parentElement;
      expect(card?.className).toContain("max-w-[424px]");
      expect(card?.className).toContain("p-6");
      expect(card?.className).toContain("sm:p-9");
    });

    it("shows a footer note about terms and privacy", () => {
      renderLogin();
      expect(
        screen.getByText(/By continuing, you agree to AgentRe/i),
      ).toBeTruthy();
    });
  });

  describe("user_code context strip", () => {
    it("does not show context strip when user_code is absent", () => {
      renderLogin();
      // 上下文条独有的那块设备图标，没有 user_code 时整块都不该渲染
      expect(screen.queryByRole("img", { hidden: true })).toBeNull();
    });

    it("shows context strip when user_code is in URL", () => {
      renderLogin("?user_code=A4F-7Q2");
      expect(screen.getByText("A4F-7Q2")).toBeTruthy();
    });

    it("uses mono font for the device code in context strip", () => {
      renderLogin("?user_code=A4F-7Q2");
      // spec「登录」：「下面是等宽的设备码」——0/O、1/l 要一眼分得开
      const strip = document.querySelector(".font-mono");
      expect(strip?.textContent).toContain("A4F-7Q2");
    });

    it("context strip has primary-soft background", () => {
      renderLogin("?user_code=A4F-7Q2");
      // spec「登录」：「插入一块 primary-soft 的上下文条」
      const strip = document.querySelector(".bg-primary-soft");
      expect(strip).toBeTruthy();
    });
  });

  describe("error handling", () => {
    it("does not show error when err param is absent", () => {
      renderLogin();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    // spec「失败路径 · 登录失败」：Alert「含标题「登录未完成」与具体原因」
    it("shows a titled failure alert when err param is present", () => {
      renderLogin("?err=access_denied");
      expect(screen.getByRole("alert").textContent).toContain(
        "Sign in unsuccessful",
      );
    });

    it("shows retry button when err is present", () => {
      renderLogin("?err=access_denied");
      expect(
        screen.getByRole("button", { name: /Sign in again/i }),
      ).toBeTruthy();
    });

    it("hides GitHub login button when error is shown", () => {
      renderLogin("?err=access_denied");
      // 失败态里只留「重新登录」一个动作，两个登录按钮会让人不知道该点哪个
      expect(screen.queryByRole("button", { name: /GitHub/i })).toBeNull();
    });

    // 六条已知 err 走 locale 文案，而不是把后端的原始码抛给用户
    it("uses known error message for recognized err codes", () => {
      renderLogin("?err=github_email_missing");
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(
        "Set a verified primary email in your GitHub settings",
      );
      expect(alert.textContent).not.toContain("github_email_missing");
    });

    it("shows err code verbatim for unknown error codes", () => {
      renderLogin("?err=unknown_error_code");
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("unknown_error_code");
    });

    // err 是 URL 里来的，谁都能给受害者递一条 /login?err=<任意一句话>。
    // 「未知码原样透出」的本意是透出一个**码**，不是让攻击者在我们自己的
    // 域名、自己的失败卡里写一句话——那是一条免费的钓鱼提示。
    it("refuses to echo an err value that is prose rather than a code", () => {
      renderLogin(
        "?err=" +
          encodeURIComponent(
            "Your account is locked. Call +1-555-0100 to restore access.",
          ),
      );
      const alert = screen.getByRole("alert");
      // 失败本身照说：标题和重试按钮都在
      expect(alert.textContent).toContain("Sign in unsuccessful");
      expect(
        screen.getByRole("button", { name: /Sign in again/i }),
      ).toBeTruthy();
      // 但那句话一个字都不许上屏
      expect(alert.textContent).not.toContain("+1-555-0100");
      expect(alert.textContent).not.toContain("Your account is locked");
    });

    it("failure alert has destructive-soft background", () => {
      renderLogin("?err=access_denied");
      const alert = screen.getByRole("alert");
      expect(alert.className).toContain("bg-destructive-soft");
    });
  });

  describe("Chinese locale", () => {
    beforeEach(async () => {
      await i18n.changeLanguage("zh-CN");
    });

    it("shows Chinese title", () => {
      renderLogin();
      expect(
        screen.getByRole("heading", { level: 1, name: /登录 AgentRe/ }),
      ).toBeTruthy();
    });

    it("shows context strip with Chinese label when user_code is present", () => {
      renderLogin("?user_code=A4F-7Q2");
      expect(screen.getByText(/登录后继续授权设备/)).toBeTruthy();
    });

    it("shows Chinese retry button on error", () => {
      renderLogin("?err=access_denied");
      expect(screen.getByRole("button", { name: /重新登录/ })).toBeTruthy();
    });

    it("shows Chinese error message for known err codes", () => {
      renderLogin("?err=access_denied");
      expect(screen.getByText(/取消了 GitHub 授权/)).toBeTruthy();
    });
  });

  describe("interaction", () => {
    it("retry button is clickable when error is shown", () => {
      renderLogin("?err=access_denied");
      const retryBtn = screen.getByRole("button", {
        name: /Sign in again/i,
      }) as HTMLButtonElement;
      expect(retryBtn.disabled).toBe(false);
    });
  });
});
