import { useEffect, useState } from "react";

/**
 * 视口是否为移动端（≤767px，Tailwind 的 md 断点以下）。
 *
 * 决策 10 / 12 / 16：同一套能力在桌面与移动上是**两种形态**——列表分组
 * （Agent vs 状态）、关注入口（列表行 vs 详情顶栏）、导航（固定侧栏 vs 抽屉）
 * 都随视口切换，因此组件需要在 JS 里知道视口，而不只是靠 CSS。
 *
 * 只在挂载时读一次 + 监听 change：测试里把 matchMedia mock 成移动视口即可
 * 让组件走移动形态（setup.ts 的默认 mock 恒返回 false = 桌面，既有测试不受影响）。
 */
const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.matchMedia(MOBILE_QUERY).matches
      : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
