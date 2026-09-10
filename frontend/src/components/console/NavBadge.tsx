import { cn } from "@agentre-hub/agentre-ui";

/**
 * 导航项上「有多少条需要你」的角标。桌面侧栏（ConsoleNavItem）与移动底栏
 * （MobileTabBar）共用这一个 —— 两处画同一个数，形状不该有两份。
 *
 * 三条规矩，全部关于**诚实**：
 *
 *   - `>0` 才画。0 是「都处理完了」，摆一个 0 出来只会让这条栏一直挂着东西。
 *   - `null` / `undefined` = 还没取到 / 取不到，同样不画。一个停在旧值上、或者
 *     编出来的 0，比没有数字更糟：前者让人以为没有新的东西在等自己，后者让人
 *     以为已经处理完了。
 *   - 数字只有一个位，但它底下是两件事（等你处理 / 未读）。拆开的那句话落在
 *     `label` 上——`title` 给鼠标，`sr-only` 给读屏。少了它，用户看得见 3，
 *     却无从知道这 3 是什么。
 */
export function NavBadge({
  count,
  label,
  className,
}: {
  count?: number | null;
  label?: string | null;
  className?: string;
}) {
  if (typeof count !== "number" || count <= 0) return null;
  return (
    <span
      title={label ?? undefined}
      className={cn(
        "flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full",
        "bg-status-waiting px-1.5 text-3xs font-semibold text-status-waiting-foreground",
        className,
      )}
    >
      {label ? (
        <>
          {/* 有说明时数字对读屏隐藏，否则可访问名会念成「3 3 条未读」。 */}
          <span aria-hidden="true">{count}</span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        // 没有说明时数字自己就是全部信息，直接落在这一层上，照常念。
        count
      )}
    </span>
  );
}
