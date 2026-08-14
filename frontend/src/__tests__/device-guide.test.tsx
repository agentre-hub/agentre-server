/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://console.example.test/devices" }
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddDeviceGuide } from "@/components/AddDeviceGuide";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";

/**
 * 页内三步引导的内容契约（规格「web 控制台：设备页 · 三步 / 第 1 步 · 装 /
 * 第 2 步 · 登录」）。
 *
 * 这个文件的 jsdom URL 被换成了一个虚构域名：登录命令里的服务器地址必须是
 * **当前控制台自己的地址**，写死任何域名（包括 mockup 里的 hub.agentre.ai）
 * 都会在这里红掉。
 */
function renderGuide() {
  return render(<AddDeviceGuide />, { wrapper: ThemeProvider });
}

const INSTALL_UNIX =
  "curl -fsSL https://github.com/agentre-ai/agentre/releases/latest/download/install.sh | sh";
const INSTALL_WIN =
  "irm https://github.com/agentre-ai/agentre/releases/latest/download/install.ps1 | iex";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("add-device guide · steps and commands", () => {
  it("只提供两种设备类型：计算节点与桌面端（浏览器/移动端不是可加的类型）", () => {
    renderGuide();

    expect(
      screen.getByRole("button", { name: "Compute node (agentred)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Desktop (Agentre App)" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /browser/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /mobile/i })).toBeNull();
  });

  it("第 1 步 · 计算节点：给出所选系统的安装命令与后台服务命令", () => {
    renderGuide();

    expect(screen.getByTestId("add-device-command-install").textContent).toBe(
      INSTALL_UNIX,
    );
    expect(screen.getByTestId("add-device-command-service").textContent).toBe(
      "agentred service install --start",
    );

    fireEvent.click(screen.getByRole("button", { name: "Windows" }));
    expect(screen.getByTestId("add-device-command-install").textContent).toBe(
      INSTALL_WIN,
    );

    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    expect(screen.getByTestId("add-device-command-install").textContent).toBe(
      INSTALL_UNIX,
    );
  });

  it("第 1 步 · 桌面端：换成下载入口，不再有系统切换与 agentred 安装命令", () => {
    renderGuide();

    fireEvent.click(
      screen.getByRole("button", { name: "Desktop (Agentre App)" }),
    );

    expect(screen.queryByTestId("add-device-command-install")).toBeNull();
    expect(screen.queryByRole("button", { name: "Windows" })).toBeNull();
    const download = screen.getByTestId("add-device-download");
    expect(download.getAttribute("href")).toBe(
      "https://github.com/agentre-ai/agentre/releases/latest",
    );
  });

  it("第 2 步 · 计算节点：登录命令带的是当前控制台地址，不是写死的域名", () => {
    renderGuide();

    fireEvent.click(screen.getByTestId("add-device-step-2"));

    expect(screen.getByTestId("add-device-command-login").textContent).toBe(
      "agentred login --server https://console.example.test",
    );

    const body = screen.getByTestId("add-device-step-body").textContent ?? "";
    // 命令会打印 6 位码、会尝试开浏览器、没浏览器就把码带回来
    expect(body).toMatch(/User code/);
    expect(body).toMatch(/browser/i);
    // 有效期可配置：这一屏不许写死任何时长
    expect(body).not.toMatch(/\d+\s*(minutes?|分钟)/);
  });

  it("第 2 步 · 桌面端：同一个控制台地址 + 应用内登录路径", () => {
    renderGuide();

    fireEvent.click(
      screen.getByRole("button", { name: "Desktop (Agentre App)" }),
    );
    fireEvent.click(screen.getByTestId("add-device-step-2"));

    expect(screen.queryByTestId("add-device-command-login")).toBeNull();
    expect(screen.getByTestId("add-device-server-address").textContent).toBe(
      "https://console.example.test",
    );
    const body = screen.getByTestId("add-device-step-body").textContent ?? "";
    expect(body).toMatch(/Settings/);
    expect(body).not.toMatch(/\d+\s*(minutes?|分钟)/);
  });

  it("步骤条三格都可点：跳到第 3 步只换当前步骤，不伪造完成标记", () => {
    renderGuide();

    const step1 = screen.getByTestId("add-device-step-1");
    const step3 = screen.getByTestId("add-device-step-3");
    expect(step1.getAttribute("aria-current")).toBe("step");

    fireEvent.click(step3);

    expect(step3.getAttribute("aria-current")).toBe("step");
    expect(step1.getAttribute("aria-current")).toBeNull();
    // 跳步过去的：第 1/2 步没有点过「下一步」，就不该显示完成
    expect(within(step1).queryByText("Installed")).toBeNull();
    expect(
      within(screen.getByTestId("add-device-step-2")).queryByText("Signed in"),
    ).toBeNull();
  });

  it("点过某一步的「下一步」才出现完成标记，并前进到下一步", () => {
    renderGuide();

    fireEvent.click(screen.getByRole("button", { name: "Installed — next" }));

    const step1 = screen.getByTestId("add-device-step-1");
    const step2 = screen.getByTestId("add-device-step-2");
    expect(within(step1).getByText("Installed")).toBeTruthy();
    expect(step2.getAttribute("aria-current")).toBe("step");
    expect(within(step2).queryByText("Signed in")).toBeNull();
  });

  it("复制按钮把命令原样交给剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderGuide();
    fireEvent.click(screen.getByTestId("add-device-copy-install"));

    expect(writeText).toHaveBeenCalledWith(INSTALL_UNIX);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
});
