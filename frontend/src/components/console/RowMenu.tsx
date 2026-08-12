import { useEffect, useRef, useState } from "react";
import { MoreVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 行级菜单（设备行 / 会话行的「更多操作」共享语义）。
 *
 * 只放有真实后端的动作；危险项（如撤销）用 danger 标记换 destructive 色。
 * 菜单语义：触发按钮带 aria-haspopup/aria-expanded；打开后焦点进入菜单
 * （↑↓/Home/End 在项间移动），Escape 关闭并把焦点还给触发按钮，点击外部
 * 关闭。渲染位置按触发按钮的视口坐标固定定位（行可能处于滚动容器内）。
 */
export interface RowMenuItem {
  key: string;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

const MENU_WIDTH = 160;
const ITEM_HEIGHT = 32;
const MENU_PAD = 16;
const EDGE_GAP = 8;

export function RowMenu({
  label,
  items,
  align = "end",
  testId,
}: {
  /** 触发按钮的无障碍标签（行级「更多操作」）。 */
  label: string;
  items: RowMenuItem[];
  align?: "start" | "end";
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = items.length * ITEM_HEIGHT + MENU_PAD;
    const left = Math.min(
      Math.max(align === "end" ? rect.right - MENU_WIDTH : rect.left, EDGE_GAP),
      window.innerWidth - MENU_WIDTH - EDGE_GAP,
    );
    const top = Math.min(
      Math.max(rect.bottom + 4, EDGE_GAP),
      window.innerHeight - menuHeight - EDGE_GAP,
    );
    setPos({ top, left });
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // 打开时把焦点送进菜单（aria 菜单模式要求键盘/读屏用户不用再 Tab 一圈），
  // 并挂外部点击关闭。卸载时清掉监听。
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    const onDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        menuRef.current.contains(e.target)
      )
        return;
      if (
        triggerRef.current &&
        e.target instanceof Node &&
        triggerRef.current.contains(e.target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const itemEls = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    );
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (itemEls.length === 0) return;
    let idx = itemEls.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (idx === -1) idx = e.key === "ArrowDown" ? -1 : itemEls.length;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      itemEls[(idx + dir + itemEls.length) % itemEls.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      itemEls[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      itemEls[itemEls.length - 1]?.focus();
    }
  };

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={open ? () => setOpen(false) : openMenu}
        data-testid={testId ? `${testId}-trigger` : undefined}
      >
        <MoreVertical className="size-4" aria-hidden="true" />
      </Button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          data-testid={testId ? `${testId}-menu` : undefined}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-overlay"
          style={{ top: pos.top, left: pos.left }}
          onKeyDown={handleKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={cn(
                "flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                item.danger
                  ? "text-destructive hover:bg-destructive-soft"
                  : "text-popover-foreground",
              )}
              onClick={() => {
                item.onSelect();
                close();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
