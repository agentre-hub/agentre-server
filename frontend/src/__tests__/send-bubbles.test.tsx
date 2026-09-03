/**
 * 「排着队的」与「没发出去的」那两条，改用共享包的消息外壳。
 *
 * 为什么要改：这两条**站在转录流里**，与真消息前后相邻，而转录整条渲染路径已经
 * 是共享包的（`Transcript.tsx`）。包里一条用户消息是带头像的 `MessageRow`
 * ——左对齐、头像在行首、正文在右边一列。而这两条此前是自画的右对齐气泡
 * （`max-w-[84%] self-end`），于是「我刚敲进去的那句话」与「已经发出去的那句话」
 * 在同一列里长得不是一个东西：一个贴右、一个贴左，中间还差一个头像。
 *
 * 换的是**外壳**，不是行为：决策 6（排队可见 + 可撤销）与决策 7（用户写的字留在
 * 屏幕上、按分类给不同主动作）逐条保留，`session-detail.test.tsx` 里钉它们的那些
 * 用例一条都没动。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import "@/i18n";
import {
  installCopyCommandModel,
  removeClipboard,
  restoreClipboardEnv,
} from "@/test/clipboard";
import PendingSendBubble from "@/components/session/PendingSendBubble";
import SendFailureBubble from "@/components/session/SendFailureBubble";

/** 包给用户消息的头像：一枚写着「我」的方块，靠 aria-label 认得出来。 */
function meAvatarIn(el: HTMLElement) {
  return within(el).queryByRole("img", { name: "Me" });
}

afterEach(() => {
  restoreClipboardEnv();
});

describe("排队与失败那两条：外壳与真用户消息同源", () => {
  it("Given 一条排着队的, When 渲染, Then 它是带「我」头像的消息行，不是右对齐气泡", () => {
    render(<PendingSendBubble text="deploy the thing" onCancel={() => {}} />);

    const row = screen.getByTestId("send-pending");
    expect(meAvatarIn(row)).toBeTruthy();
    // 右对齐是旧外壳的记号。包的转录里一条消息都不贴右——留着它，这一条就仍然
    // 与相邻的真消息不是一个东西。
    expect(row.className).not.toContain("self-end");
    expect(row.className).not.toContain("max-w-[84%]");
    // 用户写的字还在。
    expect(within(row).getByText("deploy the thing")).toBeTruthy();
  });

  it("Given 一条没发出去的, When 渲染, Then 同样是消息行，且三个动作都在", () => {
    render(
      <SendFailureBubble
        failure={{ id: "f1", text: "rerun the migration", kind: "rejected" }}
        onRetry={() => {}}
        onDiscard={() => {}}
      />,
    );

    const row = screen.getByTestId("send-failure");
    expect(meAvatarIn(row)).toBeTruthy();
    expect(row.className).not.toContain("self-end");
    expect(within(row).getByText("rerun the migration")).toBeTruthy();
    // 决策 7 的三个动作原样保留。
    expect(within(row).getByTestId("send-failure-retry")).toBeTruthy();
    expect(within(row).getByTestId("send-failure-copy")).toBeTruthy();
    expect(within(row).getByTestId("send-failure-discard")).toBeTruthy();
  });

  it("Given transport 那一类, When 渲染, Then 主动作仍是「检查后重发」", () => {
    // 决策 7 的分类不能被外壳改动顺手抹平：transport「可能已经送达」，
    // 默认动作不该是一个可能发出两条的操作。
    render(
      <SendFailureBubble
        failure={{ id: "f1", text: "x", kind: "transport" }}
        machineName="mac-studio-01"
        onRetry={() => {}}
        onDiscard={() => {}}
      />,
    );

    const retry = screen.getByTestId("send-failure-retry");
    expect(retry.textContent).toContain("Recheck and resend");
    expect(screen.getByTestId("send-failure").dataset.failureKind).toBe(
      "transport",
    );
  });

  it("Given 用户点了撤销, When 排队那条上, Then 回调照旧", () => {
    const onCancel = vi.fn();
    render(<PendingSendBubble text="x" onCancel={onCancel} />);
    screen.getByTestId("send-pending-cancel").click();
    expect(onCancel).toHaveBeenCalled();
  });

  /*
    「复制文本」这颗按钮在**线上**是死的。

    本站是 http 部署（非安全上下文），`navigator.clipboard` 整个对象都不存在，
    而这里写的是 `navigator.clipboard?.writeText(...)`：可选链把整件事吞掉——
    不复制、不报错、连一句话都没有。用户看着按钮亮了一下，粘贴出来是空的。

    复制要走共享包那一层（它在这种环境下用 execCommand 兜底），并且要给回执：
    这条气泡站在转录流里、会随着新消息滚走，没有地方留一个就地的「已复制」，
    所以回执只能是 toast。
  */
  it("Given 非安全上下文没有 Clipboard API, When 点「复制文本」, Then 兜底真的复制并给回执", async () => {
    const succeeded = vi.spyOn(toast, "success").mockClear();
    removeClipboard();
    const selectedAtCopy = installCopyCommandModel();

    render(
      <SendFailureBubble
        failure={{ id: "f1", text: "rerun the migration", kind: "rejected" }}
        onRetry={() => {}}
        onDiscard={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("send-failure-copy"));

    await waitFor(() => {
      expect(selectedAtCopy).toEqual(["rerun the migration"]);
    });
    expect(succeeded.mock.calls[0]?.[0]).toBe("Message text copied");
  });

  it("Given 一条复制通道都没有, When 点「复制文本」, Then 不谎报成功", async () => {
    const succeeded = vi.spyOn(toast, "success").mockClear();
    const failed = vi.spyOn(toast, "error").mockClear();
    removeClipboard();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    render(
      <SendFailureBubble
        failure={{ id: "f1", text: "rerun the migration", kind: "rejected" }}
        onRetry={() => {}}
        onDiscard={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("send-failure-copy"));

    await waitFor(() => {
      expect(failed.mock.calls[0]?.[0]).toBe("Could not copy the message text");
    });
    expect(succeeded).not.toHaveBeenCalled();
  });
});
