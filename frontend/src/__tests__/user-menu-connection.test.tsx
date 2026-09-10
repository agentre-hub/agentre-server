/**
 * 账号块上的实时连接状态（头像上一颗痣 + 菜单里那一段）。
 *
 * 报的是**账号级那条中继连接**（一个标签页一条，见 `@/lib/relayClientPool`）此刻
 * 的状态，也就是「这一屏看到的东西是不是实时的」。它挂在账号块上而不是自成一行：
 * 收起 56px 与移动 TopBar 里账号块都还在，那颗痣因此白拿了两个形态。
 *
 * 断言的是这几条：
 *  - 三态第二行都是邮箱：状态由痣与菜单里那一段说，不跟账号身份抢那一行。
 *    断线时的出路自己占一块，在侧栏上（AppShell 的 ConnectionEscape）；
 *  - 颜色不是唯一表达：降级时有可见文字，痣本身对读屏隐藏，另有 sr-only 播报；
 *  - 不会自愈的那一态给得出出路，且出路只在那一态出现；
 *  - 紧凑形态（移动 TopBar）没有第二行，痣的白环跟着所在的面走。
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UserMenu } from "@/components/UserMenu";
import * as accountChannel from "@/lib/accountChannel";
import type { AccountChannelState } from "@/lib/accountChannel";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn(async () => undefined) };
});

const mockedStart = vi.mocked(accountChannel.startAccountChannel);

const me = {
  user_id: 1,
  email: "dev@agentre.dev",
  display_name: "Dev User",
  avatar_url: "",
  github_login: "dev",
  csrf_token: "t",
};

/** 把一次状态变化送进共用的那条通道。 */
function drive(state: AccountChannelState): void {
  const call = mockedStart.mock.calls.at(-1);
  expect(call).toBeDefined();
  // 状态从通道那一侧来（不是某个渲染里的事件），所以得自己包 act 让它冲刷。
  act(() => call![0].onState?.(state));
}

function renderMenu(compact = false) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <UserMenu me={me} compact={compact} />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function pip(): HTMLElement {
  return screen.getByTestId("connection-pip");
}

function openMenu(): HTMLElement {
  fireEvent.keyDown(screen.getByRole("button", { name: "Account menu" }), {
    key: "Enter",
  });
  return screen.getByRole("menu");
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedStart.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("账号块上的实时连接状态", () => {
  it("连着的时候一个字都不多说：第二行还是邮箱，痣是绿的", () => {
    renderMenu();
    drive("connected");

    expect(screen.getByText("dev@agentre.dev")).toBeTruthy();
    expect(screen.queryByText(/every 30s/)).toBeNull();
    expect(pip().className).toContain("bg-status-running");
  });

  it("正在重连不占那一行：瞬态自愈只改痣的颜色，邮箱留着", () => {
    renderMenu();
    drive("connecting");

    // 每次进页面都要经过这一段，几百毫秒后它自己就好了。为它把邮箱顶掉，等于
    // 每次加载都闪一下——与详情页那枚芯片同一条判断（SessionConnectionIndicator
    // 的 A 档：瞬态自愈不占内容区）。
    expect(screen.getByText("dev@agentre.dev")).toBeTruthy();
    expect(screen.queryByText(/every 30s/)).toBeNull();
    expect(pip().className).toContain("bg-status-waiting");
    expect(pip().className).toContain("animate-pulse");
  });

  it("断线也不动那一行：邮箱留着，「有多旧」由侧栏那条降级条去说", () => {
    renderMenu();
    drive("disconnected");

    // 邮箱曾经在这一态被顶掉，换成一行不可点的灰字——点下去只是把菜单打开。
    // 出路现在自己占一块（AppShell 的 ConnectionEscape），这一行就没有理由再让位：
    // 「我登的是哪个账号」与「我看到的东西有多旧」不必抢同一行。
    expect(screen.getByText("dev@agentre.dev")).toBeTruthy();
    expect(screen.queryByText("Not connected · every 30s")).toBeNull();
    // 痣仍然照实说：三态都出（正向确认也是一句话）。
    expect(pip().className).toContain("bg-status-idle");
  });

  it("痣不是唯一表达：它对读屏隐藏，状态另有 sr-only 播报", () => {
    renderMenu();
    drive("disconnected");

    // 一个读屏念得到、却又点不着的彩色圆点比没有更糟；状态由播报区说。
    expect(pip().getAttribute("aria-hidden")).toBe("true");
    const announcer = screen.getByRole("status");
    expect(announcer.className).toContain("sr-only");
    expect(announcer.textContent).toBe("Not connected");
  });

  it("菜单里有那一段：状态 + 一句后果", () => {
    renderMenu();
    drive("connected");

    const menu = openMenu();
    expect(within(menu).getByText("Live")).toBeTruthy();
    expect(
      within(menu).getByText("Changes show up here as they happen"),
    ).toBeTruthy();
    // 状态是只读的一段，不是菜单项：不可聚焦、不可点。
    expect(within(menu).queryByRole("menuitem", { name: /Live/ })).toBeNull();
  });

  it("不会自愈的那一态给得出出路，点它就地重开这条通道", () => {
    renderMenu();
    drive("disconnected");

    const item = within(openMenu()).getByRole("menuitem", {
      name: /Reconnect live updates/,
    });
    fireEvent.click(item);

    // 重开 = 停掉旧的、起一条新的（见 hooks/use-account-channel 的 retry）。
    expect(mockedStart).toHaveBeenCalledTimes(2);
  });

  it("连着的时候不给出路：没有可修的东西就不该有那一项", () => {
    renderMenu();
    drive("connected");

    expect(
      within(openMenu()).queryByRole("menuitem", {
        name: /Reconnect live updates/,
      }),
    ).toBeNull();
  });

  it("正在重连也不给出路：它自己会回来，按一下只会打断退避", () => {
    renderMenu();
    drive("connecting");

    expect(
      within(openMenu()).queryByRole("menuitem", {
        name: /Reconnect live updates/,
      }),
    ).toBeNull();
  });

  it("紧凑形态（移动 TopBar）只有痣，白环跟着 card 那个面", () => {
    renderMenu(true);
    drive("disconnected");

    // 紧凑形态本来就没有第二行（只有名字，且 <sm 时藏起来），所以痣是唯一的记号，
    // 文字与出路都在菜单里。
    expect(screen.queryByText(/every 30s/)).toBeNull();
    expect(pip().className).toContain("ring-card");
    expect(pip().className).not.toContain("ring-sidebar");
  });

  it("侧栏形态的白环跟着 sidebar 那个面：环色错了痣就成了一颗黑点", () => {
    renderMenu();
    drive("connected");

    expect(pip().className).toContain("ring-sidebar");
    // 环宽也得留住：tailwind-merge 把 ring-2 和 ring-<color> 归在不同组，
    // 合并之后两个都在——少了宽度那颗痣就没有环，贴在头像边上糊成一团。
    expect(pip().className).toContain("ring-2");
  });
});
