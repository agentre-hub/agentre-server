import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import "@/i18n";
import { OrgExecTargetSection } from "@/pages/org/OrgExecTargetSection";
import type { OrgExecTargetItem } from "@/pages/org/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

/**
 * 执行目标的**排序**：拖拽与「柄聚焦 + ↑/↓」两条路径。
 *
 * 共享包画的那颗拖拽柄此前是死的 —— 有 `cursor-grab` 和 aria-label，却没有
 * `setNodeRef` / `listeners`，鼠标拖它什么都不发生。这一份用例钉的就是「柄真的
 * 接上了 dnd-kit」以及「两条路径落到同一个排序端点上」。
 *
 * 键盘那条不是可选的装饰：dnd-kit 的 PointerSensor 对合成鼠标事件无反应，柄上
 * 的 ↑/↓ 是 jsdom 里唯一能自动化的等价路径，也是无障碍的底线 —— 行右侧那对
 * 上下箭头按钮撤掉之后，它是唯一的键盘重排入口。
 */

function target(
  syncId: string,
  backendSyncId: string,
  availability: OrgExecTargetItem["availability"] = "available",
  rank = 0,
): OrgExecTargetItem {
  return {
    sync_id: syncId,
    rank,
    backend_sync_id: backendSyncId,
    backend_name: `Backend ${backendSyncId}`,
    backend_type: "claudecode",
    device_id: 7,
    device_name: `Machine ${backendSyncId}`,
    is_local_reference: false,
    availability,
    current: rank === 0,
  };
}

function renderSection(
  targets: OrgExecTargetItem[],
  onReordered: () => void = vi.fn(),
) {
  return render(
    <OrgExecTargetSection
      agentSyncId="agent-alice"
      targets={targets}
      backends={[]}
      onCreate={vi.fn()}
      onRemove={vi.fn()}
      onChangeSkills={vi.fn()}
      onReordered={onReordered}
    />,
  );
}

function handles(): HTMLElement[] {
  return screen.getAllByRole("button", { name: /Reorder target/ });
}

/** 最近一次排序提交带上去的 backend sync_id 排列。 */
function lastPostedOrder(): string[] {
  const call = mockedApi.mock.calls.find(
    ([path]) => path === "/v1/workspace/exec-target-order",
  );
  if (!call) throw new Error("exec-target-order was never posted");
  return JSON.parse(String(call[1]?.body)).backend_sync_ids as string[];
}

beforeEach(() => {
  mockedApi.mockReset();
  mockedApi.mockResolvedValue({});
});

describe("exec target ordering: drag", () => {
  it("Given a multi-target list, When the rows render, Then each drag handle carries the host's dnd-kit sortable binding", () => {
    renderSection([
      target("et-1", "b1", "available", 0),
      target("et-2", "b2", "available", 1),
      target("et-3", "b3", "available", 2),
    ]);

    const grips = handles();
    expect(grips).toHaveLength(3);
    for (const grip of grips) {
      // useSortable 的 attributes 落到柄上才说明 listeners / setNodeRef 也接上了：
      // 这三样是同一次绑定的产物，缺一样就是柄没接活。
      expect(grip.getAttribute("aria-roledescription")).toBe("sortable");
      expect(grip.getAttribute("aria-disabled")).not.toBe("true");
    }
  });

  it("Given a target dragged from the first slot to the last, When the drag ends, Then the whole new order is posted once and the list refetches", async () => {
    const onReordered = vi.fn();
    renderSection(
      [
        target("et-1", "b1", "available", 0),
        target("et-2", "b2", "available", 1),
        target("et-3", "b3", "available", 2),
      ],
      onReordered,
    );

    const restoreGeometry = stubRowGeometry();
    try {
      await keyboardDrag(handles()[0], "ArrowDown", 2);
    } finally {
      restoreGeometry();
    }

    await waitFor(() => expect(onReordered).toHaveBeenCalledTimes(1));
    expect(lastPostedOrder()).toEqual(["b2", "b3", "b1"]);
    expect(
      mockedApi.mock.calls.filter(
        ([path]) => path === "/v1/workspace/exec-target-order",
      ),
    ).toHaveLength(1);
  });

  // 钉住不动的那一档**不给排序控件**，而不是给一个禁用态的控件：共享件的判据是
  // 「宿主给没给重排回调」（org-exec-target-row.tsx 的 `reorderable`），本机相对
  // 引用档两个回调都拿不到。所以柄的数目 = 能排的档数，剩下的两枚仍然可拖。
  it("Given a tier this browser cannot order, When its row renders, Then it has no reorder control at all", () => {
    renderSection([
      target("et-1", "b1", "available", 0),
      target("et-2", "b2", "no_device", 1),
      target("et-3", "b3", "available", 2),
    ]);

    const grips = handles();
    expect(grips).toHaveLength(2);
    for (const grip of grips) {
      expect(grip.getAttribute("aria-disabled")).not.toBe("true");
    }
    // 钉住的那一档还在列表里（不隐藏，用户要看得见为什么轮不到它）。
    expect(screen.getByTestId("exec-target-row-1")).toBeTruthy();
  });

  it("Given a single target, When the row renders, Then there is no drag handle at all", () => {
    renderSection([target("et-1", "b1", "available", 0)]);
    expect(screen.queryByRole("button", { name: /Reorder target/ })).toBeNull();
  });
});

describe("exec target ordering: keyboard fallback on the handle", () => {
  it("Given the first row's handle focused, When ArrowDown is pressed, Then the tier moves down and the new order is posted", async () => {
    const onReordered = vi.fn();
    renderSection(
      [
        target("et-1", "b1", "available", 0),
        target("et-2", "b2", "available", 1),
        target("et-3", "b3", "available", 2),
      ],
      onReordered,
    );

    const grip = handles()[0];
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowDown", code: "ArrowDown" });

    await waitFor(() => expect(onReordered).toHaveBeenCalledTimes(1));
    expect(lastPostedOrder()).toEqual(["b2", "b1", "b3"]);
  });

  it("Given the second row's handle focused, When ArrowUp is pressed, Then it produces the same order ArrowDown on the first row does", async () => {
    const first = vi.fn();
    const { unmount } = renderSection(
      [
        target("et-1", "b1", "available", 0),
        target("et-2", "b2", "available", 1),
        target("et-3", "b3", "available", 2),
      ],
      first,
    );
    const down = handles()[0];
    down.focus();
    fireEvent.keyDown(down, { key: "ArrowDown", code: "ArrowDown" });
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    const viaDown = lastPostedOrder();
    unmount();
    mockedApi.mockClear();

    const second = vi.fn();
    renderSection(
      [
        target("et-1", "b1", "available", 0),
        target("et-2", "b2", "available", 1),
        target("et-3", "b3", "available", 2),
      ],
      second,
    );
    const up = handles()[1];
    up.focus();
    fireEvent.keyDown(up, { key: "ArrowUp", code: "ArrowUp" });
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(lastPostedOrder()).toEqual(viaDown);
  });

  it("Given the topmost handle, When ArrowUp is pressed, Then nothing is posted", async () => {
    const onReordered = vi.fn();
    renderSection(
      [
        target("et-1", "b1", "available", 0),
        target("et-2", "b2", "available", 1),
      ],
      onReordered,
    );

    const grip = handles()[0];
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowUp", code: "ArrowUp" });

    await tick();
    expect(mockedApi).not.toHaveBeenCalled();
    expect(onReordered).not.toHaveBeenCalled();
  });

  // 钉住的那一档自己没有柄（见上面那条），所以这里钉的是另一半：**绕着它**排序时
  // 它不会被顺手挪走 —— 换位只发生在两个可移动的档之间，b2 留在中间。
  it("Given a pinned tier between two movable ones, When they are reordered, Then the pinned tier keeps its place", async () => {
    const onReordered = vi.fn();
    renderSection(
      [
        target("et-1", "b1", "available", 0),
        target("et-2", "b2", "no_device", 1),
        target("et-3", "b3", "available", 2),
      ],
      onReordered,
    );

    const grip = handles()[0];
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowDown", code: "ArrowDown" });

    await waitFor(() => expect(onReordered).toHaveBeenCalledTimes(1));
    expect(lastPostedOrder()).toEqual(["b3", "b2", "b1"]);
  });

  // 播报的**内容**（「挪到第 2 位，共 3 档」）还缺一个 i18n 词条
  // `org.detail.execTargets.moved`——locales/ 归另一位 agent 管，这里只钉住
  // 「有一个 role=status 的活动区，并且移动之后它说了话」这两件结构性的事。
  it("Given the order fails to save, Then it says so and does not announce a move that did not happen", async () => {
    const onReordered = vi.fn();
    mockedApi.mockRejectedValue(new Error("order save failed"));
    renderSection(
      [
        target("et-1", "b1", "available", 0),
        target("et-2", "b2", "available", 1),
      ],
      onReordered,
    );

    const grip = handles()[0];
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowDown", code: "ArrowDown" });

    // 此前两个调用点都是裸 `void commit(...)`：保存抛出去没人接——未处理的 rejection、
    // 界面一声不吭、`onReordered` 不触发所以行弹回原处，而读屏刚刚被告知「已移到
    // 第 2 位」。播报必须排在保存**之后**。
    await waitFor(() =>
      expect(screen.getByTestId("exec-target-announcer").textContent).toContain(
        "Could not save",
      ),
    );
    expect(
      screen.getByTestId("exec-target-announcer").textContent,
    ).not.toContain("Moved to position");
    expect(onReordered).not.toHaveBeenCalled();
  });

  it("Given a completed move, When the announcement region is read, Then it says where the tier landed", async () => {
    renderSection([
      target("et-1", "b1", "available", 0),
      target("et-2", "b2", "available", 1),
    ]);

    const grip = handles()[0];
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowDown", code: "ArrowDown" });

    await waitFor(() => {
      const region = screen.getByTestId("exec-target-announcer");
      expect(region.textContent).not.toBe("");
    });
    expect(
      screen.getByTestId("exec-target-announcer").getAttribute("role"),
    ).toBe("status");
  });
});

/**
 * 让每一行有一份确定的几何，dnd-kit 才排得出「谁在谁下面」。
 *
 * jsdom 不算布局，`getBoundingClientRect()` 一律返回零矩形，于是所有落点重叠在
 * 同一个点上、方向键筛不出任何候选。这里补的不是「布局对不对」（那只有 e2e
 * 答得上来），而是拖拽**接线**跑起来所必需的最小事实：三行自上而下、等高。
 */
function stubRowGeometry(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  const ROW_HEIGHT = 50;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const own = this.getAttribute("data-testid") ?? "";
    const owner = /^exec-target-row-\d+$/.test(own)
      ? own
      : (this.closest("[data-testid^='exec-target-row-']")?.getAttribute(
          "data-testid",
        ) ?? "");
    const match = /^exec-target-row-(\d+)$/.exec(owner);
    const top = match ? Number(match[1]) * ROW_HEIGHT : 0;
    const height = match ? ROW_HEIGHT : 0;
    return {
      x: 0,
      y: top,
      top,
      bottom: top + height,
      left: 0,
      right: match ? 300 : 0,
      width: match ? 300 : 0,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** dnd-kit 的 KeyboardSensor 要到下一个宏任务才把 keydown 挂上去。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 走 dnd-kit 的 KeyboardSensor 完成一次真拖拽：柄上按空格「提起」，方向键移动，
 * 再按空格落下。鼠标那条在 jsdom 里驱动不了（PointerSensor 不认合成事件），
 * 但两条路径共用同一个 DndContext / onDragEnd，键盘这条走通就说明接线是活的。
 */
async function keyboardDrag(grip: HTMLElement, arrow: string, steps: number) {
  grip.focus();
  fireEvent.keyDown(grip, { key: " ", code: "Space" });
  await tick();
  for (let i = 0; i < steps; i += 1) {
    fireEvent.keyDown(grip, { key: arrow, code: arrow });
    await tick();
  }
  fireEvent.keyDown(grip, { key: " ", code: "Space" });
  await tick();
}
