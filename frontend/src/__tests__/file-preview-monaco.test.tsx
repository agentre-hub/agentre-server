import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadMonaco = vi.hoisted(() => vi.fn());
vi.mock("@/lib/monacoLoader", () => ({ loadMonaco }));

import SessionFilePreviewColumn from "@/components/session/SessionFilePreviewColumn";

import "@/i18n";

/**
 * Monaco 在控制台里是**懒加载**的（规格 2026-09-08 决策 6）：那几 MB 只在用户
 * 真的点开一个要它渲染的文件时才拉。
 *
 * 打桩打在装载器上，测的是**闸门**——什么时候拉、什么时候一次都不拉。语言表与
 * 渲染本身在共享包里测过。
 */
function renderColumn(path: string, content = "const a = 1\n") {
  const request = vi.fn().mockResolvedValue({
    content: new TextEncoder().encode(content),
    contentType: path.endsWith(".png") ? "image/png" : "",
  });
  render(
    <SessionFilePreviewColumn
      sid="sess-1"
      cwd="/srv/work"
      client={{ request } as never}
      tabs={[{ path, isPreview: true, isPinned: false }]}
      activePath={path}
      onActivate={vi.fn()}
      onPromote={vi.fn()}
      onTogglePin={vi.fn()}
      onSegmentChange={vi.fn()}
      onClose={vi.fn()}
      onCloseOthers={vi.fn()}
      onCloseAll={vi.fn()}
    />,
  );
  return { request };
}

describe("控制台的 Monaco 懒加载", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 假命名空间的形状与共享包用例里那份一致：编辑器与模型都要能 dispose，
    // 缺一格就会在卸载时炸，测出来的却是「Monaco 没装载」这种假信号。
    loadMonaco.mockResolvedValue({
      editor: {
        setTheme: vi.fn(),
        create: vi.fn(() => ({ setValue: vi.fn(), dispose: vi.fn() })),
        createDiffEditor: vi.fn(() => ({
          setModel: vi.fn(),
          dispose: vi.fn(),
        })),
        createModel: vi.fn(() => ({ dispose: vi.fn() })),
      },
    });
  });

  it("点开一个代码文件才去装载", async () => {
    renderColumn("src/a.ts");

    await waitFor(() => expect(loadMonaco).toHaveBeenCalledTimes(1));
  });

  it("点开的是图片时一次都不装载 —— 那几 MB 白拉", async () => {
    renderColumn("assets/logo.png", "");

    await screen.findByTestId("file-preview-panel");
    expect(loadMonaco).not.toHaveBeenCalled();
  });

  it("装载失败不炸面板：内容区留空，面板照常在", async () => {
    loadMonaco.mockRejectedValue(new Error("chunk 拉不下来"));
    renderColumn("src/a.ts");

    expect(await screen.findByTestId("file-preview-panel")).toBeTruthy();
  });
});
