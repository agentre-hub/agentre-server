import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@agentre-hub/agentre-ui";

/**
 * 索引栏内的空态——与页面级 `EmptyState` 是两件事。
 *
 * `EmptyState` 说的是「这一整块面板没有内容」（62px 图标圈 + 18px 粗标题），
 * 用在总览的统计卡、账号的通行密钥这些**主体区**上。索引栏里的空不是同一件事：
 * 它多半是用户自己刚按下的一个筛选造成的，是暂态，占的又是一条窄栏——同样的
 * 分量摆进去就成了一块喧宾夺主的大图形。
 *
 * 形取自组织面本来就有的「还没有任何部门」那张虚线卡片（这一形态在窄栏里已经
 * 验证过）：顶端对齐、虚线描边、图标 + 标题 + 正文 + 一条回程。**不**垂直居中
 * ——索引栏可以很长，把一句话吊在正中会让上面那排 chips 与这句话之间断开，读者
 * 得先找一遍才知道系统在跟自己说话。
 *
 * 三条内容各有分工，缺一条就退化回原来的样子：
 *   - 标题说**什么**空了（点名那一档／那次搜索，用界面上原样的词）；
 *   - 正文说**外面还有多少**，读者据此立刻知道东西没丢；
 *   - 动作给一条回程。接不住那个动作（宿主没给回调）就不摆按钮：一个按下去
 *     什么都不发生的按钮比没有按钮更坏。
 */
export function InlineEmpty({
  icon: Icon,
  title,
  body,
  action,
  testId,
  slot,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
  testId?: string;
  slot?: string;
  className?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-slot={slot}
      className={cn(
        "m-2.5 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center",
        className,
      )}
    >
      {Icon ? (
        <Icon
          aria-hidden="true"
          strokeWidth={1.6}
          className="size-6 text-decorative-foreground"
        />
      ) : null}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {body ? (
        <p className="text-2xs leading-5 text-muted-foreground">{body}</p>
      ) : null}
      {action ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action}
        </div>
      ) : null}
    </div>
  );
}
