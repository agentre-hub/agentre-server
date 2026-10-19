/**
 * 元素自身及其所有后代上画结构线的边宽类（含变体前缀）：`border`、`border-t`、
 * `hover:border`、`divide-y` 等。带宽度的状态色条（`border-l-2`）不在此列。
 *
 * 无边框改版的宿主用例拿它断言「这一块没画线」。border 那一半与共享包
 * `packages/agentre-ui/src/lib/__testing__/edge-classes.ts` 同一条判据，改一边就改另一边；
 * 这里另外收 `divide-*`（那份不收）——宿主的结构线 lint 也拦它（DIVIDE_UTILITY），
 * 用例因此不该放过它。
 */
export function edgeClasses(root: Element): string[] {
  return [root, ...Array.from(root.querySelectorAll("*"))].flatMap((el) =>
    Array.from(el.classList).filter((c) =>
      /^(?:[\w-]+:)*(?:border(?:-[tblrxy])?|divide(?:-[xy])?)$/.test(c),
    ),
  );
}
