import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SessionFilePreviewColumn from "@/components/session/SessionFilePreviewColumn";

import "@/i18n";

/**
 * 预览栏在控制台这一侧的装配根。
 *
 * 面板本身在共享包里测过；这里测的是**装配**：端口有没有真的接到中继上、
 * 正文有没有落到面板里、设备那一格有没有把机器名与在线态交上去。
 *
 * 打桩打在**中继**上而不是端口上：端口正是本轮要证明的那一层，把它换成假的
 * 就等于绕开了要测的东西（agentre 修正轮的教训）。
 */
function renderColumn(overrides: Record<string, unknown> = {}) {
  const request = vi.fn().mockResolvedValue({
    content: new TextEncoder().encode("# 标题\n\n正文\n"),
    contentType: "",
  });
  render(
    <SessionFilePreviewColumn
      sid="sess-1"
      cwd="/srv/work"
      client={{ request } as never}
      deviceName="dev-box"
      deviceOnline
      tabs={[{ path: "docs/a.md", isPreview: true, isPinned: false }]}
      activePath="docs/a.md"
      onActivate={vi.fn()}
      onPromote={vi.fn()}
      onClose={vi.fn()}
      onCloseOthers={vi.fn()}
      onCloseAll={vi.fn()}
      {...overrides}
    />,
  );
  return { request };
}

describe("控制台的预览栏", () => {
  it("把中继读回来的正文画进面板", async () => {
    const { request } = renderColumn();

    expect(await screen.findByText("正文")).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("路径条上标出正文来自哪台机器、它此刻在不在线", async () => {
    renderColumn();

    expect(await screen.findByText("dev-box")).toBeTruthy();
    expect(
      screen.getByTestId("file-preview-device").getAttribute("data-online"),
    ).toBe("true");
  });

  it("没有当前标签时整栏不渲染 —— 转录回到全宽由父级据此判定", () => {
    renderColumn({ activePath: null, tabs: [] });

    expect(screen.queryByTestId("file-preview-panel")).toBeNull();
  });
});
