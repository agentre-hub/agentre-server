import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useFilePreviewTabs } from "@/components/session/useFilePreviewTabs";

/**
 * 预览标签的状态住在宿主（规格 2026-09-08 决策 7）：共享面板只收 `tabs` 与
 * `activePath`，「开几个、哪个是当前、临时还是常驻」是各宿主自己的布局问题。
 *
 * 临时/常驻沿用桌面端已有的语义：单击开出来的是**临时**标签，同一位置再开别的
 * 文件会把它顶掉；双击（或对临时标签再点一次）把它钉住。
 */
describe("控制台的预览标签", () => {
  it("第一次点开一个文件：开一个临时标签并成为当前", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));

    expect(result.current.tabs).toEqual([
      { path: "docs/a.md", isPreview: true, isPinned: false },
    ]);
    expect(result.current.activePath).toBe("docs/a.md");
  });

  it("再点另一个文件：临时标签被顶掉，而不是越开越多", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.open("docs/b.md"));

    expect(result.current.tabs.map((t) => t.path)).toEqual(["docs/b.md"]);
    expect(result.current.activePath).toBe("docs/b.md");
  });

  it("钉住之后再开别的文件，它留在标签条上", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.pin("docs/a.md"));
    act(() => result.current.open("docs/b.md"));

    expect(result.current.tabs.map((t) => t.path)).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
    expect(result.current.tabs[0].isPreview).toBe(false);
  });

  it("已经开着的文件再点一次：不重开，只切过去", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.pin("docs/a.md"));
    act(() => result.current.open("docs/b.md"));
    act(() => result.current.open("docs/a.md"));

    expect(result.current.tabs.map((t) => t.path)).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
    expect(result.current.activePath).toBe("docs/a.md");
  });

  // 关掉最后一个标签 → 整栏收起：宿主据 activePath 为 null 判定。
  it("关掉最后一个标签后没有当前标签了", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.close("docs/a.md"));

    expect(result.current.tabs).toEqual([]);
    expect(result.current.activePath).toBeNull();
  });

  it("关掉当前标签时，当前落到它左边那个，而不是无人认领", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("a.md"));
    act(() => result.current.pin("a.md"));
    act(() => result.current.open("b.md"));
    act(() => result.current.pin("b.md"));
    act(() => result.current.close("b.md"));

    expect(result.current.activePath).toBe("a.md");
  });

  // 换会话就是换了一批文件：上一条会话开着的标签不能漏到下一条里。
  it("换会话时清空", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.reset());

    expect(result.current.tabs).toEqual([]);
    expect(result.current.activePath).toBeNull();
  });
});
