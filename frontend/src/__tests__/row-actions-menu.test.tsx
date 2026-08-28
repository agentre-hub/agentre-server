/**
 * 行级「更多操作」菜单（规格 2026-08-22 E 段）。
 *
 * 此前本站有**两套**菜单实现：项目组头那份用共享包的 Radix `DropdownMenu`，而
 * `components/console/RowMenu.tsx` 自己用 `getBoundingClientRect()` 算坐标 +
 * `position: fixed` 摆位，自己实现 ↑↓ / Home / End / Escape / 外部点击。手写那份
 * **没有**最大高度、没有内部滚动、没有碰撞翻转——菜单一长就越出视口。
 *
 * 这里钉的是**结构契约**：真实调用点开出来的必须是包那份视口感知的 content，
 * 而不是一个手写的 `<div role="menu">`。为什么不直接断言「它待在视口里」——
 * jsdom 不算布局（`docs/testing.md`「The jsdom environment」），在这里量位置量到的
 * 全是 0。真实的贴边翻转归运行时验证。
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OrgDetailHeader } from "@/pages/org/OrgDetailHeader";
// 副作用 import：头部要 t() 才画得出触发按钮的可访问名，实例由这个模块建。
import "@/i18n";

/**
 * 把菜单打开，**不假定它是哪一份实现**：Radix 开在 pointerdown 上，手写那份开在
 * click 上。两下都发，好让这组断言的红点精确落在「开出来的是什么」，而不是
 * 「我按对了没有」——夹具不匹配造成的红不算 RED。
 */
function openMenu() {
  const trigger = screen.getByTestId("org-detail-menu-trigger");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  if (!screen.queryByRole("menu")) fireEvent.click(trigger);
}

function renderHeader(
  over: { onOpen?: () => void; onDelete?: () => void } = {},
) {
  const onOpen = over.onOpen ?? vi.fn();
  const onDelete = over.onDelete ?? vi.fn();
  render(
    <OrgDetailHeader
      avatar={<span data-testid="avatar" />}
      title="研发部"
      save={{ state: { kind: "idle" }, run: vi.fn(), retry: vi.fn() }}
      menuItems={[
        { key: "open", label: "打开", onSelect: onOpen },
        { key: "delete", label: "删除", danger: true, onSelect: onDelete },
      ]}
      onClose={vi.fn()}
    />,
  );
  return { onOpen, onDelete };
}

describe("行级菜单用共享包那一份", () => {
  it("开出来的是包的 dropdown-menu content，带最大高度与内部滚动", () => {
    renderHeader();
    openMenu();
    const menu = screen.getByRole("menu");
    // 手写那份是个裸 div，没有这个记号。
    expect(menu.dataset.slot).toBe("dropdown-menu-content");
    // 视口感知的两件：可用高度封顶 + 超出时自己滚。
    expect(menu.className).toContain(
      "max-h-(--radix-dropdown-menu-content-available-height)",
    );
    expect(menu.className).toContain("overflow-y-auto");
  });

  it("危险项走包的 destructive variant，不是调用点自己上的色", () => {
    renderHeader();
    openMenu();
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((el) => el.textContent?.trim())).toEqual(["打开", "删除"]);
    expect(items[0].dataset.variant).toBe("default");
    expect(items[1].dataset.variant).toBe("destructive");
  });

  it("触发按钮带 aria-haspopup/aria-expanded，未开时没有菜单", () => {
    renderHeader();
    const trigger = screen.getByTestId("org-detail-menu-trigger");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("选一项触发它的 onSelect 并关掉菜单", async () => {
    const { onOpen, onDelete } = renderHeader();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Escape 关掉菜单并把焦点还给触发按钮", async () => {
    renderHeader();
    openMenu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // 焦点是**关闭之后**才还回去的（Radix 的 onCloseAutoFocus），所以要等一等；
    // 同步断言只能证明「这一帧还没还」，证明不了「不会还」。
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("org-detail-menu-trigger"),
      ),
    );
  });
});
