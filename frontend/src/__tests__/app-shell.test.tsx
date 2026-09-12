/**
 * 控制台外壳（任务 2，正式节点 R969Y/ZC7pI；任务 9 把组织面加进主导航）：
 *   - 桌面 SideNav：Brand（logo + AgentRe + 「控制台」副标）+ 非交互搜索外观 +
 *     5 个导航项（经由共享 ConsoleNavItem 渲染，第 4 项「组织」去 /org、
 *     第 5 项「设置」去 /settings）+ 底部账号区；移动 TabBar 4 项，不含设置。
 *     不包含审计：无后端，空壳页已下线。
 *   - 搜索无真实能力：外观不可聚焦（不是 button/input，无 tabindex）、
 *     不暗示可用快捷键（无 ⌘K）。
 *   - TopBar：title 槽（可选）+ right 槽（可选）+ AppControls；不传 title 时左侧空。
 *   - 锦上添花数据：/v1/devices、/v1/auth/me 取不到就隐藏对应元素，
 *     不阻塞整体渲染（无数据态）。对话导航不摆已保存总数，避免误读成未读数。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AppShell from "@/components/AppShell";
import * as accountChannel from "@/lib/accountChannel";
import { api } from "@/lib/api";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedApi = vi.mocked(api);
const mockedStartChannel = vi.mocked(accountChannel.startAccountChannel);

/** 把一条信号送进这个标签页共用的那条通道。 */
function deliver(signalType: string): void {
  const call = mockedStartChannel.mock.calls.at(-1);
  expect(call).toBeDefined();
  call![0].onRefresh(signalType);
}

const me = {
  user_id: 1,
  email: "dev@agentre.dev",
  display_name: "Dev User",
  avatar_url: "",
  github_login: "dev",
  csrf_token: "t",
};

const devices = [
  { id: 1, kind: "agentred", online: true },
  { id: 2, kind: "agentred", online: true },
  { id: 3, kind: "agentred", online: false },
];

const REAL_NAV = ["Overview", "Chat", "Board", "Devices", "Org", "Settings"];

function renderShell(
  ui: React.ReactElement = <AppShell>page content</AppShell>,
) {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <ThemeProvider>{ui}</ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  // 默认：所有请求都失败 → 无数据态（接口不可用 / 未登录都不让外壳崩）。
  mockedApi.mockRejectedValue(new Error("network down"));
});

describe("桌面 SideNav（任务 2 外壳，R969Y）", () => {
  it("Brand：logo + AgentRe + 控制台副标", async () => {
    renderShell();
    expect(screen.getByText("AgentRe")).toBeTruthy();
    expect(screen.getByText("Console")).toBeTruthy();
  });

  it("侧栏没有搜索框——外壳层没有搜索能力，就不摆一个搜索的样子", async () => {
    renderShell();
    // 这里曾经有一个「保留外观」的假搜索框：aria-hidden、不可聚焦、无 button
    // 语义、打字没有任何反应。它把可用性问题伪装成了样式问题——用户看见输入框
    // 就会去点，点了什么也不发生。真正的搜索在 Chat 页里（同一个 i18n key），
    // 那个是能用的。
    expect(
      screen.queryByText("Search agents, devices, and records"),
    ).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("6 个导航项经由共享 ConsoleNavItem 渲染（文案在 item 内层 span，链接本身不带字阶）", async () => {
    renderShell();
    for (const label of REAL_NAV) {
      const link = screen.getByRole("link", { name: label });
      // ConsoleNavItem 把 13px 字阶放在内层 label span，而不是链接类上。
      expect(link.className).not.toContain("text-aux");
      expect(within(link).getByText(label).className).toContain("text-aux");
    }
  });

  it("导航不含审计项（无后端，空壳页已下线）", async () => {
    renderShell();
    expect(screen.queryByRole("link", { name: "Audit" })).toBeNull();
    expect(screen.queryByRole("link", { name: /audit/i })).toBeNull();
  });

  it("第 5 项「组织」指向 /org，第 6 项「设置」指向 /settings", async () => {
    renderShell();
    const nav = screen.getByRole("navigation");
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent?.trim())).toEqual(REAL_NAV);
    expect(screen.getByRole("link", { name: "Org" }).getAttribute("href")).toBe(
      "/org",
    );
    expect(
      screen.getByRole("link", { name: "Settings" }).getAttribute("href"),
    ).toBe("/settings");
  });

  it("无数据态：对话 Badge、设备 Meta、账号区全部隐藏，不阻塞渲染", async () => {
    renderShell();
    await screen.findByText("Console");
    expect(screen.queryByText("Personal · Free")).toBeNull();
    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
    expect(screen.queryByText("Dev User")).toBeNull();
    expect(screen.getByText("page content")).toBeTruthy();
  });

  it("有数据：对话导航挂「需要你」角标，设备 Meta 与账号区照常显示", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/devices") return { devices };
      if (path === "/v1/agent-sessions/attention-count")
        return { needs_attention: 2, unread: 1 };
      throw new Error("unexpected: " + path);
    });
    renderShell();
    expect(await screen.findByText("2/3")).toBeTruthy(); // /v1/devices 在线/全部
    // 角标数的是**需要你的那些**（等你处理 + 未读），不是已保存总数：后者摆在这里
    // 会被读成「有 N 条新的」，而它其实一天都不会变。
    const chat = screen.getByRole("link", { name: /^Chat/ });
    expect(await within(chat).findByText("3")).toBeTruthy();
    // 为了一个数字拉一整页索引是这条路径上最贵的一件事——它每次进任何页面都跑。
    expect(
      mockedApi.mock.calls.some(([path]) =>
        String(path).startsWith("/v1/agent-sessions?"),
      ),
    ).toBe(false);
    expect(screen.getByText("Dev User")).toBeTruthy(); // 账号名
    expect(screen.getByText("dev@agentre.dev")).toBeTruthy(); // 账号邮箱（任务 7：取代旧的「个人 · 免费」）
    expect(screen.getByText("D")).toBeTruthy(); // 首字母头像
  });

  it("设备 Meta 与总览同一口径：桌面端也算，不另滤 web", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path.startsWith("/v1/agent-sessions?")) {
        return { total: 0, groups: [] };
      }
      if (path === "/v1/devices") {
        return {
          devices: [
            { id: 1, kind: "desktop", online: true },
            { id: 2, kind: "agentred", online: false },
          ],
        };
      }
      throw new Error("unexpected: " + path);
    });
    renderShell();
    // /v1/devices 已不返回 web。侧栏曾经只数 agentred，同一份列表会显示 0/1。
    expect(await screen.findByText("1/2")).toBeTruthy();
    expect(screen.queryByText("0/1")).toBeNull();
  });

  it("桌面无汉堡按钮、无抽屉", async () => {
    renderShell();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("TopBar（任务 2）", () => {
  it("title 传入时渲染在标题槽", async () => {
    renderShell(<AppShell title="Page Title">body</AppShell>);
    expect(screen.getByText("Page Title")).toBeTruthy();
  });

  it("不传 title 时标题槽为空，右侧仍渲染 AppControls", async () => {
    renderShell();
    expect(screen.queryByText("Page Title")).toBeNull();
    expect(screen.getByRole("button", { name: /Language/i })).toBeTruthy();
  });

  it("right 槽位：传入的 ReactNode 渲染在 AppControls 旁", async () => {
    renderShell(
      <AppShell right={<button>Custom Action</button>}>body</AppShell>,
    );
    expect(screen.getByRole("button", { name: "Custom Action" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Language/i })).toBeTruthy();
  });
});

/**
 * 账号菜单（任务 7，规格「用户菜单与 /account」菜单段）：桌面侧栏与移动
 * TopBar 的账号块变成同一个 UserMenu 组件的触发器，可键盘打开/关闭，
 * 选「登出」真的调用端点并落地登录页。逐项键盘行为在
 * __tests__/user-menu.test.tsx 单测；这里只确认 AppShell 把它接对了地方。
 */
describe("账号菜单（任务 7）", () => {
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

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("桌面：账号区是可键盘打开的菜单，含账号与安全（去 /account）、登出", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      throw new Error("unexpected: " + path);
    });
    renderShell();
    const trigger = await screen.findByRole("button", {
      name: "Account menu",
    });

    fireEvent.keyDown(trigger, { key: "Enter" });
    const account = screen.getByRole("menuitem", {
      name: /Account & security/i,
    });
    expect(account.getAttribute("href")).toBe("/account");
    expect(screen.getByRole("menuitem", { name: /Sign out/i })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // 窄屏与侧栏同源：同一个数、同一句说明。此前 mobileTabs 派生时把 badge 丢了，
  // 手机上因此完全看不到有多少条在等你。
  it("移动 TabBar 的对话项带着与侧栏同一个角标", async () => {
    mockMobileViewport();
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/devices") return { devices };
      if (path === "/v1/agent-sessions/attention-count")
        return { needs_attention: 2, unread: 1 };
      throw new Error("unexpected: " + path);
    });
    renderShell();

    const chat = await screen.findByRole("link", { name: /Chat/ });
    expect(await within(chat).findByText("3")).toBeTruthy();
    expect(
      within(chat).getByTitle("2 conversations need you · 1 unread"),
    ).toBeTruthy();
  });

  it("移动 TabBar 固定为 5 项，不把桌面末项设置挤进去", async () => {
    mockMobileViewport();
    renderShell();

    const nav = screen.getByRole("navigation");
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(5);
    expect(links.map((link) => link.textContent?.trim())).toEqual(
      REAL_NAV.slice(0, 5),
    );
    expect(within(nav).queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("移动：TopBar 账号区用同一组件的紧凑形态，设置可从菜单进入、登出真调用端点并落地登录页", async () => {
    mockMobileViewport();
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/auth/logout") return {};
      throw new Error("unexpected: " + path);
    });
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });

    renderShell();
    const trigger = await screen.findByRole("button", {
      name: "Account menu",
    });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(
      screen.getByRole("menuitem", { name: /Account & security/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Settings/i }).getAttribute("href"),
    ).toBe("/settings");
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/i }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith("/v1/auth/logout", {
        method: "POST",
      }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });
});

describe("控制台外壳：设备 Meta 跟着通道走", () => {
  beforeEach(() => {
    mockedStartChannel.mockClear();
  });

  // 侧栏那个「在线/全部」此前只在挂载时取一次，一台机器上线之后要整页刷新或者
  // 切一次路由才看得到。它只关心在线态这一类信号：别人发条消息不该让它重取。
  it("设备上线的信号一到就重取，不用刷新整页", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/devices") return { devices };
      throw new Error("unexpected: " + path);
    });
    renderShell();
    expect(await screen.findByText("2/3")).toBeTruthy();

    // 第三台上线了。
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/devices") {
        return { devices: devices.map((d) => ({ ...d, online: true })) };
      }
      throw new Error("unexpected: " + path);
    });
    deliver(accountChannel.AccountChannelDevicePresence);

    expect(await screen.findByText("3/3")).toBeTruthy();
  });

  // 侧栏只关心在线态。别人发了条消息、组织架构改了名，都不该让它重取一遍设备。
  it("与设备无关的信号不重取设备", async () => {
    // 数的是 /v1/devices 这一条，不是全部请求：外壳里不止一个订阅者，镜像那一类
    // 信号会让「等你处理」的角标重数一遍（见下面那一组），而那与设备无关。
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/devices") return { devices };
      if (path === "/v1/agent-sessions/attention-count")
        return { needs_attention: 0, unread: 0 };
      throw new Error("unexpected: " + path);
    });
    renderShell();
    await screen.findByText("2/3");
    const deviceCalls = () =>
      mockedApi.mock.calls.filter(([p]) => String(p) === "/v1/devices").length;
    const before = deviceCalls();

    deliver(accountChannel.AccountChannelMirrorChanged);
    deliver(accountChannel.AccountChannelSyncVersion);

    expect(deviceCalls()).toBe(before);
  });
});

describe("侧栏「对话」角标（等你处理 + 未读）", () => {
  function serve(counts: unknown, unread = 0) {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/devices") return { devices };
      if (path === "/v1/agent-sessions/attention-count") {
        if (counts instanceof Error) throw counts;
        return { needs_attention: counts, unread };
      }
      throw new Error("unexpected: " + path);
    });
  }

  it("0 条时整个不画——那是「没人等你」，不是一个要显示的 0", async () => {
    serve(0);
    renderShell();

    await screen.findByText("2/3");
    const chat = screen.getByRole("link", { name: /^Chat/ });
    expect(within(chat).queryByText("0")).toBeNull();
  });

  it("取不到时也不画，不退成 0", async () => {
    // 一个编出来的 0 与「真的没人等你」长得一模一样，而它是错的。少说一句是安全的
    // 那一侧：用户会去点进对话页，而不是以为自己已经处理完了。
    serve(new Error("network down"));
    renderShell();

    await screen.findByText("2/3");
    const chat = screen.getByRole("link", { name: /^Chat/ });
    expect(within(chat).queryByText(/^\d+$/)).toBeNull();
  });

  it("镜像变了就重数一遍——一个停在旧值上的角标比没有角标更糟", async () => {
    serve(3);
    renderShell();
    const chat = screen.getByRole("link", { name: /^Chat/ });
    expect(await within(chat).findByText("3")).toBeTruthy();

    serve(1);
    deliver(accountChannel.AccountChannelMirrorChanged);

    expect(await within(chat).findByText("1")).toBeTruthy();
  });

  // 侧栏与筛选 chip 此前各问各的：侧栏数 waiting_for_input，chip 数
  // last_message_at>last_read_at，两个判据毫无关系。联调库上因此出现过侧栏说 1 条、
  // 点进去未读筛选是 0 条。现在两个数由同一条端点的同一批行交出来，角标是它们的和，
  // title 把它们分开说 —— 用户看得见 3 从哪来，而不是只看到一个对不上的数字。
  it("角标是两件事之和，title 把它们分开说", async () => {
    serve(2, 1);
    renderShell();

    const chat = screen.getByRole("link", { name: /^Chat/ });
    expect(await within(chat).findByText("3")).toBeTruthy();
    expect(
      within(chat).getByTitle("2 conversations need you · 1 unread"),
    ).toBeTruthy();
  });

  it("只有未读时 title 只说未读——不摆一句「0 条等你处理」", async () => {
    serve(0, 4);
    renderShell();

    const chat = screen.getByRole("link", { name: /^Chat/ });
    expect(await within(chat).findByText("4")).toBeTruthy();
    expect(within(chat).getByTitle("4 unread")).toBeTruthy();
  });

  it("设备上下线不触发重数——那是另一类信号，各订各的", async () => {
    serve(3);
    renderShell();
    await within(screen.getByRole("link", { name: /^Chat/ })).findByText("3");
    const before = mockedApi.mock.calls.filter(
      ([p]) => String(p) === "/v1/agent-sessions/attention-count",
    ).length;

    deliver(accountChannel.AccountChannelDevicePresence);

    await waitFor(() => expect(screen.getByText("2/3")).toBeTruthy());
    expect(
      mockedApi.mock.calls.filter(
        ([p]) => String(p) === "/v1/agent-sessions/attention-count",
      ).length,
    ).toBe(before);
  });
});

/**
 * 侧栏收起（本轮 UI/UX）。
 *
 * 224px 的带文字侧栏在 13" 笔电上要从对话页的转录里割走一整列——而那一列的信息
 * 在一次专注的会话里基本不变。收起之后它是一条 56px 的图标栏：**导航仍在**，
 * 只是文字让位。整条藏掉是另一回事，那会让「换个目的地」先要想起有个按钮。
 *
 * 三件事必须同时成立，缺一条这个开关就不该做：
 *   1. 收起后每个导航项仍是可达的链接，可访问名不变（图标不是名字）；
 *   2. 状态不因为收窄而消失——「等你处理」的角标照挂，设备的在线/全部收进
 *      悬浮说明，不是丢掉；
 *   3. 记得住：这是每次进控制台都要重来一遍的选择，不该只活一屏。
 *
 * 移动端没有这条侧栏（主导航是底部 TabBar），因此也不该有这个按钮。
 */
describe("桌面 SideNav 收起", () => {
  beforeEach(() => {
    localStorage.removeItem("agentre.console.navCollapsed");
  });
  afterEach(() => {
    localStorage.removeItem("agentre.console.navCollapsed");
  });

  function serveAll() {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/devices") return { devices };
      if (path === "/v1/agent-sessions/attention-count")
        return { needs_attention: 2, unread: 1 };
      throw new Error("unexpected: " + path);
    });
  }

  it("默认展开：224px，导航文案与设备 Meta 都在明面上", async () => {
    serveAll();
    renderShell();

    expect(screen.getByRole("navigation").className).toContain("w-[224px]");
    expect(screen.getByText("Console")).toBeTruthy();
    expect(await screen.findByText("2/3")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Collapse sidebar" }),
    ).toBeTruthy();
  });

  it("收起：侧栏收成 56px 图标栏，六个目的地一个不少", async () => {
    serveAll();
    renderShell();
    await screen.findByText("2/3");

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    const nav = screen.getByRole("navigation");
    expect(nav.className).toContain("w-[56px]");
    expect(nav.className).not.toContain("w-[224px]");
    // 图标不是名字：文字退成屏幕阅读器可见，链接的可访问名一个都没丢。
    for (const label of REAL_NAV) {
      expect(
        screen.getByRole("link", { name: new RegExp(`^${label}`) }),
      ).toBeTruthy();
    }
    // 品牌副标与设备 Meta 是「宽出来的」信息，收窄就该让位。
    expect(screen.queryByText("Console")).toBeNull();
    expect(screen.queryByText("2/3")).toBeNull();
    // 但在线/全部不是被丢掉，而是收进那一项的悬浮说明里。
    expect(
      screen.getByRole("link", { name: /^Devices/ }).getAttribute("title"),
    ).toBe("Devices 2/3");
    // 「等你处理」照挂：它是这条栏上唯一会变的东西，收窄不该把它变没。
    expect(
      within(screen.getByRole("link", { name: /^Chat/ })).getByText("3"),
    ).toBeTruthy();
  });

  it("再点一次展开回来", async () => {
    serveAll();
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));

    expect(screen.getByRole("navigation").className).toContain("w-[224px]");
    expect(screen.getByText("Console")).toBeTruthy();
  });

  it("记得住：下次进来还是收着的", async () => {
    serveAll();
    const first = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    first.unmount();

    renderShell();
    expect(screen.getByRole("navigation").className).toContain("w-[56px]");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  });
});

/**
 * 收放按钮自己的落点（本轮 UI/UX）。
 *
 * 此前它长在 brand 带里：展开时贴右端，收起时整块改成上下排，于是 brand 区从
 * 40px 变成 72px，整列导航跟着下移——收放两次，眼睛要重新找两次开关。收放是这条
 * 栏上**唯一**一个会改变自身位置的控件，而它恰恰是那个「要能马上找回来」的。
 *
 * 改成钉在右边框上的把手：它是 nav 自己的子元素，不进 brand 带，两态同一个落点。
 * 不配快捷键：⌘B 在浏览器里另有主人，在输入框里是加粗，为一条一天按不了两次的
 * 收放去抢它不值。
 */
describe("桌面 SideNav 收放按钮", () => {
  beforeEach(() => {
    localStorage.removeItem("agentre.console.navCollapsed");
  });
  afterEach(() => {
    localStorage.removeItem("agentre.console.navCollapsed");
  });

  it("两态同一个落点：开关是侧栏自己的子元素，不在 brand 带里", async () => {
    renderShell();

    const nav = screen.getByRole("navigation");
    expect(
      screen.getByRole("button", { name: "Collapse sidebar" }).parentElement,
    ).toBe(nav);
    // brand 带里一个按钮都没有了：收窄时它因此不必改排布。
    expect(
      within(nav.firstElementChild as HTMLElement).queryByRole("button"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(
      screen.getByRole("button", { name: "Expand sidebar" }).parentElement,
    ).toBe(nav);
    expect(
      within(nav.firstElementChild as HTMLElement).queryByRole("button"),
    ).toBeNull();
  });
});

describe("侧栏上的断线出路", () => {
  beforeEach(() => {
    localStorage.removeItem("agentre.console.navCollapsed");
  });
  afterEach(() => {
    localStorage.removeItem("agentre.console.navCollapsed");
  });

  /** 把一次状态变化送进共用的那条通道。 */
  function driveState(state: "connected" | "connecting" | "disconnected") {
    const call = mockedStartChannel.mock.calls.at(-1);
    expect(call).toBeDefined();
    act(() => call![0].onState?.(state));
  }

  it("断线：侧栏里出现一条说得出后果、点一下就重连的降级条", async () => {
    renderShell();
    driveState("disconnected");

    const escape = screen.getByRole("button", { name: /Reconnect/ });
    // 颜色不是唯一表达：那句「有多旧」就写在条上。
    expect(escape.textContent).toContain("Not connected · every 30s");

    // 重连 = 停掉旧的、起一条新的（见 hooks/use-account-channel 的 retry）。
    // 数增量而不是总数：那条通道是模块级单例，同一个文件里前面的用例也起过它。
    const before = mockedStartChannel.mock.calls.length;
    fireEvent.click(escape);
    expect(mockedStartChannel.mock.calls.length).toBe(before + 1);
  });

  it("收起成 56px 也还在：一枚警示按钮，名字里说得出是什么事", async () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    driveState("disconnected");

    const escape = screen.getByRole("button", { name: /Reconnect/ });
    expect(escape.getAttribute("aria-label")).toContain("Not connected");
  });

  it("稳态不多占一个像素：连着与正在连都没有这一块", async () => {
    renderShell();

    driveState("connected");
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();

    // 正在连是瞬态自愈：按一下只会打断它自己的退避节奏。
    driveState("connecting");
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
  });
});
