import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";

import SessionFilePreviewColumn from "@/components/session/SessionFilePreviewColumn";
import { RelayError } from "@/lib/relayClient";

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
      onTogglePin={vi.fn()}
      onSegmentChange={vi.fn()}
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

/**
 * markdown 的「渲染 / 文本 / 双栏」（上游规格「预览的内容」：markdown 与桌面端
 * 一致地提供渲染视图与源码视图）。
 *
 * 控件在共享包里，档位存在宿主（决策 7 的同一条理由）—— 这一层要做的是把两头接上：
 * 点一下要报上来，报上来的档位要真的换掉正文。接不上就是三个画出来点了没反应的
 * 按钮。
 */
describe("markdown 的视图档位", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("点「文本」把档位报给宿主", async () => {
    const onSegmentChange = vi.fn();
    renderColumn({ onSegmentChange });

    fireEvent.click(await screen.findByRole("button", { name: "文本" }));

    expect(onSegmentChange).toHaveBeenCalledWith("text");
  });

  it("宿主给的档位真的换掉正文：文本档下不再是渲染出来的 markdown", async () => {
    renderColumn({ segment: "text" });

    await screen.findByTestId("file-preview-panel");
    await screen.findByRole("button", { name: "文本" });
    expect(screen.queryByText("正文")).toBeNull();
  });
});

/**
 * 失败态**打在装配根上**：让打桩的中继返回真实错误码，看面板真的落到对应态。
 *
 * 不用「注入一个预先贴好 kind 的 error」来满足 —— 那正是 agentre 修正轮里让缺陷
 * 漏出去的偷懒：归类这一层被绕开了，单测却是绿的。
 */
function renderFailing(err: unknown) {
  render(
    <SessionFilePreviewColumn
      sid="sess-1"
      cwd="/srv/work"
      client={{ request: vi.fn().mockRejectedValue(err) } as never}
      tabs={[{ path: "ghost.md", isPreview: true, isPinned: false }]}
      activePath="ghost.md"
      onActivate={vi.fn()}
      onPromote={vi.fn()}
      onTogglePin={vi.fn()}
      onSegmentChange={vi.fn()}
      onClose={vi.fn()}
      onCloseOthers={vi.fn()}
      onCloseAll={vi.fn()}
    />,
  );
}

describe("预览栏里的失败态", () => {
  // 断言的是**面板真的说了什么**，所以要把语言钉住 —— 测试环境的探测器默认落到
  // en（与本站其余用例同一条做法）。
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("那台机器答「文件不存在」：说出来，且**不给**动作按钮（终态）", async () => {
    renderFailing(new RelayError(-32043, "workspacefs: not found", null));

    expect(await screen.findByText("文件不存在")).toBeTruthy();
    const panel = screen.getByTestId("file-preview-panel");
    const header = screen.getByTestId("file-preview-header");
    const buttons = [...panel.querySelectorAll("button")].filter(
      (b) => !header.contains(b),
    );
    expect(buttons).toEqual([]);
  });

  it("连接断了：说「够不着」并给重试 —— 那台机器过会儿可能就回来了", async () => {
    renderFailing(new RelayError(-1, "relay: 连接未就绪", null));

    expect(await screen.findByText("这台机器现在够不着")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("认不出的失败：如实显示它自己的文案，仍给重试", async () => {
    renderFailing(new RelayError(-32040, "path refused", null));

    expect(await screen.findByText("path refused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});
