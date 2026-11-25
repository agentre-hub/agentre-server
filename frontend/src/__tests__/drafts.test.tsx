/**
 * 草稿静默保留（规格 2026-11-25 决策 C1；审计 I2、I3 草稿部分、I4）。
 *
 *   - 本地草稿库：文字与图片原样存取（逐字节一致），按账号隔离，存储不可用时静默。
 *   - 行副行：待发送 > 草稿 > 内容。
 *   - 输入框：随输入保存（防抖）、卸载时冲刷、回来恢复；发出（提交后那一次空报告）或
 *     清空即清除；两条对话的草稿互不串；登出 / 换账号后读不到。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import SessionComposer from "@/components/session/SessionComposer";
import { DRAFT_SAVE_DEBOUNCE_MS, draftStore, type Draft } from "@/lib/drafts";
import { bindAccount, wipeBusinessData } from "@/lib/localStore";
import { rowSubline } from "@/pages/chat/phoneRows";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn(async () => ({ devices: [] })) };
});

const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  g.indexedDB = new IDBFactory();
  g.IDBKeyRange = IDBKeyRange;
  bindAccount(1);
});
afterEach(() => {
  bindAccount(null);
  delete g.indexedDB;
});

/** 一张 1×3 字节的假 png。 */
const shot = {
  dataUrl: "data:image/png;base64,AQID",
  mediaType: "image/png",
  name: "shot.png",
};

describe("draftStore", () => {
  it("文字与图片原样存取，逐字节一致（空白、换行、emoji、两张图）", async () => {
    const draft: Draft = {
      text: "  第一行 \n\n第二行\t尾部空格  🙂 ",
      images: [
        shot,
        { ...shot, name: "b.png", dataUrl: "data:image/png;base64,/+8=" },
      ],
    };
    await draftStore.put("session:A", draft);

    expect(await draftStore.get("session:A")).toEqual(draft);
  });

  it("delete 之后读不到；list 给出全部草稿（键 → 草稿）", async () => {
    await draftStore.put("session:A", { text: "a", images: [] });
    await draftStore.put("new", { text: "n", images: [shot] });

    const all = await draftStore.list();
    expect([...all.keys()].sort()).toEqual(["new", "session:A"]);
    expect(all.get("new")?.images).toEqual([shot]);

    await draftStore.delete("session:A");
    expect(await draftStore.get("session:A")).toBeUndefined();
    expect([...(await draftStore.list()).keys()]).toEqual(["new"]);
  });

  it("按账号隔离；登出清空后读不到", async () => {
    await draftStore.put("session:A", { text: "a", images: [] });

    bindAccount(2);
    expect(await draftStore.get("session:A")).toBeUndefined();
    expect((await draftStore.list()).size).toBe(0);

    bindAccount(1);
    expect(await draftStore.get("session:A")).toBeDefined();
    await wipeBusinessData();
    bindAccount(1);
    expect(await draftStore.get("session:A")).toBeUndefined();
  });

  it("没有 IndexedDB 时不抛：读是空，写静默丢掉", async () => {
    delete g.indexedDB;
    await expect(
      draftStore.put("session:A", { text: "a", images: [] }),
    ).resolves.toBeUndefined();
    expect(await draftStore.get("session:A")).toBeUndefined();
    expect((await draftStore.list()).size).toBe(0);
  });
});

describe("rowSubline：待发送 > 草稿 > 内容", () => {
  const row = { conversationId: "42" } as MirrorIndexRow;

  it("没有草稿与待发送：是内容", () => {
    expect(rowSubline(row, { content: "后端 Agent · 书房" })).toEqual({
      kind: "content",
      text: "后端 Agent · 书房",
    });
    expect(rowSubline(row)).toEqual({ kind: "content", text: "" });
  });

  it("有草稿：取首个非空行（去首尾空白）", () => {
    expect(
      rowSubline(row, {
        content: "x",
        draft: { text: "\n  改一下登录页 \n第二行", images: [] },
      }),
    ).toEqual({ kind: "draft", text: "改一下登录页" });
  });

  it("只有图的草稿也算草稿，文字为空", () => {
    expect(
      rowSubline(row, { content: "x", draft: { text: "", images: [shot] } }),
    ).toEqual({ kind: "draft", text: "" });
  });

  it("空草稿（只有空白、没有图）不算草稿", () => {
    expect(
      rowSubline(row, {
        content: "x",
        draft: { text: "  \n ", images: [] },
      }),
    ).toEqual({ kind: "content", text: "x" });
  });

  it("待发送优先于草稿", () => {
    expect(
      rowSubline(row, {
        content: "x",
        draft: { text: "草稿", images: [] },
        pending: { text: "排队的\n第二行" },
      }),
    ).toEqual({ kind: "pending", text: "排队的" });
  });
});

function editable(): HTMLElement & {
  editor?: { commands: { setContent: (v: string) => void } };
} {
  const el = document.querySelector<HTMLElement>(
    '[data-testid="session-detail-composer"] .ProseMirror',
  );
  if (!el) throw new Error("输入框没渲染出来");
  return el;
}

function type(text: string) {
  act(() => {
    editable().editor?.commands.setContent(`<p>${text}</p>`);
  });
}

function attach() {
  fireEvent.change(screen.getByLabelText("Add image", { selector: "input" }), {
    target: {
      files: [
        new File([new Uint8Array([1, 2, 3])], "shot.png", {
          type: "image/png",
        }),
      ],
    },
  });
}

function mount(draftKey: string | undefined, onSubmit = vi.fn()) {
  const view = render(
    <SessionComposer
      draftKey={draftKey}
      agents={[]}
      disabled={false}
      onSubmit={onSubmit}
    />,
  );
  return { ...view, onSubmit };
}

async function savedText(key: string) {
  return (await draftStore.get(key))?.text;
}

const WAIT = { timeout: DRAFT_SAVE_DEBOUNCE_MS * 8 + 2000 };

describe("输入框随输入保存、回来恢复", () => {
  it("打字后防抖保存（不是每个键都落库），恢复后字与图一致且能原样发出", async () => {
    const first = mount("session:A");
    await waitFor(() => editable());
    type("写了一半的话");
    expect(await savedText("session:A")).toBeUndefined();
    await waitFor(async () => {
      expect(await savedText("session:A")).toBe("写了一半的话");
    }, WAIT);
    first.unmount();

    const second = mount("session:A");
    await waitFor(
      () => expect(editable().textContent).toBe("写了一半的话"),
      WAIT,
    );
    fireEvent.click(screen.getByTestId("session-detail-send"));
    expect(second.onSubmit).toHaveBeenCalledWith("写了一半的话", undefined);
  });

  it("只贴图不打字也保存；恢复后缩略图回来，发出的图与贴的一致", async () => {
    const first = mount("session:A");
    await waitFor(() => editable());
    attach();
    await within(first.container).findByAltText("shot.png");
    await waitFor(async () => {
      expect((await draftStore.get("session:A"))?.images).toHaveLength(1);
    }, WAIT);
    const stored = (await draftStore.get("session:A"))!.images[0];
    first.unmount();

    const second = mount("session:A");
    await within(second.container).findByAltText("shot.png", {}, WAIT);
    fireEvent.click(screen.getByTestId("session-detail-send"));
    expect(second.onSubmit).toHaveBeenCalledWith("", [stored]);
    expect(stored).toEqual(shot);
  });

  it("防抖窗口内就卸载（离开页面）也不丢：卸载时冲刷", async () => {
    const first = mount("session:A");
    await waitFor(() => editable());
    type("刚打完就走");
    first.unmount();

    await waitFor(async () => {
      expect(await savedText("session:A")).toBe("刚打完就走");
    });
  });

  it("页面被藏起来（pagehide）时冲刷", async () => {
    mount("session:A");
    await waitFor(() => editable());
    type("切走了");
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(async () => {
      expect(await savedText("session:A")).toBe("切走了");
    });
  });

  it("发出之后草稿被清掉，且不会被还没触发的防抖写回来", async () => {
    const view = mount("session:A");
    await waitFor(() => editable());
    type("这句要发");
    fireEvent.click(screen.getByTestId("session-detail-send"));
    expect(view.onSubmit).toHaveBeenCalledWith("这句要发", undefined);

    await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS * 2));
    expect(await draftStore.get("session:A")).toBeUndefined();
  });

  it("保存过的草稿，发出之后库里的那条被删掉", async () => {
    const view = mount("session:A");
    await waitFor(() => editable());
    type("先存下来");
    await waitFor(async () => {
      expect(await savedText("session:A")).toBe("先存下来");
    }, WAIT);
    fireEvent.click(screen.getByTestId("session-detail-send"));
    await waitFor(async () => {
      expect(await draftStore.get("session:A")).toBeUndefined();
    }, WAIT);
    view.unmount();
    mount("session:A");
    await waitFor(() => editable());
    await new Promise((r) => setTimeout(r, 200));
    expect(editable().textContent).toBe("");
  });

  it("把输入框清空：草稿被清掉", async () => {
    mount("session:A");
    await waitFor(() => editable());
    type("要清掉的");
    await waitFor(async () => {
      expect(await savedText("session:A")).toBe("要清掉的");
    }, WAIT);
    type("");
    await waitFor(async () => {
      expect(await draftStore.get("session:A")).toBeUndefined();
    }, WAIT);
  });

  it("两条对话的草稿互不串", async () => {
    const a = mount("session:A");
    await waitFor(() => editable());
    type("A 的话");
    a.unmount();
    await waitFor(async () =>
      expect(await savedText("session:A")).toBe("A 的话"),
    );

    const b = mount("session:B");
    await waitFor(() => editable());
    await new Promise((r) => setTimeout(r, 200));
    expect(editable().textContent).toBe("");
    type("B 的话");
    b.unmount();
    await waitFor(async () =>
      expect(await savedText("session:B")).toBe("B 的话"),
    );
    expect(await savedText("session:A")).toBe("A 的话");
  });

  it("换了账号：看不到上一个账号的草稿", async () => {
    const a = mount("session:A");
    await waitFor(() => editable());
    type("账号一的话");
    a.unmount();
    await waitFor(async () =>
      expect(await savedText("session:A")).toBe("账号一的话"),
    );

    bindAccount(2);
    mount("session:A");
    await waitFor(() => editable());
    await new Promise((r) => setTimeout(r, 200));
    expect(editable().textContent).toBe("");
  });

  it("没有 draftKey 就不存也不读（桌面之外的用法不受影响）", async () => {
    const a = mount(undefined);
    await waitFor(() => editable());
    type("不存");
    a.unmount();
    await new Promise((r) => setTimeout(r, 200));
    expect((await draftStore.list()).size).toBe(0);
  });

  it("恢复发生在用户已经开始打字之后：不覆盖用户刚打的字", async () => {
    await draftStore.put("session:A", { text: "旧草稿", images: [] });
    mount("session:A");
    await waitFor(() => editable());
    type("我先打了");
    await new Promise((r) => setTimeout(r, 200));
    expect(editable().textContent).toBe("我先打了");
  });
});
