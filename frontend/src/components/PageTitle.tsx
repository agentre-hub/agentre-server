import type { ReactNode } from "react";

import { cn } from "@agentre-hub/agentre-ui";

/**
 * 页面的一级标题。
 *
 * 字号是设计系统里的一档，不是每个页面自己的选择。这串 class 此前在 9 个页面里
 * 各写一遍（认证流的六屏、404、即将上线、设置页），改一档要改 9 处，漏掉的那几页
 * 从此和别人不一样，而且没人会发现——page-title.test.tsx 盯着不许有第二处。
 *
 * 留 className 是为了外边距这类**位置**上的差异（它属于摆它的那个页面），
 * 字号与颜色不该从这里覆盖。
 */
export default function PageTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1 className={cn("text-2xl font-semibold text-foreground", className)}>
      {children}
    </h1>
  );
}
