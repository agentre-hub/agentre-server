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

describe("DeviceSuccess · agentred 收尾（第 3 步）", () => {
  const info = {
    kind: "agentred",
    platform: "linux",
    version: "v0.9.0",
    name: "nuc-01",
  };

  it("从引导来：步骤条 + 所选方式的命令 + 完成去设备页，不再说可以关闭页面", () => {
    renderAtState(<DeviceSuccess />, "/device/success", {
      ...info,
      from: "add-guide",
      method: "docker",
    });
    expect(screen.getByText("docker compose up -d")).toBeTruthy();
    expect(screen.queryByText("agentred service install --start")).toBeNull();
    expect(screen.getByText("nuc-01")).toBeTruthy();
    expect(screen.getByRole("list")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Done, go to devices" })
        .getAttribute("href"),
    ).toBe("/devices");
    expect(screen.queryByText(/close this page/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /manage devices/i })).toBeNull();
  });

  it("CLI 直开（无 method）：native 命令 + 安装说明链接", () => {
    renderAtState(<DeviceSuccess />, "/device/success", info);
    expect(screen.getByText("agentred service install --start")).toBeTruthy();
    expect(screen.getByTestId("device-success-docs-link")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Done, go to devices" }),
    ).toBeTruthy();
  });

  // 规格 W1：「步骤条（01✓ 02✓ 03）+ 标题 + 一句正文 + 命令卡」——按这个次序，
  // 正文紧跟标题、只有一句。
  it("步骤条在标题之前，标题下面紧跟一句正文，再往下才是命令卡", () => {
    renderAtState(<DeviceSuccess />, "/device/success", info);
    const rail = screen.getByRole("list");
    const heading = screen.getByRole("heading", { level: 1 });
    const body = screen.getByText(
      "One last step: register the background service on that machine so it stays online.",
    );
    const command = screen.getByText("agentred service install --start");
    const follows = (a: Element, b: Element) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(rail, heading)).toBe(true);
    expect(heading.nextElementSibling).toBe(body);
    expect(follows(body, command)).toBe(true);
  });

  it("用主机名做标题行、agentred 的 Server 图标", () => {
    const { container } = renderAtState(
      <DeviceSuccess />,
      "/device/success",
      info,
    );
    expect(screen.getByText("nuc-01")).toBeTruthy();
    expect(container.querySelector("svg.lucide-server")).toBeTruthy();
    expect(container.querySelector("svg.lucide-laptop")).toBeNull();
  });
});

describe("DeviceSuccess", () => {
  it("desktop 维持现状：无服务命令，仍是前往控制台管理设备，图标是 Laptop", () => {
    const { container } = renderAtState(<DeviceSuccess />, "/device/success", {
      kind: "desktop",
      platform: "macOS",
      version: "15.2",
      name: "mbp",
    });
    expect(screen.queryByText("agentred service install --start")).toBeNull();
    expect(screen.getByRole("link", { name: /manage devices/i })).toBeTruthy();
    expect(screen.getByText("mbp")).toBeTruthy();
    expect(container.querySelector("svg.lucide-laptop")).toBeTruthy();
  });

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

  it("has exactly one h1 and no close-window button", () => {
    renderAtState(<DeviceDenied />, "/device/denied");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /close page/i })).toBeNull();
  });

  it("explains the outcome in one body sentence", () => {
    renderAtState(<DeviceDenied />, "/device/denied");
    expect(
      screen.getByText(
        "This device will not be connected to your account. If you clicked by mistake, go back to the device and start authorization again.",
      ),
    ).toBeTruthy();
  });

  it("gives a primary link back to /device to enter a new code", () => {
    renderAtState(<DeviceDenied />, "/device/denied");
    expect(
      screen
        .getByRole("link", { name: "Enter a new code" })
        .getAttribute("href"),
    ).toBe("/device");
  });

  it("gives a text link to the console", () => {
    renderAtState(<DeviceDenied />, "/device/denied");
    expect(
      screen
        .getByRole("link", { name: "Go to the console" })
        .getAttribute("href"),
    ).toBe("/overview");
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

  it("never calls window.close", () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    renderAtState(<DeviceDenied />, "/device/denied");
    expect(closeSpy).not.toHaveBeenCalled();
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
