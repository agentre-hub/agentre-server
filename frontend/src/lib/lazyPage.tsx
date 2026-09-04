import { useEffect, useState, type ComponentType } from "react";

type PageModule = { default: ComponentType };

/** 按路由切出去的页：既能当组件渲染，也能提前把模块取回来。 */
export type PreloadablePage = ComponentType & { preload: () => Promise<void> };

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
 * 每页各自缓存已取回的模块：来回切页不重下，也不会每次都先闪一下占位。**首次**
 * 那一下靠 `preload()` 抹平——见 `warmPages`。
 */
export function lazyPage(load: () => Promise<PageModule>): PreloadablePage {
  let loaded: PageModule | null = null;
  // 预热与渲染可能同时想要这份模块，谁先来谁发起，另一个搭同一趟车。
  let inflight: Promise<PageModule> | null = null;

  function fetchOnce(): Promise<PageModule> {
    if (loaded) return Promise.resolve(loaded);
    inflight ??= load().then((m) => {
      loaded = m;
      return m;
    });
    return inflight;
  }

  function LazyPage() {
    const [mod, setMod] = useState<PageModule | null>(loaded);
    useEffect(() => {
      if (loaded) return;
      let alive = true;
      void fetchOnce().then((m) => {
        if (alive) setMod(m);
      });
      return () => {
        alive = false;
      };
    }, []);
    // 占位刻意是空的：页面自己带 AppShell，这里画任何骨架都会先摆出一个和真页面
    // 对不上的外壳、再整个换掉，比空一瞬更晃眼。预热过之后这一支根本走不到。
    if (!mod) return null;
    return <mod.default />;
  }

  return Object.assign(LazyPage, {
    preload: () => fetchOnce().then(() => undefined),
  });
}

/**
 * 趁浏览器空闲把这几页取回来。
 *
 * 切包省下的是首屏，代价落在**第一次**切过去的那一下：页面自己带 AppShell，模块
 * 没到手时 `lazyPage` 渲染的 `null` 空掉的是整个视口——侧边栏、顶栏一起没——所以
 * 那一下看着是「空屏」而不是「在加载」。对话页 chunk 加上它静态依赖的
 * SessionDetailView，线上是 ~308 KB（gzip）要下完才有第一帧。
 *
 * 预热就是把这段等待挪到用户还在看别的页的时候。**排进空闲回调而不是直接开下**：
 * 当前页自己的取数要先跑完，预热是白赚的，不该跟它抢。Safari 16.4 以下没有
 * `requestIdleCallback`，退回定时器——晚一点总比让首屏多背 308 KB 好。
 *
 * 返回退订函数：还没跑的空闲回调在卸载时撤掉。
 */
export function warmPages(
  pages: { preload: () => Promise<unknown> }[],
): () => void {
  const run = () => {
    for (const page of pages) void page.preload();
  };

  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(run, { timeout: 2000 });
    return () => {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
    };
  }

  const timer = setTimeout(run, 1);
  return () => clearTimeout(timer);
}
