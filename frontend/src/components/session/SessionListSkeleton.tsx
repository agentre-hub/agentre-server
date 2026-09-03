import { Skeleton } from "@agentre-hub/agentre-ui";

/**
 * 会话列表首屏的骨架（规格 2026-08-21 决策 12）。
 *
 * 它取代的是三处各一行的 `common.loading`「加载中…」——桌面左列、桌面右栏、
 * 移动端全宽。那三行字有两个问题：同一件事说三遍，以及**不占位置**，行落地时
 * 整列往下跳一次。骨架两样都解决。
 *
 * 对读屏隐藏：正在取这件事由容器上的 `aria-busy` 说，几条灰条不必再念一遍。
 */
const ROWS = [0.95, 0.75, 0.55, 0.35];

export default function SessionListSkeleton({
  rows = ROWS.length,
}: {
  rows?: number;
}) {
  return (
    <div
      data-testid="session-list-skeleton"
      aria-hidden="true"
      className="flex flex-col gap-0.5"
    >
      {ROWS.slice(0, rows).map((opacity, i) => (
        <div
          key={i}
          style={{ opacity }}
          className="flex items-center gap-2 px-2 py-2"
        >
          <Skeleton className="size-2 shrink-0 rounded-full" />
          <span className="min-w-0 flex-1">
            <Skeleton
              className="h-3 rounded"
              style={{ width: `${72 - i * 9}%` }}
            />
            <Skeleton className="mt-1.5 h-2.5 w-2/5 rounded" />
          </span>
        </div>
      ))}
    </div>
  );
}
