/**
 * 用户菜单（任务 7，规格「用户菜单与 /account」菜单段）：桌面侧栏与移动 TopBar
 * 共用同一个下拉菜单触发器，可键盘打开/关闭：账号信息只读，另有「账号与安全」
 * （去 /account）、「设置」（去 /settings）与「登出」（真调用
 * POST /v1/auth/logout 并落地登录页，而不是一个死按钮）。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserMenu } from "@/components/UserMenu";
import { api } from "@/lib/api";
import i18n from "@/i18n";

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

function renderMenu(compact = false) {
  return render(
    <MemoryRouter>
      <UserMenu me={me} compact={compact} />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockedApi.mockResolvedValue(undefined);
});

describe("UserMenu", () => {
  it("键盘 Enter 打开菜单，看到只读账号信息与三个可操作项", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Account menu" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    const menu = screen.getByRole("menu");
    // 只读账号信息：显示名 + 邮箱都出现在**菜单里**，但不是菜单项。
    // 原来写的是 `getAllByText(...).length > 0`——getAllByText 找不到时自己就抛，
    // 所以那个 expect 永远不会红，「在菜单里」和「不是菜单项」两件事都没被验到。
    expect(within(menu).getByText("Dev User")).toBeTruthy();
    expect(within(menu).getByText("dev@agentre.dev")).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Account & security/i }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Settings/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Sign out/i })).toBeTruthy();
    // 恰好三项：账号信息保持只读，设置与账号页都是可达的真实目的地。
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("Escape 关闭已打开的菜单", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Account menu" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("紧凑形态（移动 TopBar）：触发器名字在窄屏隐藏、不显示邮箱；菜单内容不变", () => {
    renderMenu(true);
    expect(screen.getByText("D")).toBeTruthy(); // 首字母头像
    // 名字沿用原 mobileAccount 的做法：DOM 里在，但 hidden + sm:inline——
    // 390 宽手机上不可见，与 mockups/shots/mobile-menu.png 一致；不断言
    // DOM 缺席（jsdom 不算 CSS），断言的是这道响应式类本身还在。
    const name = screen.getByText("Dev User");
    expect(name.className).toContain("hidden");
    expect(name.className).toContain("sm:inline");
    expect(screen.queryByText("dev@agentre.dev")).toBeNull();

    fireEvent.keyDown(screen.getByRole("button", { name: "Account menu" }), {
      key: "Enter",
    });
    expect(
      screen.getByRole("menuitem", { name: /Account & security/i }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Settings/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Sign out/i })).toBeTruthy();
    // 打开后只读账号信息里邮箱仍然出现（不受紧凑形态影响）。
    expect(screen.getByText("dev@agentre.dev")).toBeTruthy();
  });

  it("「账号与安全」与「设置」都是指向真实页面的链接", () => {
    renderMenu();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Account menu" }),
      { button: 0 },
    );
    expect(
      screen
        .getByRole("menuitem", { name: /Account & security/i })
        .getAttribute("href"),
    ).toBe("/account");
    expect(
      screen.getByRole("menuitem", { name: /Settings/i }).getAttribute("href"),
    ).toBe("/settings");
  });

  it("选择「登出」真的调用 POST /v1/auth/logout，随后落地到 /login", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });

    renderMenu();
    fireEvent.keyDown(screen.getByRole("button", { name: "Account menu" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/i }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith("/v1/auth/logout", {
        method: "POST",
      }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });
});
