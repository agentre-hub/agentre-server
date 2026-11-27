/**
 * 手机页头：所有自己画页头的手机页（ownHeader）与外壳顶栏共用这一份。
 *
 * 此前每页各写一条：对话页 ← + •••、56px；Agent 详情 ‹ + ⋮、56px；设备详情的页头缩在
 * 主区内边距里、⋮ 只有 32px；看板 44px 没有底色。只有外壳顶栏（组织、账号）是 52px
 * 外框色通栏——它就是基准，这里照它的尺寸收成一处：
 *
 * - 52px，加 `env(safe-area-inset-top)` 往下推（无刘海或 default 状态栏时为 0）；
 * - 通栏外框色底（`bg-chrome`），放在滚动区外面（见 `PhonePage`）；
 * - 左右按钮 44×44，图标 20px；返回是 ‹（ChevronLeft），更多是 •••（Ellipsis）；
 * - 副行只在有内容时占位：副行组件渲染出空（保存态 idle）时那一格 `empty:hidden`
 *   塌掉，标题回到垂直正中，而不是贴在页头上沿。
 *
 * 顶部模糊那条不变量（AppShell 根 `fixed inset-x-0 top-0 h-dvh`）由外壳担：页头落在
 * 根里，顶边命中链上就有那个全宽 fixed 容器，这里不用再自己 sticky。
 */
import { forwardRef, type ComponentProps, type ReactNode } from "react";

import { cn } from "@agentre-hub/agentre-ui";

/** 页头左右两端的 44px 图标键（☰、‹、＋、•••）。MobileNavButton 也用这一份。 */
export const PHONE_HEADER_BUTTON_CLASS =
  "relative flex size-11 shrink-0 items-center justify-center rounded-md text-foreground outline-none hover:bg-rail-accent focus-visible:focus-outline";

export const PhoneHeaderButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<"button"> & {
    /** 贴左 / 贴右的那一颗抵掉页头 16px 内边距的一半，图标与正文左沿对齐。 */
    edge?: "start" | "end";
  }
>(function PhoneHeaderButton({ edge, className, type, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        PHONE_HEADER_BUTTON_CLASS,
        edge === "start" && "-ml-2",
        edge === "end" && "-mr-2",
        className,
      )}
      {...rest}
    />
  );
});

export function PhonePageHeader({
  testId,
  leading,
  title,
  titleAs = "h1",
  subtitle,
  subtitleTestId,
  trailing,
  className,
}: {
  testId?: string;
  leading?: ReactNode;
  title?: ReactNode;
  /** 外壳顶栏用 span（页面正文可能自己有 h1）；标题是控件（看板的项目范围）时用 div。 */
  titleAs?: "h1" | "span" | "div";
  subtitle?: ReactNode;
  subtitleTestId?: string;
  trailing?: ReactNode;
  /** 个别页面需要叠加的类名。 */
  className?: string;
}) {
  const Title = titleAs;
  return (
    <header
      data-testid={testId}
      data-slot="phone-page-header"
      className={cn(
        "flex h-[calc(52px_+_env(safe-area-inset-top,0px))] shrink-0 items-center gap-3 bg-chrome px-4 pt-[env(safe-area-inset-top,0px)]",
        className,
      )}
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {title != null && title !== false ? (
          <Title className="truncate text-prose font-bold text-foreground">
            {title}
          </Title>
        ) : null}
        {subtitle != null && subtitle !== false ? (
          <div
            data-testid={subtitleTestId}
            data-slot="phone-page-header-subtitle"
            className="flex min-w-0 items-center truncate text-xs text-muted-foreground empty:hidden"
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {trailing}
    </header>
  );
}

/**
 * 手机整页：页头钉在上面不随内容滚，正文自己滚。配 `AppShell flush ownHeader` 用——
 * 非 flush 的主区自带 `px-4 py-5` 与滚动，页头落进去就成了一块内缩的灰框、跟着内容
 * 滚走（设置页第 5 项、设备页的问题）。
 */
export function PhonePage({
  header,
  strip,
  children,
  bodyClassName,
  testId,
}: {
  header: ReactNode;
  /**
   * 页头正下方的一条细带（「网络不稳定」，`IdentityUnstableStrip`），在滚动区外。宿主页
   * 画了它就要给 `AppShell` 传 `ownStrip`，否则壳会再压一条在内容顶上。
   */
  strip?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex h-full min-h-0 min-w-0 flex-col">
      {header}
      {strip}
      <div
        data-slot="phone-page-body"
        className={cn(
          "relative min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pt-2 pb-5",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
