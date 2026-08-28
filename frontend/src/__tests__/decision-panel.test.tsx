/**
 * 待决策面板改用共享包的卡片渲染。
 *
 * 为什么要改：同一个审批在这一屏上曾有**两种画法**。转录里那张来自事件流，由包的
 * `CanonicalToolRouter` 渲染（共享包的 `reduceFrames` 归约出 canonical 之后）；
 * 而 `DecisionPanel` 里那张来自 `runtime.session.pendingWaiters` 一次 RPC，是本站
 * 手画的另一份 —— `<pre>` 铺一坨 `JSON.stringify(waiter.Input)` 加三个按钮。于是
 * 同一条待决，从事件流来是一个样子，从 waiters 来是另一个样子。
 *
 * **两份清单不合并**，那是对的（`SessionDetailView` 里已有说明）：卡来自事件流，
 * 浏览器手上有那一帧才画得出来；waiters 来自 RPC，说的是那台机器此刻真正阻塞在
 * 哪些请求上。镜像被裁剪、或浏览器从中途接进来时，只有后者兜得住。要消掉的是
 * **两份画法**，不是两份清单。
 *
 * R10 的「已被别的端回答过」必须活下来，而且**仍然是面板级的一行说明**，不是卡
 * 自己的错误态：预检要刷一次 waiters，而「已被别的端答过」的直接后果就是这条待决
 * 从清单里消失、那张卡随之卸载。挂在卡上等于挂在一个正要消失的东西上。
 *
 * 决策 8（提交失败走 toast，不在版面里长红字）也因此留在宿主那一侧：注入的端口
 * 吞掉异常、不再抛给卡片，否则同一次失败会被说两遍，其中一遍正是要去掉的那行。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import DecisionPanel from "@/components/session/DecisionPanel";
import { waiterBlocks } from "@/lib/waiterBlocks";

const PORTS = {
  answerToolPermission: vi.fn().mockResolvedValue(undefined),
  answerUserQuestion: vi.fn().mockResolvedValue(undefined),
};

function renderPanel(
  props: Partial<React.ComponentProps<typeof DecisionPanel>>,
) {
  return render(
    <DecisionPanel
      sessionId={7}
      toolPermissions={[]}
      askUserQuestions={[]}
      ports={PORTS}
      {...props}
    />,
  );
}

describe("waiterBlocks：待决策 → 共享包的 canonical 块", () => {
  it("Given 一条工具授权待决, When 归约, Then 产出 kind=tool.permission 的块", () => {
    const blocks = waiterBlocks({
      toolPermissions: [
        { RequestID: "tp-1", ToolName: "Bash", Input: { command: "ls -la" } },
      ],
      askUserQuestions: [],
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].block.canonical).toEqual({
      kind: "tool.permission",
      toolPermission: {
        requestId: "tp-1",
        toolName: "Bash",
        toolInput: { command: "ls -la" },
      },
    });
  });

  it("Given 一条提问待决, When 归约, Then PascalCase 的问题被搬成包要的 camelCase", () => {
    // daemon 那边是 agentruntime 的结构体，没有 JSON tag，顶层是 PascalCase。
    // 包的 AskQuestionDTO 是 camelCase —— 不搬字段的话卡片渲染出来每一问都是空的。
    const blocks = waiterBlocks({
      toolPermissions: [],
      askUserQuestions: [
        {
          RequestID: "aq-1",
          Questions: [
            {
              ID: "q1",
              Question: "Which database?",
              Header: "Storage",
              MultiSelect: true,
              IsOther: false,
              Options: [
                { Label: "Postgres", Description: "关系型" },
                { Label: "Redis" },
              ],
            },
          ],
        },
      ],
    });

    expect(blocks[0].block.canonical).toEqual({
      kind: "user.ask",
      userAsk: {
        requestId: "aq-1",
        questions: [
          {
            id: "q1",
            question: "Which database?",
            header: "Storage",
            multiSelect: true,
            isOther: false,
            options: [
              { label: "Postgres", description: "关系型" },
              { label: "Redis" },
            ],
          },
        ],
      },
    });
  });

  it("Given 没有 RequestID 的待决, When 归约, Then 跳过它", () => {
    // RequestID 是 optional（daemon 的 omitempty）。没有 id 就无从提交，
    // 包的卡片自己也会 return null —— 与其渲染一张点不动的卡，不如不出。
    const blocks = waiterBlocks({
      toolPermissions: [{ ToolName: "Bash" }],
      askUserQuestions: [{ Questions: [] }],
    });
    expect(blocks).toHaveLength(0);
  });
});

describe("DecisionPanel：与转录里那张是同一张卡", () => {
  it("Given 一条工具授权待决, When 面板渲染, Then 出的是包的授权卡而不是本站自画的", () => {
    renderPanel({
      toolPermissions: [
        { RequestID: "tp-1", ToolName: "Bash", Input: { command: "ls -la" } },
      ],
    });

    // 包的卡片自带这个 testid（dist/transcript/canonical-tool/tool-permission/card.js）。
    expect(screen.getByTestId("tool-permission-card")).toBeTruthy();
    // 包的三个动作，不是本站曾经的 Allow / Always allow / Deny。
    expect(screen.getByRole("button", { name: /Allow Once/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Always Allow This Session/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reject/i })).toBeTruthy();
    // 工具名与摘要进了卡头；Bash 的摘要是 command 本身，不是一坨 JSON。
    expect(screen.getByText("ls -la")).toBeTruthy();
  });

  it("Given 用户点了「仅本次允许」, When 提交, Then 走宿主注入的端口", async () => {
    PORTS.answerToolPermission.mockClear();
    renderPanel({
      toolPermissions: [
        { RequestID: "tp-1", ToolName: "Bash", Input: { command: "ls -la" } },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: /Allow Once/i }));

    await waitFor(() => {
      expect(PORTS.answerToolPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 7,
          requestId: "tp-1",
          allow: true,
          alwaysAllowSession: false,
        }),
      );
    });
  });

  it("Given 这条待决已被别的端回答过, When 那张卡已经不在了, Then 说明仍然看得见", () => {
    // R10。这句话**活得比卡长**是有意的：预检要刷一次 waiters，而「已被别的端
    // 答过」的直接后果就是这条待决从清单里消失、卡片随之卸载。所以它由宿主用
    // handledRequestId 递进来，而不是挂在卡自己的错误态上——挂上去就等于挂在一个
    // 正要消失的东西上，用户什么都看不到。
    renderPanel({ handledRequestId: "tp-1" });

    expect(
      screen.getByText("This request has already been handled."),
    ).toBeTruthy();
    // 没有卡，但面板照样出——这正是「不能挂在卡上」的那一格。
    expect(screen.queryByTestId("tool-permission-card")).toBeNull();
  });

  it("Given 一条都没有且没有已处理说明, When 渲染, Then 整个面板不出", () => {
    const { container } = renderPanel({});
    expect(container.firstChild).toBeNull();
  });
});
