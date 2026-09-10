/**
 * 弹窗规范的构件（规格 2026-08-20「弹窗规范」，决策 11）。
 *
 * 现在的 `ui/dialog.tsx` 是写死的 `max-w-[520px]` 居中浮卡 + `max-h-[70vh]` 内滚，
 * 头脚与 body 同在一个 grid 里一起滚，窄屏没有任何断点分支，写失败的反馈落在页面级
 * 而不是弹窗里。这一批构件逐条对上那几个毛病：
 *
 *   - 三档尺寸（sm 420 / md 560 / lg 760），由用途决定，不由调用点临时塞 className；
 *   - <640px 换成贴底 sheet：**基础样式就是 sheet，`sm:` 才把它变回浮卡**——反过来
 *     写（浮卡基础 + `max-sm:` 覆盖）在窄屏上会先画一帧浮卡；
 *   - 头与脚固定，只有 body 滚；
 *   - 整窗级错误摆在脚部、与按钮同一行；字段级错误归调用方摆在字段下面；
 *   - 主按钮自带 busy，**busy 期间 Esc 与点遮罩都不关窗**；
 *   - 危险确认是一种形态；
 *   - 即时保存的弹窗保存态在头部，脚部因此没有「保存」。
 *
 * 本轮只新增构件、不迁移现有三处弹窗（决策 12）。
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DialogShell,
  DialogShellBody,
  DialogShellFooter,
  DialogShellHeader,
  DialogShellSubmit,
} from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";

/**
 * 外壳的文案归包所有（组件走 `useUiTranslation()` = `agentreUi` namespace），
 * 所以断言也去问包，而不是问本站的 `translation`。
 *
 * 这不是把断言放宽：本站曾有一份逐字节相同的 `ui/dialog-shell.tsx` 副本，那时
 * 两个 namespace 恰好都有同名 key，问谁都对。副本退役之后只有包那份还算数。
 *
 * 已知的一处不一致：包的 `common.saving` 是「保存中...」（三个点），而包里另外
 * 23 条文案与本站全部 22 条用的都是真省略号「…」。那是包里的笔误，该在包里修；
 * 修好之后这里不用动，因为问的就是它。
 */
const uiText = (key: string) => i18n.t(key, { ns: "agentreUi" });

function renderShell(
  props: Partial<React.ComponentProps<typeof DialogShell>> = {},
  inner?: React.ReactNode,
) {
  const onOpenChange = vi.fn();
  render(
    <DialogShell open onOpenChange={onOpenChange} {...props}>
      {inner ?? (
        <>
          <DialogShellHeader title="标题" />
          <DialogShellBody>正文</DialogShellBody>
          <DialogShellFooter>
            <button type="button">确定</button>
          </DialogShellFooter>
        </>
      )}
    </DialogShell>,
  );
  return { onOpenChange };
}

function content() {
  return document.querySelector('[data-slot="dialog-shell-content"]')!;
}

describe("弹窗外壳", () => {
  it("三档尺寸各自给出自己的宽度上限，且都只在 sm 及以上生效", () => {
    const widths: Record<string, string> = {
      sm: "sm:max-w-[420px]",
      md: "sm:max-w-[560px]",
      lg: "sm:max-w-[760px]",
    };
    for (const [size, cls] of Object.entries(widths)) {
      const { unmount } = render(
        <DialogShell
          open
          onOpenChange={vi.fn()}
          size={size as "sm" | "md" | "lg"}
        >
          <DialogShellBody>正文</DialogShellBody>
        </DialogShell>,
      );
      expect(content().className).toContain(cls);
      unmount();
    }
  });

  it("窄屏是基础形态：贴底满宽上圆角，sm 及以上才变回居中浮卡", () => {
    renderShell();
    const cls = content().className;
    // 基础（窄屏）：贴底、满宽、上圆角。
    expect(cls).toContain("inset-x-0");
    expect(cls).toContain("bottom-0");
    expect(cls).toContain("rounded-t-2xl");
    // sm 及以上：居中浮卡。断点看的是**视口**宽度，因此这一档必须写成 sm: 覆盖，
    // 而不是靠容器宽度模拟。
    expect(cls).toContain("sm:left-1/2");
    expect(cls).toContain("sm:top-1/2");
    expect(cls).toContain("sm:rounded-xl");
    expect(cls).toContain("sm:bottom-auto");
  });

  it("窄屏那一档有可见的拖动条，宽屏没有", () => {
    renderShell();
    const grip = document.querySelector('[data-slot="dialog-shell-grip"]');
    expect(grip).not.toBeNull();
    expect(grip!.className).toContain("sm:hidden");
  });

  it("头与脚固定，只有 body 滚", () => {
    renderShell();
    const header = document.querySelector('[data-slot="dialog-shell-header"]')!;
    const body = document.querySelector('[data-slot="dialog-shell-body"]')!;
    const footer = document.querySelector('[data-slot="dialog-shell-footer"]')!;

    expect(header.className).toContain("shrink-0");
    expect(footer.className).toContain("shrink-0");
    expect(body.className).toContain("overflow-y-auto");
    // min-h-0 少了 flex 子项不会缩，头脚会被正文顶出去。
    expect(body.className).toContain("min-h-0");
    expect(body.className).toContain("flex-1");
    expect(header.className).not.toContain("overflow-y-auto");
    expect(footer.className).not.toContain("overflow-y-auto");
  });

  it("整窗级错误渲染在脚部、与按钮同一行，并以 alert 播报", () => {
    render(
      <DialogShell open onOpenChange={vi.fn()}>
        <DialogShellBody>正文</DialogShellBody>
        <DialogShellFooter error="这个名字已经有人用了">
          <button type="button">确定</button>
        </DialogShellFooter>
      </DialogShell>,
    );
    const footer = document.querySelector(
      '[data-slot="dialog-shell-footer"]',
    ) as HTMLElement;
    const alert = within(footer).getByRole("alert");
    expect(alert.textContent).toContain("这个名字已经有人用了");
    expect(within(footer).getByRole("button", { name: "确定" })).toBeTruthy();
  });

  it("有错误时错误压过脚部左侧原本摆的东西", () => {
    render(
      <DialogShell open onOpenChange={vi.fn()}>
        <DialogShellBody>正文</DialogShellBody>
        <DialogShellFooter error="出错了" left={<span>已选 /srv/x</span>}>
          <button type="button">确定</button>
        </DialogShellFooter>
      </DialogShell>,
    );
    expect(screen.getByRole("alert").textContent).toContain("出错了");
    expect(screen.queryByText("已选 /srv/x")).toBeNull();
  });

  it("不忙时 Esc 关窗", () => {
    const { onOpenChange } = renderShell();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("busy 期间 Esc 不关窗——写请求正在飞，关掉只会让人以为没提交", () => {
    const { onOpenChange } = renderShell({ busy: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  // 「busy 期间点遮罩不关窗」**这里测不了**，因此这里不摆一条永远绿的测试。
  //
  // Radix 的 DismissableLayer 靠真实指针事件判「点在外面」，jsdom 里连不忙时点
  // 遮罩都不会关窗（试过：先断言不忙时必须关，那一半就红）。照样写一条只断言
  // 「busy 时没关」的用例，它测不出是「拦住了」还是「压根没触发」——两种情况都绿。
  //
  // 拦截与 Esc 那条走的是同一个 blockWhileBusy（onPointerDownOutside /
  // onInteractOutside），Esc 那半在上面测到了；遮罩那半留给收尾时的真实运行观察。

  it("busy 期间头部的关闭按钮也按不动", () => {
    const onClose = vi.fn();
    renderShell(
      { busy: true },
      <>
        <DialogShellHeader title="标题" onClose={onClose} busy />
        <DialogShellBody>正文</DialogShellBody>
      </>,
    );
    const close = screen.getByRole("button", {
      name: uiText("common.close"),
    }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("危险确认是一种形态：头部走 destructive，后果不写进标题", () => {
    renderShell(
      { danger: true },
      <>
        <DialogShellHeader title="删除项目？" danger />
        <DialogShellBody>这个项目的子项目也会被删除。</DialogShellBody>
      </>,
    );
    const header = document.querySelector('[data-slot="dialog-shell-header"]')!;
    expect(header.className).toContain("destructive");
    expect(content().className).toContain("destructive");
    // 标题只有一句话，后果在正文里。
    expect(screen.getByText("删除项目？")).toBeTruthy();
    expect(screen.getByText("这个项目的子项目也会被删除。")).toBeTruthy();
  });

  it("即时保存的弹窗把保存态摆在头部，脚部因此没有「保存」", () => {
    const { rerender } = render(
      <DialogShell open onOpenChange={vi.fn()}>
        <DialogShellHeader title="项目设置" saveState="saving" />
        <DialogShellBody>正文</DialogShellBody>
        <DialogShellFooter>
          <button type="button">完成</button>
        </DialogShellFooter>
      </DialogShell>,
    );
    const header = () =>
      document.querySelector(
        '[data-slot="dialog-shell-header"]',
      ) as HTMLElement;
    expect(within(header()).getByText(uiText("common.saving"))).toBeTruthy();

    rerender(
      <DialogShell open onOpenChange={vi.fn()}>
        <DialogShellHeader title="项目设置" saveState="saved" />
        <DialogShellBody>正文</DialogShellBody>
        <DialogShellFooter>
          <button type="button">完成</button>
        </DialogShellFooter>
      </DialogShell>,
    );
    expect(within(header()).getByText(uiText("common.saved"))).toBeTruthy();

    rerender(
      <DialogShell open onOpenChange={vi.fn()}>
        <DialogShellHeader title="项目设置" saveState="error" />
        <DialogShellBody>正文</DialogShellBody>
        <DialogShellFooter>
          <button type="button">完成</button>
        </DialogShellFooter>
      </DialogShell>,
    );
    const failed = within(header()).getByText(uiText("common.saveFailed"));
    expect(failed).toBeTruthy();
    expect(failed.className).toContain("destructive");
  });

  it("saveState 为 idle 时头部不摆任何保存字样", () => {
    renderShell(
      {},
      <>
        <DialogShellHeader title="项目设置" saveState="idle" />
        <DialogShellBody>正文</DialogShellBody>
      </>,
    );
    expect(screen.queryByText(uiText("common.saving"))).toBeNull();
    expect(screen.queryByText(uiText("common.saved"))).toBeNull();
  });
});

describe("主按钮自带 busy", () => {
  it("busy 时转圈、禁用、按不动", () => {
    const onClick = vi.fn();
    render(
      <DialogShellSubmit busy onClick={onClick}>
        创建
      </DialogShellSubmit>,
    );
    const button = screen.getByRole("button", {
      name: /创建/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("不忙时照常按得动，也没有转圈", () => {
    const onClick = vi.fn();
    render(<DialogShellSubmit onClick={onClick}>创建</DialogShellSubmit>);
    const button = screen.getByRole("button", {
      name: "创建",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("危险动作用 destructive，与普通主按钮分得开", () => {
    render(
      <DialogShellSubmit variant="destructive">删除项目</DialogShellSubmit>,
    );
    expect(
      screen.getByRole("button", { name: "删除项目" }).className,
    ).toContain("destructive");
  });
});
