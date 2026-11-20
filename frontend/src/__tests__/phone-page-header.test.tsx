/**
 * 手机页头（2026-11-20 手机 UI/UX 第 14 项）：所有自己画页头的手机页共用一份——
 * 52px（+ 顶部安全区）、通栏、外框色底；‹ 与 ••• 都是 44×44；副行只在有内容时占位，
 * 否则标题垂直居中（Agent 详情空保存态把标题顶到上沿的那个问题）。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PhoneHeaderButton,
  PhonePage,
  PhonePageHeader,
} from "@/components/PhonePageHeader";

describe("PhonePageHeader", () => {
  it("52px + 顶部安全区、通栏外框色底", () => {
    render(<PhonePageHeader testId="h" title="研发部" />);
    const header = screen.getByTestId("h");
    expect(header.tagName).toBe("HEADER");
    expect(header.className).toContain(
      "h-[calc(52px_+_env(safe-area-inset-top,0px))]",
    );
    expect(header.className).toContain("pt-[env(safe-area-inset-top,0px)]");
    expect(header.className).toContain("bg-chrome");
    expect(header.className).toContain("items-center");
    expect(screen.getByRole("heading", { name: "研发部" })).toBeTruthy();
  });

  it("没给副行就不画副行那一格，标题独占垂直居中", () => {
    render(<PhonePageHeader testId="h" title="后端 Agent" />);
    expect(
      screen
        .getByTestId("h")
        .querySelector('[data-slot="phone-page-header-subtitle"]'),
    ).toBeNull();
  });

  it("副行组件渲染出空（保存态 idle）时那一格塌掉：empty:hidden", () => {
    const Nothing = () => null;
    render(
      <PhonePageHeader testId="h" title="后端 Agent" subtitle={<Nothing />} />,
    );
    const sub = screen
      .getByTestId("h")
      .querySelector('[data-slot="phone-page-header-subtitle"]');
    expect(sub).not.toBeNull();
    expect(sub!.className).toContain("empty:hidden");
    expect(sub!.childNodes).toHaveLength(0);
  });

  it("titleAs=span 时不额外造一个标题层级（外壳顶栏用）", () => {
    render(<PhonePageHeader testId="h" title="组织" titleAs="span" />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("组织").tagName).toBe("SPAN");
  });
});

describe("PhoneHeaderButton", () => {
  it("44×44，贴左 / 贴右各抵掉页头的 16px 内边距一半", () => {
    const onClick = vi.fn();
    render(
      <>
        <PhoneHeaderButton edge="start" aria-label="返回" onClick={onClick}>
          ‹
        </PhoneHeaderButton>
        <PhoneHeaderButton edge="end" aria-label="更多">
          •••
        </PhoneHeaderButton>
      </>,
    );
    const back = screen.getByRole("button", { name: "返回" });
    expect(back.className).toContain("size-11");
    expect(back.className).toContain("-ml-2");
    expect(screen.getByRole("button", { name: "更多" }).className).toContain(
      "-mr-2",
    );
    fireEvent.click(back);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("PhonePage", () => {
  it("页头在滚动区外，正文自己滚", () => {
    render(
      <PhonePage header={<PhonePageHeader testId="h" title="设置" />}>
        <p>正文</p>
      </PhonePage>,
    );
    const body = screen.getByText("正文").parentElement!;
    expect(body.getAttribute("data-slot")).toBe("phone-page-body");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.contains(screen.getByTestId("h"))).toBe(false);
  });
});
