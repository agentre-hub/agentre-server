import { useEffect, useState, type ComponentType } from "react";

type PageModule = { default: ComponentType };

/**
 * 按路由切包：把一整页连同它底下那些只有它用得上的重依赖挪出入口 chunk。
 *
 * 会话那两页（详情与对话）背后是整套转录渲染——代码块高亮的 highlight.js、渲染
 * bash 输出的 xterm、以及整张规范工具卡注册表。登录、总览、设备、组织这些页一次
 * 都碰不到它们，却要连它们一起下完才开得了屏。这份产物还要 //go:embed 进 Go
 * 二进制，切出去的每 KB 都是首屏实打实少下的。
 *
 * **不用 React.lazy + Suspense**，理由与 SessionDetailView 里那段完全相同：
 * Suspense 揭示内容走 Offscreen 的 `reappearLayoutEffects` 路径会把子树 effect
 * 重跑一遍，而这两页底下正是那个受不了重跑的 TipTap 输入框。直接 `import()` 到
 * state 里再渲染就没有「揭示」这一步。
 *
 * 每页各自缓存已取回的模块：来回切页不重下，也不会每次都先闪一下占位。
 */
export function lazyPage(load: () => Promise<PageModule>): ComponentType {
  let loaded: PageModule | null = null;

  return function LazyPage() {
    const [mod, setMod] = useState<PageModule | null>(loaded);
    useEffect(() => {
      if (loaded) return;
      let alive = true;
      void load().then((m) => {
        loaded = m;
        if (alive) setMod(m);
      });
      return () => {
        alive = false;
      };
    }, []);
    // 占位刻意是空的：页面自己带 AppShell，这里画任何骨架都会先摆出一个和真页面
    // 对不上的外壳、再整个换掉，比空一瞬更晃眼。
    if (!mod) return null;
    return <mod.default />;
  };
}
