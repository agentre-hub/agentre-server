import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

/** 已经移除的底部 TabBar 的高度（74px + 安全区）：任何导航都不该再长这个高。 */
const MOBILE_TAB_BAR_HEIGHT = "calc(74px + env(safe-area-inset-bottom, 0px))";

/** jsdom 会改写 `calc(... env(...))`，把常量同样喂给探针元素再读回来比较。 */
function jsdomStyleOf(prop: "height", value: string): string {
  const probe = document.createElement("div");
  probe.style[prop] = value;
  return probe.style[prop];
}

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const me = {
  user_id: 1,
  email: "dev@agentre.dev",
  display_name: "Dev User",
  avatar_url: "",
  github_login: "dev",
  csrf_token: "t",
};

const originalMatchMedia = window.matchMedia;

function mockMobileViewport() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  // 默认无数据：账号区不出现（不伪造）。
  mockedApi.mockRejectedValue(new Error("network down"));
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

/**
 * 移动端主导航（规格 2026-11-05 手机 PWA「外壳与导航」，取代 2026-09 的底部 TabBar）：
 *   - 手机：没有底部 TabBar、没有固定侧栏；顶层页页头左侧是 ☰，点开左抽屉。
 *   - 抽屉自上而下：账号区 → 主导航（对话带「需要你」角标、设备带在线/总数）→
 *     更多（活跃统计、设置）→ 底部主题与语言。
 *   - 非顶层页页头左侧是返回，不显示 ☰。
 *   - 桌面：保持固定侧栏，不出现 ☰。
 */
function renderShell(initial = "/chat", title?: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <ThemeProvider>
        <AppShell title={title}>
          <div>page content</div>
        </AppShell>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function mockData() {
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/auth/me") return me;
    if (path === "/v1/devices")
      return {
        devices: [
          { id: 1, kind: "agentred", online: true },
          { id: 2, kind: "agentred", online: true },
          { id: 3, kind: "agentred", online: false },
        ],
      };
    if (path === "/v1/agent-sessions/attention-count")
      return { needs_attention: 2, unread: 1 };
    throw new Error("unexpected: " + path);
  });
}

async function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  return await screen.findByRole("dialog");
}

describe("移动端左抽屉导航", () => {
  it("手机：没有底部 TabBar、没有固定侧栏；页头有 ☰，抽屉默认关着", () => {
    mockMobileViewport();
    renderShell("/chat", "Chat");

    for (const nav of screen.queryAllByRole("navigation")) {
      expect(nav.style.height).not.toBe(
        jsdomStyleOf("height", MOBILE_TAB_BAR_HEIGHT),
      );
    }
    expect(screen.queryByRole("link", { name: "Devices" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
    expect(screen.getByText("page content")).toBeTruthy();
  });

  it("手机：☰ 打开抽屉，主导航、更多、账号区各项可达", async () => {
    mockMobileViewport();
    mockData();
    renderShell();
    const drawer = await openDrawer();

    for (const label of [
      "Chat",
      "Board",
      "Agents & org",
      "Devices",
      "Activity stats",
      "Settings",
    ]) {
      expect(
        within(drawer).getByRole("link", { name: new RegExp(label) }),
      ).toBeTruthy();
    }
    const account = await within(drawer).findByRole("link", {
      name: /Dev User/,
    });
    expect(account.getAttribute("href")).toBe("/account");
    expect(within(drawer).getByText("dev@agentre.dev")).toBeTruthy();
  });

  it("手机：抽屉底部有主题与语言；页头不再有", async () => {
    mockMobileViewport();
    renderShell();
    expect(screen.queryByRole("button", { name: /Language/i })).toBeNull();
    const drawer = await openDrawer();
    expect(
      within(drawer).getByRole("button", { name: /Language/i }),
    ).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: /Theme/i })).toBeTruthy();
  });

  it("手机：对话项带「需要你」角标，设备项带 在线/总数", async () => {
    mockMobileViewport();
    mockData();
    renderShell();
    const drawer = await openDrawer();

    const chat = await within(drawer).findByRole("link", { name: /Chat/ });
    // 抽屉的角标只数「需要你」（2），未读（1）不并进去。
    expect(await within(chat).findByText("2")).toBeTruthy();
    expect(within(chat).queryByText("3")).toBeNull();
    expect(within(chat).getByTitle("2 conversations need you")).toBeTruthy();
    const devices = within(drawer).getByRole("link", { name: /Devices/ });
    expect(await within(devices).findByText("2/3")).toBeTruthy();
  });

  it("手机：只有未读、没有需要你时不画角标", async () => {
    mockMobileViewport();
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/agent-sessions/attention-count")
        return { needs_attention: 0, unread: 4 };
      throw new Error("unexpected: " + path);
    });
    renderShell();
    const drawer = await openDrawer();
    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/agent-sessions/attention-count",
      ),
    );
    const chat = within(drawer).getByRole("link", { name: /Chat/ });
    expect(chat.querySelector("[title]")).toBeNull();
    expect(within(chat).queryByText("4")).toBeNull();
  });

  it("手机：没有待处理时不画角标", async () => {
    mockMobileViewport();
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/agent-sessions/attention-count")
        return { needs_attention: 0, unread: 0 };
      throw new Error("unexpected: " + path);
    });
    renderShell();
    const drawer = await openDrawer();
    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/agent-sessions/attention-count",
      ),
    );
    const chat = within(drawer).getByRole("link", { name: /Chat/ });
    expect(chat.querySelector("[title]")).toBeNull();
  });

  it("手机：当前页在抽屉里高亮", async () => {
    mockMobileViewport();
    renderShell("/devices");
    const drawer = await openDrawer();
    expect(
      within(drawer)
        .getByRole("link", { name: /Devices/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(drawer)
        .getByRole("link", { name: /Chat/ })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("手机：点任一项后抽屉关闭", async () => {
    mockMobileViewport();
    renderShell();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole("link", { name: /Settings/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("手机：Escape 可关；宽 84% 最宽 320px，220ms ease-out，减弱动态下不做动画", async () => {
    mockMobileViewport();
    renderShell();
    const drawer = await openDrawer();
    const cls = drawer.className;
    expect(cls).toContain("w-[84%]");
    expect(cls).toContain("max-w-[320px]");
    expect(cls).toContain("duration-[220ms]");
    expect(cls).toContain("ease-out");
    expect(cls).toContain("motion-safe:data-[state=open]:animate-in");
    expect(cls).toContain("motion-safe:data-[state=open]:slide-in-from-left");
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("手机：非顶层页页头是返回而不是 ☰", () => {
    mockMobileViewport();
    renderShell("/org/agent/abc", "Agent");
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("手机：顶层页页头显示标题", () => {
    mockMobileViewport();
    renderShell("/devices", "Devices");
    expect(
      within(screen.getByTestId("app-topbar")).getByText("Devices"),
    ).toBeTruthy();
  });
});

describe("桌面端导航（非移动）", () => {
  it("保持固定侧栏，无 ☰、无返回", () => {
    renderShell();

    const nav = screen.getByRole("navigation");
    expect(nav.className).toContain("w-[224px]");
    for (const label of ["Overview", "Chat", "Board", "Devices", "Org"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("link", { name: "Audit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
