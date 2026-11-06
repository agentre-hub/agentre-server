import type { ReactElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DeviceApproval from "@/components/DeviceApproval";
import DeviceDenied from "@/pages/DeviceDenied";
import DeviceSuccess from "@/pages/DeviceSuccess";
import Login from "@/pages/Login";
import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const ME = {
  user_id: 1,
  email: "codfrm@example.com",
  display_name: "Cod Frm",
  avatar_url: "",
  github_login: "codfrm",
  csrf_token: "csrf",
};

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

function renderAt(ui: ReactElement, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/x", state }]}>
      {ui}
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

function renderLogin(search = "") {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    value: { ...originalLocation, search, assign, href: "/login" + search },
    writable: true,
    configurable: true,
  });
  renderAt(<Login />);
  return assign;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue(ME);
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

describe.each([
  ["desktop", false],
  ["phone", true],
])("登录 · 未勾同意（%s）", (_name, mobile) => {
  beforeEach(() => setMobile(mobile));

  it("按钮始终可点；未勾选点 GitHub 不发起登录，勾选框高亮并提示先勾选同意", () => {
    const assign = renderLogin();
    const btn = screen.getByRole("button", { name: /Sign in with GitHub/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(btn);

    expect(assign).not.toHaveBeenCalled();
    const box = screen.getByRole("checkbox");
    const hint = screen.getByRole("alert");
    expect(hint.textContent).toMatch(/tick|agree/i);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe(hint.id);
    expect(screen.getByTestId("login-consent").contains(hint)).toBe(true);
  });

  it("勾选后提示消失，再点才发起登录", () => {
    const assign = renderLogin();
    const btn = screen.getByRole("button", { name: /Sign in with GitHub/i });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(btn);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe("登录 · 手机整屏", () => {
  beforeEach(() => setMobile(true));

  it("无卡片、页脚四链接去掉、同意句与按钮钉在拇指区", () => {
    renderLogin();
    expect(screen.queryByRole("contentinfo")).toBeNull();
    const pinned = screen.getByTestId("auth-pinned");
    expect(within(pinned).getByTestId("login-consent")).toBeTruthy();
    expect(
      within(pinned).getByRole("button", { name: /Sign in with GitHub/i }),
    ).toBeTruthy();
    // 条款与隐私仍在同意那句话里
    expect(
      within(pinned).getByRole("link", { name: /Terms of Service/i }),
    ).toBeTruthy();
    expect(pinned.className).toMatch(/safe-area-inset-bottom/);
    expect(document.querySelector(".shadow-overlay")).toBeNull();
  });

  it("带设备码：眉题「设备授权 · 码」+ 一句正文，没有码卡", () => {
    renderLogin("?user_code=A4F-7Q2");
    expect(screen.getByText("Device authorization · A4F-7Q2")).toBeTruthy();
    expect(
      screen.getByText("Sign in to continue authorizing this device"),
    ).toBeTruthy();
    expect(
      screen.queryByText("Continue to device authorization after signing in"),
    ).toBeNull();
  });
});

describe("登录 · 桌面不变", () => {
  beforeEach(() => setMobile(false));
  it("仍有页脚与卡片、没有钉底容器", () => {
    renderLogin();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.queryByTestId("auth-pinned")).toBeNull();
  });
});

describe("授权确认 · 手机", () => {
  const info = {
    device_kind: "desktop",
    platform: "macOS 15.2",
    version: "v0.4.1",
    name: "nuc-01",
    expires_in: 492,
  };
  const props = {
    code: "A4F-7Q2",
    info,
    submitting: false,
    error: null,
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onExpire: vi.fn(),
  };

  it("页头 ✕ · 授权设备；内容依次 账号行、风险句、设备卡、核对码；允许/拒绝钉底", async () => {
    setMobile(true);
    renderAt(<DeviceApproval {...props} />);
    const header = screen.getByTestId("auth-mobile-header");
    expect(within(header).getByText("Authorize device")).toBeTruthy();
    expect(within(header).getByRole("link", { name: "Close" })).toBeTruthy();

    const account = await screen.findByText(/Connecting to Cod Frm/);
    const risk = screen.getByText(
      /full access to your Agentre account as you/i,
    );
    const device = screen.getByTestId("device-title");
    const code = screen.getByText("A4F-7Q2");
    const order = [account, risk, device, code];
    for (let i = 0; i < order.length - 1; i++) {
      expect(
        order[i].compareDocumentPosition(order[i + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    const pinned = screen.getByTestId("auth-pinned");
    const allow = within(pinned).getByRole("button", { name: /Allow access/i });
    fireEvent.click(allow);
    expect(props.onApprove).toHaveBeenCalled();
    fireEvent.click(within(pinned).getByRole("button", { name: "Deny" }));
    expect(props.onDeny).toHaveBeenCalled();
  });
});

describe("授权成功 · 手机", () => {
  const info = {
    kind: "agentred",
    platform: "linux",
    version: "v0.9.0",
    name: "nuc-01",
  };

  it("紧凑步骤条 → 标题 → 一句正文 → 一张命令卡，完成按钮钉底，没有设备卡", () => {
    setMobile(true);
    renderAt(<DeviceSuccess />, info);
    const rail = screen.getByRole("list");
    const heading = screen.getByRole("heading", { level: 1 });
    const command = screen.getByText("agentred service install --start");
    expect(
      rail.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      heading.compareDocumentPosition(command) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("nuc-01")).toBeNull();
    expect(screen.queryByText("agentred service status")).toBeNull();
    const pinned = screen.getByTestId("auth-pinned");
    expect(
      within(pinned)
        .getByRole("link", { name: "Done, go to devices" })
        .getAttribute("href"),
    ).toBe("/devices");
  });
});

describe("授权已拒绝 · 手机", () => {
  it("输入新的代码与前往控制台都钉底", () => {
    setMobile(true);
    renderAt(<DeviceDenied />);
    const pinned = screen.getByTestId("auth-pinned");
    expect(
      within(pinned)
        .getByRole("link", { name: "Enter a new code" })
        .getAttribute("href"),
    ).toBe("/device");
    expect(
      within(pinned).getByRole("link", { name: "Go to the console" }),
    ).toBeTruthy();
  });
});
