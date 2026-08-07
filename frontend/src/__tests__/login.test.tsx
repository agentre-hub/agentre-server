import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Login from "@/pages/Login";
import i18n from "@/i18n";

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

function renderLogin(search: string = "") {
  // Since Login.tsx uses window.location.search directly (not useLocation),
  // we need to mock it for the test
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

    it("shows a footer note about terms and privacy", () => {
      renderLogin();
      // Get the footer by finding the element that contains the specific text
      expect(
        screen.getByText(/By continuing, you agree to AgentRe/i),
      ).toBeTruthy();
    });
  });

  describe("user_code context strip", () => {
    it("does not show context strip when user_code is absent", () => {
      renderLogin();
      // Check that there's no laptop icon (which is only in the context strip)
      expect(screen.queryByRole("img", { hidden: true })).toBeNull();
    });

    it("shows context strip when user_code is in URL", () => {
      renderLogin("?user_code=A4F-7Q2");
      // Look for the device code - might match multiple elements due to parent text content
      const codeElements = screen.queryAllByText((content, element) => {
        // Only match leaf elements, not parents
        if (!element) return false;
        return (
          element.textContent === "A4F-7Q2" ||
          element.textContent?.trim() === "A4F-7Q2"
        );
      });
      expect(codeElements.length).toBeGreaterThan(0);
    });

    it("uses mono font for the device code in context strip", () => {
      renderLogin("?user_code=A4F-7Q2");
      // Find the element that contains the device code and has font-mono
      const strip = document.querySelector(".font-mono");
      expect(strip?.textContent).toContain("A4F-7Q2");
    });

    it("context strip has primary-soft background", () => {
      renderLogin("?user_code=A4F-7Q2");
      // Check that primary-soft is used
      const strip = document.querySelector(".bg-primary-soft");
      expect(strip).toBeTruthy();
    });
  });

  describe("error handling", () => {
    it("does not show error when err param is absent", () => {
      renderLogin();
      // No alert should be present
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows failure alert when err param is present", () => {
      renderLogin("?err=access_denied");
      const alert = screen.getByRole("alert");
      expect(alert).toBeTruthy();
    });

    it("shows retry button when err is present", () => {
      renderLogin("?err=access_denied");
      // Look for a button that's not the GitHub button
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThanOrEqual(1);
      // The retry button should exist when there's an error
      expect(
        buttons.some(
          (btn) =>
            btn.textContent?.includes("Sign in again") ||
            btn.textContent?.includes("重新登录"),
        ),
      ).toBeTruthy();
    });

    it("hides GitHub login button when error is shown", () => {
      renderLogin("?err=access_denied");
      // The GitHub button should not be present when there's an error
      const githubBtn = screen.queryByRole("button", { name: /GitHub/i });
      expect(githubBtn).toBeNull();
    });

    it("uses known error message for recognized err codes", () => {
      renderLogin("?err=github_email_missing");
      const alert = screen.getByRole("alert");
      // The error message should be in the alert
      const errorMsg = alert.textContent || "";
      expect(errorMsg.length).toBeGreaterThan(0);
    });

    it("shows err code verbatim for unknown error codes", () => {
      renderLogin("?err=unknown_error_code");
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("unknown_error_code");
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
      // Find all buttons and check that there's one that's not the GitHub button
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThan(0);
      // The retry button should exist and be enabled
      const retryBtn = buttons.find(
        (btn) =>
          btn.textContent?.includes("Sign in again") ||
          btn.textContent?.includes("重新登录"),
      ) as HTMLButtonElement | undefined;
      expect(retryBtn?.disabled).toBe(false);
    });
  });
});
