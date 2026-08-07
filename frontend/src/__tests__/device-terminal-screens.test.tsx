import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import DeviceSuccess from "@/pages/DeviceSuccess";
import DeviceDenied from "@/pages/DeviceDenied";
import DeviceExpired from "@/pages/DeviceExpired";
import i18n from "@/i18n";

// 见 auth-layout.test.tsx 顶部注释：这几屏都套 AuthLayout，同样要绕开
// jsdom/Node localStorage 环境缺陷（与本任务无关）。
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

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function renderAtState(ui: ReactElement, path: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      {ui}
    </MemoryRouter>,
  );
}

function renderAppAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />);
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
