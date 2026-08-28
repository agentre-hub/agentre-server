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
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-secondary motion-reduce:animate-none" />
          <span className="min-w-0 flex-1">
            <span
              className="block h-3 animate-pulse rounded bg-secondary motion-reduce:animate-none"
              style={{ width: `${72 - i * 9}%` }}
            />
            <span className="mt-1.5 block h-2.5 w-2/5 animate-pulse rounded bg-secondary motion-reduce:animate-none" />
          </span>
        </div>
      ))}
    </div>
  );
}
