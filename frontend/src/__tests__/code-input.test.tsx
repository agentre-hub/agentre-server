import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import CodeInput from "@/components/CodeInput";
import i18n from "@/i18n";
import { toChars } from "@/lib/userCode";

function Harness({ initial = "" }: { initial?: string }) {
  const [v, setV] = useState(toChars(initial));
  return <CodeInput value={v} onChange={setV} />;
}

function boxes() {
  return screen.getAllByRole("textbox") as HTMLInputElement[];
}
function values() {
  return boxes().map((b) => b.value);
}

/** 输入法 / 键盘建议插入整段文字：只有 beforeinput，没有 paste 事件。 */
function beforeInput(box: HTMLElement, init: InputEventInit) {
  const ev = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    box.dispatchEvent(ev);
  });
  return ev;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

describe("设备码输入 · 输入法整段插入（I21）", () => {
  it("整段文字插入第一格：六格填满，焦点留在最后一格", () => {
    render(<Harness />);
    const ev = beforeInput(boxes()[0], {
      inputType: "insertText",
      data: "K7Q-M4X",
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(values()).toEqual(["K", "7", "Q", "M", "4", "X"]);
    expect(document.activeElement).toBe(boxes()[5]);
  });

  it("小写、空格、连字符都被清洗；插在中间格只从那一格往后填", () => {
    render(<Harness initial="K7Q" />);
    beforeInput(boxes()[3], { inputType: "insertText", data: " m4-x " });
    expect(values()).toEqual(["K", "7", "Q", "M", "4", "X"]);
  });

  it("半段插在中间：只写到末格为止，不越界", () => {
    render(<Harness />);
    beforeInput(boxes()[4], { inputType: "insertText", data: "ABCD" });
    expect(values()).toEqual(["", "", "", "", "A", "B"]);
  });

  it("insertReplacementText（键盘建议替换）同样整段落格", () => {
    render(<Harness />);
    beforeInput(boxes()[0], {
      inputType: "insertReplacementText",
      data: "K7QM4X",
    });
    expect(values().join("")).toBe("K7QM4X");
  });

  it("单个字符仍走原来的 change 路径，不被拦", () => {
    render(<Harness />);
    const ev = beforeInput(boxes()[0], { inputType: "insertText", data: "K" });
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("设备码输入 · Android 退格（I21）", () => {
  it("空格上的 deleteContentBackward 清上一格并回到上一格", () => {
    render(<Harness initial="K7Q" />);
    boxes()[3].focus();
    const ev = beforeInput(boxes()[3], { inputType: "deleteContentBackward" });
    expect(ev.defaultPrevented).toBe(true);
    expect(values()).toEqual(["K", "7", "", "", "", ""]);
    expect(document.activeElement).toBe(boxes()[2]);
  });

  it("有字的格上先只清本格，焦点不动", () => {
    render(<Harness initial="K7Q" />);
    boxes()[2].focus();
    beforeInput(boxes()[2], { inputType: "deleteContentBackward" });
    expect(values()).toEqual(["K", "7", "", "", "", ""]);
    expect(document.activeElement).toBe(boxes()[2]);
  });

  it("第一格为空时退格什么也不做", () => {
    render(<Harness />);
    beforeInput(boxes()[0], { inputType: "deleteContentBackward" });
    expect(values()).toEqual(["", "", "", "", "", ""]);
  });

  it("桌面 Backspace 键仍是一次退一格，且不重复处理", () => {
    render(<Harness initial="K7Q" />);
    boxes()[3].focus();
    fireEvent.keyDown(boxes()[3], { key: "Backspace" });
    expect(values()).toEqual(["K", "7", "", "", "", ""]);
  });
});
