import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 安装性契约守卫。
 *
 * manifest 与 index.html 的头部是「安装入口」这件事的全部实现，但它们都不经过
 * 任何构建期类型检查：改错一个键、引一张不存在的图，肉眼看上去和正确的一模一样，
 * 浏览器只是在后台把「添加到主屏幕」悄悄拿掉。这条守卫读真实文件，把安装所必需的
 * 那几项钉死：
 *
 * - name / short_name / start_url / display 在允许集合里；
 * - 192 与 512 图标都存在，且 src 指向的 PNG 真的在磁盘上；
 * - 没有 prefer_related_applications（它会改变安装语义）；
 * - index.html 里 manifest / apple-touch-icon / theme-color / viewport-fit 都在；
 * - index.html 里没有 user-scalable=no / maximum-scale —— Safari 标签页必须能缩放；
 *   只有从主屏幕打开（standalone）时才由 src/lib/standaloneZoomLock.ts 在运行时禁掉。
 *
 * 文件名与语义的细节见 docs/design.md 的 PWA 小节。真正的浏览器安装行为（尤其
 * iOS 的「添加到主屏幕」）没有任何 jsdom 用例能覆盖，只能上真机。
 */
const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const readFrontendFile = (relative: string) =>
  fs.readFileSync(path.join(FRONTEND_ROOT, relative), "utf8");

const manifest = JSON.parse(
  readFrontendFile("public/manifest.webmanifest"),
) as {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  icons?: { src?: string; sizes?: string; type?: string; purpose?: string }[];
  prefer_related_applications?: boolean;
  theme_color?: string;
  background_color?: string;
};

const indexHtml = readFrontendFile("index.html");
const offlineHtml = readFrontendFile("public/offline.html");

/**
 * 共享包的 tokens.css 是色值的唯一真源（见 design-token-contract.test.ts）。public/
 * 下的离线页与 index.html 的启动壳是纯 HTML，用不了 Tailwind 与包的样式表，只能把
 * 用到的那几个 token 以**同名自定义属性**抄一份——这里逐个对回包里的值，包一改、
 * 这两份没跟上就红。
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取出一个 CSS 块的内容；选择器按行首（允许缩进）锚定，块尾按花括号计数。 */
function blockIn(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^\\s*${escaped}\\s*\\{`, "m").exec(source);
  if (!head) return "";
  const open = head.index + head[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(open + 1, i);
  }
  return "";
}

function decls(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
  return out;
}

const packageCss = stripComments(
  readFrontendFile("node_modules/@agentre-hub/agentre-ui/styles/tokens.css"),
);
const packageRoot = decls(blockIn(packageCss, ":root"));
const packageDark = decls(blockIn(packageCss, ".dark"));

const ALLOWED_DISPLAY = ["standalone", "fullscreen", "minimal-ui", "browser"];
const ALLOWED_START_URL = ["/", "./", "/index.html"];

describe("PWA 安装契约", () => {
  it("name 与 short_name 是同一份可读的品牌名", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(typeof manifest.name).toBe("string");
    expect(typeof manifest.short_name).toBe("string");
  });

  it("start_url 与 display 落在允许集合里", () => {
    expect(ALLOWED_START_URL).toContain(manifest.start_url);
    expect(ALLOWED_DISPLAY).toContain(manifest.display);
  });

  it("同时有 192 与 512 的 any 与 maskable 图标，且文件真实存在", () => {
    const icons = manifest.icons ?? [];
    const find = (sizes: string, purpose: string) =>
      icons.find((icon) => icon.sizes === sizes && icon.purpose === purpose);

    for (const [sizes, purpose] of [
      ["192x192", "any"],
      ["512x512", "any"],
      ["192x192", "maskable"],
      ["512x512", "maskable"],
    ] as const) {
      const icon = find(sizes, purpose);
      expect(icon, `manifest 缺少 ${sizes} 的 ${purpose} 图标`).toBeTruthy();
      expect(icon?.type).toBe("image/png");
      expect(icon?.src?.startsWith("/")).toBe(true);
      const onDisk = path.join(
        FRONTEND_ROOT,
        "public",
        icon!.src!.replace(/^\//, ""),
      );
      expect(
        fs.existsSync(onDisk),
        `${icon?.src} 在磁盘上不存在：${onDisk}`,
      ).toBe(true);
    }
  });

  it("不声明 prefer_related_applications", () => {
    expect(manifest).not.toHaveProperty("prefer_related_applications");
  });

  it("index.html 声明了 manifest 与 apple-touch-icon", () => {
    expect(indexHtml).toMatch(
      /<link[^>]*rel="manifest"[^>]*href="\/manifest\.webmanifest"/,
    );
    expect(indexHtml).toMatch(
      /<link[^>]*rel="apple-touch-icon"[^>]*href="\/icons\/apple-touch-icon-180\.png"/,
    );
  });

  it("index.html 为深浅两色各给一条 theme-color，取的是页面底色 token", () => {
    const themeColor = (scheme: string) =>
      indexHtml.match(
        new RegExp(
          `<meta[^>]*name="theme-color"[^>]*media="\\(prefers-color-scheme: ${scheme}\\)"[^>]*content="([^"]+)"`,
        ),
      )?.[1];
    expect(themeColor("light")).toBe(packageRoot["--background"]);
    expect(themeColor("dark")).toBe(packageDark["--background"]);
  });

  it("manifest 的启动底色与主题色就是页面底色（浅色），不再是品牌深蓝", () => {
    const light = packageRoot["--background"];
    expect(manifest.theme_color?.toLowerCase()).toBe(light);
    expect(manifest.background_color?.toLowerCase()).toBe(light);
  });

  it("viewport 带 viewport-fit=cover 好让安全区变量有值", () => {
    const viewport = indexHtml.match(
      /<meta[^>]*name="viewport"[^>]*content="([^"]*)"/,
    );
    expect(viewport).toBeTruthy();
    expect(viewport![1]).toContain("viewport-fit=cover");
  });

  // iOS 26 起，主屏幕 App 顶部有一层系统的边缘模糊，原生 App 的导航栏会被它让开，网页
  // 只有在 WebKit 认出顶边有一条 fixed/sticky 的全宽容器时才会被换成实色——而这套判定
  // 只在状态栏是 default 时才开，black-translucent 会把它整个关掉（真机对照见
  // docs/design.md 的 PWA 小节）。所以这一行不能再是 black-translucent。
  it("状态栏样式是 default，好让 iOS 用实色替换顶部的系统模糊", () => {
    const style = indexHtml.match(
      /<meta[^>]*name="apple-mobile-web-app-status-bar-style"[^>]*content="([^"]*)"/,
    );
    expect(style).toBeTruthy();
    expect(style![1]).toBe("default");
  });

  it("静态 viewport 不禁止缩放：没有 user-scalable=no，也没有 maximum-scale（只在 standalone 里运行时改写）", () => {
    expect(indexHtml).not.toContain("user-scalable=no");
    expect(indexHtml).not.toContain("maximum-scale");
  });
});

describe("public/ 下的纯 HTML 与 token 同步", () => {
  const styleOf = (html: string) =>
    stripComments(
      [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1])
        .join("\n"),
    );

  it("包的 tokens.css 读得到（读不到的话下面的断言全是假绿）", () => {
    expect(packageRoot["--background"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(packageDark["--background"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each([
    ["index.html", indexHtml],
    ["public/offline.html", offlineHtml],
  ])(
    "%s：:root 与 .dark 里抄的每个 token 都与包里同名同值，样式里没有别的色值字面量",
    (_name, html) => {
      const css = styleOf(html);
      const light = decls(blockIn(css, ":root"));
      const dark = decls(blockIn(css, ".dark"));

      expect(Object.keys(light).length).toBeGreaterThan(0);
      expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
      for (const [token, value] of Object.entries(light)) {
        expect(value, `${token}（浅色）`).toBe(packageRoot[token]);
      }
      for (const [token, value] of Object.entries(dark)) {
        expect(value, `${token}（深色）`).toBe(packageDark[token]);
      }

      // 去掉这两块之后不该再有任何 #hex：颜色只能经 var(--token) 取。
      const rest = css
        .replace(blockIn(css, ":root"), "")
        .replace(blockIn(css, ".dark"), "");
      expect(rest.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);

      // 用到的变量都要有声明：引用一个只在应用样式表里才有的 token 会静默失效。
      const used = new Set(
        [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]),
      );
      for (const token of used) {
        expect(light, `${token} 被引用却没声明`).toHaveProperty([token]);
      }
    },
  );
});

/**
 * 在一份 HTML 上跑它自己的内联脚本。
 *
 * 脚本是 public/ 与 index.html 里的纯 JS，不经打包器。这里把它们的原文按顺序交给
 * `new Function`，全局（document、location、fetch……）由用例注入——被测的是线上
 * 那份文件本身。
 */
function runInlineScripts(
  html: string,
  globals: Record<string, unknown>,
): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const names = ["document", ...Object.keys(globals)];
  const values = [doc, ...Object.values(globals)];
  for (const script of doc.querySelectorAll("script:not([src])")) {
    new Function(...names, script.textContent ?? "")(...values);
  }
  return doc;
}

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function fakeWindow(opts: { dark?: boolean } = {}) {
  const target = new EventTarget();
  return Object.assign(target, {
    matchMedia: (query: string) => ({
      matches: query.includes("dark") ? Boolean(opts.dark) : false,
    }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("离线页（规格 B3）", () => {
  function openOffline(
    opts: {
      reason?: "offline" | "server";
      language?: string;
      fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    } = {},
  ) {
    const html = offlineHtml.replace(
      'data-reason="offline"',
      `data-reason="${opts.reason ?? "offline"}"`,
    );
    const location = { reload: vi.fn() };
    const fetchFn = vi.fn(
      opts.fetch ?? (() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const win = fakeWindow();
    const doc = runInlineScripts(html, {
      window: win,
      location,
      navigator: { language: opts.language ?? "zh-CN" },
      fetch: fetchFn,
      localStorage: memoryStorage(),
    });
    return { doc, location, fetch: fetchFn, win };
  }

  // 只看屏上的那一块：body 里还有脚本原文（两种语言的文案都在里面）。
  const text = (doc: Document) => doc.querySelector("main")?.textContent ?? "";

  it("断网：只说一种语言，「没有网络 · 网络恢复后会自动回来」", () => {
    vi.useFakeTimers();
    const { doc } = openOffline();

    expect(text(doc)).toContain("没有网络");
    expect(text(doc)).toContain("网络恢复后会自动回来");
    expect(text(doc)).not.toMatch(/network/i);
  });

  it("英文环境给英文，不再中英并排", () => {
    vi.useFakeTimers();
    const { doc } = openOffline({ language: "en-US" });

    expect(text(doc)).toMatch(/offline/i);
    expect(text(doc)).not.toMatch(/[一-鿿]/);
  });

  it("5xx 变体：「服务器暂时不可用」", () => {
    vi.useFakeTimers();
    const { doc } = openOffline({ reason: "server" });

    expect(text(doc)).toContain("服务器暂时不可用");
    expect(text(doc)).not.toContain("没有网络");
  });

  it("一联网就探测，通了自动 reload 回原地址（地址栏里本来就是原地址）", async () => {
    vi.useFakeTimers();
    const { win, location, fetch, doc } = openOffline({
      fetch: async () => new Response("<!doctype html>", { status: 200 }),
    });

    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetch).toHaveBeenCalledWith(
      "/",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(text(doc)).toContain("网络恢复了");
  });

  it("不靠 online 事件也定期探测；探到 5xx 不回，等下一次", async () => {
    vi.useFakeTimers();
    let status = 502;
    const { location, fetch } = openOffline({
      reason: "server",
      fetch: async () => new Response("", { status }),
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(location.reload).not.toHaveBeenCalled();

    status = 200;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it("「重试」按钮点按区不小于 44px，按下即 reload", () => {
    vi.useFakeTimers();
    const { doc, location } = openOffline();

    const button = doc.querySelector("button");
    expect(button?.textContent).toContain("重试");
    const rule = blockIn(stripComments(offlineHtml), "button");
    expect(rule).toMatch(/min-height:\s*44px/);

    button!.click();
    expect(location.reload).toHaveBeenCalledTimes(1);
  });
});

describe("index.html 的启动壳（规格 B2、W31）", () => {
  function boot(
    opts: {
      language?: string;
      storage?: Record<string, string>;
      dark?: boolean;
    } = {},
  ) {
    const frames: FrameRequestCallback[] = [];
    const doc = runInlineScripts(indexHtml, {
      window: fakeWindow({ dark: opts.dark }),
      navigator: { language: opts.language ?? "zh-CN" },
      localStorage: memoryStorage(opts.storage),
      requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb),
    });
    const flushFrames = () => {
      while (frames.length) frames.shift()!(0);
    };
    return { doc, flushFrames };
  }

  /** 等 MutationObserver 的回调（微任务）跑完，再把排着的动画帧一帧帧放掉。 */
  async function paint(flushFrames: () => void) {
    await Promise.resolve();
    flushFrames();
    flushFrames();
  }

  it("壳在 #root 之外、并且就是首页的形状（页头 + 筛选条 + 列表骨架）", () => {
    vi.useFakeTimers();
    const { doc } = boot();
    const shell = doc.getElementById("boot-shell");

    expect(shell).toBeTruthy();
    expect(doc.getElementById("root")?.contains(shell)).toBe(false);
    expect(shell!.querySelector("[data-boot='header']")).toBeTruthy();
    expect(
      shell!.querySelectorAll("[data-boot='chip']").length,
    ).toBeGreaterThan(1);
    expect(shell!.querySelectorAll("[data-boot='row']").length).toBeGreaterThan(
      3,
    );
  });

  it("8 秒仍没起来，底部「网络较慢，仍在加载…」；8 秒之前不出", async () => {
    vi.useFakeTimers();
    const { doc } = boot();
    const shell = doc.getElementById("boot-shell")!;

    await vi.advanceTimersByTimeAsync(7_999);
    expect(shell.hasAttribute("data-slow")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(shell.hasAttribute("data-slow")).toBe(true);
    expect(shell.textContent).toContain("网络较慢，仍在加载…");
  });

  it("英文环境的那一行是英文", () => {
    vi.useFakeTimers();
    const { doc } = boot({ language: "en-US" });
    expect(doc.getElementById("boot-shell")!.textContent).toMatch(/slow/i);
    expect(doc.getElementById("boot-shell")!.textContent).not.toMatch(
      /[一-鿿]/,
    );
  });

  it("「加载中…」占位、空的通知区都不算第一屏：壳留着，不闪一下再空", async () => {
    vi.useFakeTimers();
    const { doc, flushFrames } = boot();
    const root = doc.getElementById("root")!;

    root.innerHTML =
      '<div class="flex min-h-screen">加载中…</div><section aria-label="Notifications"></section>';
    await paint(flushFrames);

    expect(doc.getElementById("boot-shell")).toBeTruthy();
  });

  it("第一屏画出来（有可操作的东西）之后才撤：撤在下一帧画完之后", async () => {
    vi.useFakeTimers();
    const { doc, flushFrames } = boot();
    const root = doc.getElementById("root")!;

    root.innerHTML = '<div data-testid="app-shell"><main>list</main></div>';
    await Promise.resolve();
    expect(doc.getElementById("boot-shell")).toBeTruthy();

    await paint(flushFrames);
    expect(doc.getElementById("boot-shell")).toBeNull();

    // 撤掉之后 8 秒那一行也不再冒出来（计时器已撤）。
    await vi.advanceTimersByTimeAsync(8_000);
  });

  it("深浅色跟着应用的主题偏好走，不跟错一帧", () => {
    vi.useFakeTimers();
    expect(
      boot({
        storage: { "agentre.theme": "dark" },
      }).doc.documentElement.classList.contains("dark"),
    ).toBe(true);
    expect(
      boot({
        storage: { "agentre.theme": "light" },
        dark: true,
      }).doc.documentElement.classList.contains("dark"),
    ).toBe(false);
    expect(
      boot({ dark: true }).doc.documentElement.classList.contains("dark"),
    ).toBe(true);
  });
});
