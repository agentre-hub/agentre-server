import type { ReactElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ComingSoon from "@/pages/ComingSoon";
import Device from "@/pages/Device";
import DeviceExpired from "@/pages/DeviceExpired";
import Devices from "@/pages/Devices";
import Login from "@/pages/Login";
import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n, { resources } from "@/i18n";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const originalMatchMedia = window.matchMedia;
const originalLocation = window.location;

function setMobile(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function renderAt(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>, { wrapper: ThemeProvider });
}

function renderLogin() {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    value: { ...originalLocation, search: "", assign, href: "/login" },
    writable: true,
    configurable: true,
  });
  renderAt(<Login />);
  return assign;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.mocked(api).mockReset();
  vi.mocked(api).mockRejectedValue(new Error("unexpected call"));
  window.history.replaceState({}, "", "/device");
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

describe("条款 / 隐私 / 状态页（J4）", () => {
  it.each([
    ["terms", "Terms of Service"],
    ["privacy", "Privacy Policy"],
    ["status", "Status"],
  ] as const)("手机上 %s 页有 ‹ 回登录的页头，直接打开也有", (page, title) => {
    setMobile(true);
    renderAt(<ComingSoon page={page} />);
    const header = screen.getByTestId("auth-mobile-header");
    const back = within(header).getByRole("link", { name: /back to sign in/i });
    expect(back.getAttribute("href")).toBe("/login");
    expect(within(header).getByText(title)).toBeTruthy();
    // 返回键 44px
    expect(back.className).toMatch(/\bsize-11\b/);
  });

  it("桌面不出现返回页头", () => {
    setMobile(false);
    renderAt(<ComingSoon page="terms" />);
    expect(screen.queryByTestId("auth-mobile-header")).toBeNull();
    expect(screen.queryByRole("link", { name: /back to sign in/i })).toBeNull();
  });
});

describe("登录 · 同意行与等待态（J4、F6）", () => {
  it("手机上同意行整行 44px；点行内文字（非链接）即勾选，点链接不勾选", () => {
    setMobile(true);
    renderLogin();
    const row = screen.getByTestId("login-consent");
    expect(row.className).toMatch(/\bmin-h-11\b/);
    const box = screen.getByRole("checkbox");
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByText(/I have read and agree/i));
    expect(box.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByText(/I have read and agree/i));
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("link", { name: /terms/i }));
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("点行内空白处（label 之外）也勾选，一次只翻一次", () => {
    setMobile(true);
    renderLogin();
    fireEvent.click(screen.getByTestId("login-consent"));
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("桌面同意行不加 44px", () => {
    setMobile(false);
    renderLogin();
    expect(screen.getByTestId("login-consent").className).not.toMatch(
      /min-h-11/,
    );
  });

  it("点 GitHub 登录后按钮进入等待态，再点不会重复发起", () => {
    setMobile(true);
    const assign = renderLogin();
    fireEvent.click(screen.getByRole("checkbox"));
    const btn = screen.getByRole("button", { name: /Sign in with GitHub/i });
    fireEvent.click(btn);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("从 bfcache 返回（pageshow persisted）时等待态解除", () => {
    setMobile(true);
    renderLogin();
    fireEvent.click(screen.getByRole("checkbox"));
    const btn = screen.getByRole("button", { name: /Sign in with GitHub/i });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    const ev = new Event("pageshow") as Event & { persisted: boolean };
    ev.persisted = true;
    fireEvent(window, ev);
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("设备授权 · 同一手机版式（J6）", () => {
  it("输码页：‹授权设备› 页头、没有「Device authorization」眉题与页脚，继续钉底", () => {
    setMobile(true);
    renderAt(<Device />);
    expect(screen.getByTestId("auth-mobile-header")).toBeTruthy();
    expect(screen.getByText("Authorize device")).toBeTruthy();
    expect(screen.queryByText("Device authorization")).toBeNull();
    const pinned = screen.getByTestId("auth-pinned");
    expect(
      within(pinned).getByRole("button", { name: /continue/i }),
    ).toBeTruthy();
    expect(screen.queryByText(/© \d{4} Agentre/)).toBeNull();
  });

  it("输码页：钉底的继续键仍能提交；不足 6 位时焦点去第一个空格", () => {
    setMobile(true);
    renderAt(<Device />);
    const boxes = screen.getAllByRole("textbox") as HTMLInputElement[];
    boxes[0].focus();
    fireEvent.change(boxes[0], { target: { value: "K" } });
    fireEvent.change(boxes[1], { target: { value: "7" } });
    boxes[5].focus();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(api).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(boxes[2]);
  });

  it("桌面输码页提交不足 6 位同样聚焦第一个空格，且仍是居中卡片", () => {
    setMobile(false);
    renderAt(<Device />);
    expect(screen.queryByTestId("auth-pinned")).toBeNull();
    const boxes = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(boxes[0], { target: { value: "K" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(document.activeElement).toBe(boxes[1]);
  });

  it("过期页：照拒绝页，页头 + 居中说明，重新输入钉底、无页脚", () => {
    setMobile(true);
    renderAt(<DeviceExpired />);
    const pinned = screen.getByTestId("auth-pinned");
    const retry = within(pinned).getByRole("link", {
      name: /enter a new code|re-?enter/i,
    });
    expect(retry.getAttribute("href")).toBe("/device");
    expect(retry.className).toMatch(/\bh-11\b/);
    expect(screen.queryByText(/© \d{4} Agentre/)).toBeNull();
  });

  it("桌面过期页不变：卡片 + 页脚，没有钉底", () => {
    setMobile(false);
    renderAt(<DeviceExpired />);
    expect(screen.queryByTestId("auth-pinned")).toBeNull();
    expect(screen.getByText(/© \d{4} Agentre/)).toBeTruthy();
  });

  it("文案统一用「账号」，不再出现「账户」", async () => {
    expect(JSON.stringify(resources["zh-CN"].translation.device)).not.toContain(
      "账户",
    );
  });
});

describe("设备重命名对话框（I23）", () => {
  it("打开后焦点在输入框，不在 ✕", async () => {
    setMobile(false);
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/v1/devices")
        return {
          devices: [
            {
              id: 1,
              name: "mac-mini",
              display_name: "",
              kind: "desktop",
              platform: "darwin/arm64",
              version: "dev",
              fingerprint: "fp-1",
              last_seen_at: 1754000000000,
              status: 1,
              online: false,
              is_this_device: false,
            },
          ],
        };
      throw new Error("unexpected call: " + path);
    });
    renderAt(<Devices />);
    const row = (await screen.findByText("mac-mini")).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    fireEvent.pointerDown(
      within(row).getByRole("button", { name: "Actions for mac-mini" }),
      { button: 0, ctrlKey: false },
    );
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});
