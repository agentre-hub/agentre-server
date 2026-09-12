import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import DeviceSuccess from "@/pages/DeviceSuccess";
import DeviceDenied from "@/pages/DeviceDenied";
import DeviceExpired from "@/pages/DeviceExpired";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function renderAtState(ui: ReactElement, path: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      {ui}
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

function renderAppAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />, { wrapper: ThemeProvider });
}

describe("DeviceSuccess", () => {
  it("renders the device info panel when kind/platform/version were carried from the approval step", () => {
    renderAtState(<DeviceSuccess />, "/device/success", {
      kind: "desktop",
      platform: "macOS",
      version: "15.2",
    });
    expect(screen.getByText("Desktop")).toBeTruthy();
    expect(screen.getByText("macOS · 15.2")).toBeTruthy();
  });

  it("omits the device panel and renders everything else on a direct visit with no data", () => {
    renderAtState(<DeviceSuccess />, "/device/success");
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.queryByText("macOS · 15.2")).toBeNull();
    expect(screen.getByRole("link", { name: /manage devices/i })).toBeTruthy();
  });

  it("never claims the device is online or connected", () => {
    renderAtState(<DeviceSuccess />, "/device/success", {
      kind: "desktop",
      platform: "macOS",
      version: "15.2",
    });
    expect(screen.queryByText(/connected/i)).toBeNull();
  });

  it("has exactly one h1", () => {
    renderAtState(<DeviceSuccess />, "/device/success");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("links the secondary button to /devices", () => {
    renderAtState(<DeviceSuccess />, "/device/success");
    expect(
      screen
        .getByRole("link", { name: /manage devices/i })
        .getAttribute("href"),
    ).toBe("/devices");
  });
});

describe("DeviceDenied", () => {
  it("is reachable at /device/denied outside the session-gated routes", () => {
    renderAppAt("/device/denied");
    expect(
      screen.getByRole("heading", { level: 1, name: /denied/i }),
    ).toBeTruthy();
  });

  it("has exactly one h1 and a neutral (non-destructive) close button", () => {
    renderAtState(<DeviceDenied />, "/device/denied");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const button = screen.getByRole("button", { name: /close page/i });
    expect(button.getAttribute("data-variant")).not.toBe("destructive");
  });

  // spec「失败路径」：「这一屏是中性收尾，不使用 destructive 色。」
  // 拒绝是用户自己的决定，不是一次报错——整屏一个 destructive 色都不该上身，
  // 包括图标底板那圈。只断按钮 variant 拦不住写在 className 里的红色。
  //
  // 只看无条件生效的类：shadcn Button 的基础样式里带着
  // `aria-invalid:border-destructive`，那是没设 aria-invalid 就不上色的分支，
  // 算不上「这一屏用了 destructive」。所以按变体前缀（冒号）过滤。
  it("uses no destructive colour anywhere on the screen", () => {
    const { container } = renderAtState(<DeviceDenied />, "/device/denied");
    const painted = [...container.querySelectorAll<HTMLElement>("[class]")]
      .flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/))
      .filter((c) => /^(bg|text|border|ring|fill)-destructive/.test(c));
    expect(painted).toEqual([]);
  });

  it("closes the page on click", () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    renderAtState(<DeviceDenied />, "/device/denied");
    screen.getByRole("button", { name: /close page/i }).click();
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });
});

describe("DeviceExpired", () => {
  it("is reachable at /device/expired outside the session-gated routes", () => {
    renderAppAt("/device/expired");
    expect(
      screen.getByRole("heading", { level: 1, name: /expired/i }),
    ).toBeTruthy();
  });

  it("has exactly one h1", () => {
    renderAtState(<DeviceExpired />, "/device/expired");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("sends the user back to /device to enter a new code", () => {
    renderAtState(<DeviceExpired />, "/device/expired");
    expect(
      screen
        .getByRole("link", { name: /enter a new code/i })
        .getAttribute("href"),
    ).toBe("/device");
  });
});
