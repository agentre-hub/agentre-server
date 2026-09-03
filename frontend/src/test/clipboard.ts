import { vi } from "vitest";

/**
 * 复制这件事在用例里的公共替身。
 *
 * 本站是 http 部署的常客（`http://<局域网 IP>:port`），那里 Clipboard API 整个
 * 对象都不存在，复制只剩共享包的 `execCommand` 兜底。真正会出事的是后一条路，
 * 所以摸剪贴板的用例都用同一套替身，别各写各的。
 */

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

export function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

/** 非安全上下文下浏览器根本不暴露 navigator.clipboard——不是拒绝，是没有。 */
export function removeClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
}

export function installExecCommand(execCommand: unknown) {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
}

/** 两样都还原，免得污染同一个文件里后面的用例。 */
export function restoreClipboardEnv() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: originalExecCommand,
  });
}

/**
 * `execCommand("copy")` 的替身：按浏览器的规则算「这一刻按下复制会拿走什么」
 * ——焦点在可编辑控件里时是那个控件的选区，否则是文档选区。返回的数组按调用
 * 顺序记下每次真正会被复制走的内容。
 *
 * 断言必须打在它上面，不能打在返回值上：Chromium 什么都没选中时
 * `execCommand("copy")` 照样返回 `true`，那种成功是假的。
 */
export function installCopyCommandModel(): string[] {
  const copied: string[] = [];
  installExecCommand(
    vi.fn((command: string) => {
      if (command !== "copy") return false;
      const active = document.activeElement;
      const field =
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement
          ? active.value.slice(
              active.selectionStart ?? 0,
              active.selectionEnd ?? 0,
            )
          : "";
      copied.push(field || String(window.getSelection() ?? ""));
      return true;
    }),
  );
  return copied;
}
