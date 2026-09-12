/**
 * 拖拽的**手势**属于宿主：共享包只收算好的视觉态（残影 / 目标列高亮），这里是本站
 * 那一半的实现。
 *
 * 用浏览器原生 HTML5 拖放而不是本仓已有的 dnd-kit：包里画卡片的是 `BoardColumn`，
 * 宿主拿不到每张卡的渲染时机，`useDraggable` 这类**每张卡一支 hook** 的库因此挂不
 * 上去（卡片数一变就是「渲染了比上一次更多的 hook」）。原生拖放的绑定是纯数据，
 * 正好穿得过 `BoardDragBindings` 这条缝；列的落点监听经 `setNodeRef` 挂在真实节点上。
 */
import * as React from "react";

import {
  BOARD_STAGES,
  type BoardDragBindings,
  type BoardStage,
} from "@agentre-hub/agentre-ui";

export interface UseBoardDragResult {
  bindings: BoardDragBindings;
}

/** 落点在这一列的哪两张卡之间：返回它上面那张卡的 id（0 = 落在列顶）。 */
function afterIdAt(column: HTMLElement, clientY: number, dragged: number) {
  const cards = [...column.querySelectorAll("[data-card-id]")]
    .map((node) => ({
      id: Number((node as HTMLElement).dataset.cardId),
      rect: node.getBoundingClientRect(),
    }))
    .filter((card) => card.id !== dragged);

  let afterId = 0;
  for (const card of cards) {
    if (clientY > card.rect.top + card.rect.height / 2) afterId = card.id;
  }
  return afterId;
}

export function useBoardDrag(
  onMove: (id: number, stage: BoardStage, afterId: number) => void,
): UseBoardDragResult {
  const [dragging, setDragging] = React.useState<number | null>(null);
  const [over, setOver] = React.useState<BoardStage | null>(null);
  // 落点计算发生在原生事件回调里（不是 React 的 onDrop），闭包里必须读到最新的
  // 被拖卡片，否则第二次拖拽还在用第一次的 id。
  const draggingRef = React.useRef<number | null>(null);
  const onMoveRef = React.useRef(onMove);
  React.useEffect(() => {
    onMoveRef.current = onMove;
  });

  const setNodeRef = React.useMemo(() => {
    const cleanups = new Map<BoardStage, () => void>();

    return (stage: BoardStage) => (node: HTMLElement | null) => {
      cleanups.get(stage)?.();
      cleanups.delete(stage);
      if (!node) return;

      const onDragOver = (event: DragEvent) => {
        if (draggingRef.current === null) return;
        // 不 preventDefault 的元素不是合法落点，浏览器连 drop 都不会发。
        event.preventDefault();
        setOver(stage);
      };
      const onDragLeave = () =>
        setOver((current) => (current === stage ? null : current));
      const onDrop = (event: DragEvent) => {
        const id = draggingRef.current;
        if (id === null) return;
        event.preventDefault();
        onMoveRef.current(id, stage, afterIdAt(node, event.clientY, id));
        draggingRef.current = null;
        setDragging(null);
        setOver(null);
      };

      node.addEventListener("dragover", onDragOver);
      node.addEventListener("dragleave", onDragLeave);
      node.addEventListener("drop", onDrop);
      cleanups.set(stage, () => {
        node.removeEventListener("dragover", onDragOver);
        node.removeEventListener("dragleave", onDragLeave);
        node.removeEventListener("drop", onDrop);
      });
    };
  }, []);

  // 四列的 ref 回调必须逐列稳定：每次渲染换一个新函数会让 React 先以 null 卸载、
  // 再重新挂载，拖到一半的那一列监听会就此丢掉。
  const columnRefs = React.useMemo(
    () =>
      Object.fromEntries(
        BOARD_STAGES.map((stage) => [stage, setNodeRef(stage)]),
      ) as Record<BoardStage, (node: HTMLElement | null) => void>,
    [setNodeRef],
  );

  const bindings = React.useMemo<BoardDragBindings>(
    () => ({
      card: (cardId) => ({
        attributes: {
          draggable: true,
          // 落点计算要按真实位置排序，卡片得先认得出自己是谁。
          "data-card-id": cardId,
        } as React.HTMLAttributes<HTMLElement>,
        listeners: {
          onDragStart: (event: React.DragEvent) => {
            event.dataTransfer?.setData("text/plain", String(cardId));
            draggingRef.current = cardId;
            setDragging(cardId);
          },
          onDragEnd: () => {
            draggingRef.current = null;
            setDragging(null);
            setOver(null);
          },
        },
        // 原生拖放里被拖起的那一张由浏览器画拖影，原位这一张就是残影。
        state: dragging === cardId ? "ghost" : undefined,
      }),
      column: (stage) => ({
        setNodeRef: columnRefs[stage],
        dropState: over === stage ? "over" : undefined,
      }),
    }),
    [columnRefs, dragging, over],
  );

  return { bindings };
}
