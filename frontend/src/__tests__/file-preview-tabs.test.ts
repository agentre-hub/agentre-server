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
      // segment 是宿主自己那一格（markdown 的视图档位），随标签一起生灭；
      // reveal 是「这次要滚到哪一段」，不带行号点开时为 null。
      {
        path: "docs/a.md",
        isPreview: true,
        isPinned: false,
        segment: null,
        reveal: null,
      },
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

  it("转常驻之后再开别的文件，它留在标签条上", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.promote("docs/a.md"));
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
    act(() => result.current.promote("docs/a.md"));
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
    act(() => result.current.promote("a.md"));
    act(() => result.current.open("b.md"));
    act(() => result.current.promote("b.md"));
    act(() => result.current.close("b.md"));

    expect(result.current.activePath).toBe("a.md");
  });

  // 「双击转常驻」与「右键固定」是**两件事**（桌面端 promoteActivePreviewTab 与
  // togglePreviewTabPin 各管各的）：双击只是让这个标签不再被下一次单击顶掉，它
  // 没有被钉住 —— 钉住会在标签上画一枚图钉、并把右键菜单那一条变成「取消置顶」。
  it("双击转常驻不等于固定：不画图钉，右键菜单仍是「置顶」", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.promote("docs/a.md"));

    expect(result.current.tabs[0]).toMatchObject({
      path: "docs/a.md",
      isPreview: false,
      isPinned: false,
    });
  });

  // 右键菜单那一条是**开关**：钉住之后菜单变成「取消置顶」，点它必须真的取消。
  it("固定是开关：钉住顺带转常驻，再点一次取消固定", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.togglePin("docs/a.md"));

    expect(result.current.tabs[0]).toMatchObject({
      isPinned: true,
      isPreview: false,
    });

    act(() => result.current.togglePin("docs/a.md"));

    expect(result.current.tabs[0].isPinned).toBe(false);
  });
});

/**
 * markdown 的「渲染 / 文本 / 双栏」档位同样是宿主状态（决策 7 的同一条理由：
 * 共享面板只画控件，档位存在哪由宿主答）。桌面端把它存在标签上，控制台照办 ——
 * 不存的话那三个按钮就是画出来点了没反应的死控件。
 */
describe("markdown 的视图档位", () => {
  it("默认没有档位；切一次之后当前标签记住它", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    expect(result.current.activeSegment).toBeNull();

    act(() => result.current.setSegment("text"));
    expect(result.current.activeSegment).toBe("text");
  });

  it("档位跟着标签走：切到另一个标签看到的是它自己的档位", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.promote("docs/a.md"));
    act(() => result.current.setSegment("split"));
    act(() => result.current.open("docs/b.md"));

    expect(result.current.activeSegment).toBeNull();

    act(() => result.current.open("docs/a.md"));

    expect(result.current.activeSegment).toBe("split");
  });
});

describe("控制台的预览标签（续）", () => {
  // 换会话就是换了一批文件：上一条会话开着的标签不能漏到下一条里。
  // ── 定位目标（转录里点了一条带行号的链接）────────────────────────────────
  it("带行号点开：定位目标连同一个 nonce 记在这个标签上", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("src/foo.go", { line: 311, endLine: 330 }));

    expect(result.current.activeReveal).toMatchObject({
      line: 311,
      endLine: 330,
      nonce: expect.any(Number),
    });
  });

  it("同一条链接再点一次：nonce 变了，面板据此重新滚回去", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("src/foo.go", { line: 311 }));
    const first = result.current.activeReveal?.nonce as number;
    act(() => result.current.open("src/foo.go", { line: 311 }));

    expect(result.current.activeReveal?.nonce).toBeGreaterThan(first);
  });

  it("同一个文件不带行号再点开：上一次的定位目标被清掉，不再生效", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("src/foo.go", { line: 311 }));
    act(() => result.current.open("src/foo.go"));

    expect(result.current.activeReveal).toBeNull();
  });

  it("带行号的 markdown 新开在文本档：渲染档没有行的概念", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/guide.md", { line: 8, endLine: 9 }));

    expect(result.current.activeSegment).toBe("text");
  });

  it("已经开着的 markdown 标签不被行号改掉它自己选的档位", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/guide.md"));
    act(() => result.current.setSegment("render"));
    act(() => result.current.open("docs/guide.md", { line: 8 }));

    expect(result.current.activeSegment).toBe("render");
    expect(result.current.activeReveal).toMatchObject({ line: 8 });
  });

  it("换会话时清空", () => {
    const { result } = renderHook(() => useFilePreviewTabs());

    act(() => result.current.open("docs/a.md"));
    act(() => result.current.reset());

    expect(result.current.tabs).toEqual([]);
    expect(result.current.activePath).toBeNull();
  });
});
