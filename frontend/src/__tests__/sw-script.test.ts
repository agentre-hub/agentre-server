import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * public/sw.js 的行为（规格 2026-11-25 决策 B1、B3）。
 *
 * sw.js 是一份 public/ 下的纯 JS，不经打包器、不能 import。这里把脚本原文读进来，
 * 用 `new Function` 在一组注入的假 `self` / `caches` / `fetch` 上执行一遍，再往
 * 它注册的监听器里派发事件——被测的是线上那份文件本身，不是一份手抄的实现。
 *
 * Response / Headers 用的是 Node 自带的那一份（jsdom 没有，vitest 原样留着）。
 */

const SW_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/sw.js",
);
const ORIGIN = "https://console.test";

/** 构建产物形状的外壳：入口脚本与样式都在 /assets/ 下、文件名带内容 hash。 */
function shellHtml(build: string): string {
  return [
    "<!doctype html><html><head>",
    `<script type="module" crossorigin src="/assets/index-${build}.js"></script>`,
    `<link rel="stylesheet" crossorigin href="/assets/index-${build}.css">`,
    `</head><body><div id="root"></div></body></html>`,
  ].join("");
}

const OFFLINE_HTML =
  '<!doctype html><html lang="zh-CN" data-reason="offline"><body>offline</body></html>';

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const keyOf = (input: string | { url: string }) =>
  new URL(typeof input === "string" ? input : input.url, ORIGIN).href;

/** 内存版 Cache：只实现 sw.js 用得到的那几个方法，语义照规范。 */
class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(input: string | { url: string }) {
    return this.entries.get(keyOf(input))?.clone();
  }
  async put(input: string | { url: string }, response: Response) {
    this.entries.set(keyOf(input), response);
  }
  async add(input: string) {
    const response = await net(input);
    if (!response.ok) throw new TypeError(`add ${input}: ${response.status}`);
    await this.put(input, response);
  }
  async addAll(inputs: string[]) {
    await Promise.all(inputs.map((input) => this.add(input)));
  }
  async text(input: string) {
    return (await this.match(input))?.text();
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();

  async open(name: string) {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return cache;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async match(input: string | { url: string }) {
    for (const cache of this.stores.values()) {
      const hit = await cache.match(input);
      if (hit) return hit;
    }
    return undefined;
  }
  /** 当前这一版 SW 自己的那一格（不管它叫什么名字，取唯一非旧的那个）。 */
  current(): FakeCache {
    const names = [...this.stores.keys()].filter(
      (name) => name !== "agentre-static-v1",
    );
    expect(names).toHaveLength(1);
    return this.stores.get(names[0])!;
  }
}

/** 网络：按路径应答；没登记的路径永远挂着（lie-fi 那种「连上了但没数据」）。 */
let routes: Map<string, () => Promise<Response>>;
const net = vi.fn(
  (input: string | { url: string }, _init?: RequestInit): Promise<Response> => {
    const url = new URL(keyOf(input));
    const route = routes.get(url.pathname);
    return route ? route() : new Promise<Response>(() => {});
  },
);

type Listener = (event: unknown) => void;
let listeners: Map<string, Listener>;
let caches: FakeCacheStorage;
let self: {
  location: URL;
  clients: { claim: ReturnType<typeof vi.fn> };
  skipWaiting: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, fn: Listener) => void;
};

function loadServiceWorker() {
  const source = fs.readFileSync(SW_PATH, "utf8");
  new Function("self", "caches", "fetch", "Response", "URL", source)(
    self,
    caches,
    net,
    Response,
    URL,
  );
}

interface Dispatched {
  respondedWith: Promise<Response> | undefined;
  lifetime: Promise<unknown>[];
}

function dispatchFetch(
  pathname: string,
  init: { mode?: string; method?: string; origin?: string } = {},
): Dispatched {
  const out: Dispatched = { respondedWith: undefined, lifetime: [] };
  listeners.get("fetch")!({
    request: {
      url: new URL(pathname, init.origin ?? ORIGIN).href,
      method: init.method ?? "GET",
      mode: init.mode ?? "no-cors",
    },
    respondWith(p: Promise<Response>) {
      out.respondedWith = Promise.resolve(p);
    },
    waitUntil(p: Promise<unknown>) {
      out.lifetime.push(p);
    },
  });
  return out;
}

const navigate = (pathname: string) =>
  dispatchFetch(pathname, { mode: "navigate" });

async function settle(d: Dispatched) {
  await Promise.all(d.lifetime);
}

async function install() {
  const lifetime: Promise<unknown>[] = [];
  listeners.get("install")!({
    waitUntil: (p: Promise<unknown>) => lifetime.push(p),
  });
  await Promise.all(lifetime);
}

async function activate() {
  const lifetime: Promise<unknown>[] = [];
  listeners.get("activate")!({
    waitUntil: (p: Promise<unknown>) => lifetime.push(p),
  });
  await Promise.all(lifetime);
}

/** 页面发来「查一下有没有新版本」，带上它自己跑的入口脚本。 */
async function askForUpdate(entry: string) {
  const source = { postMessage: vi.fn() };
  const lifetime: Promise<unknown>[] = [];
  listeners.get("message")!({
    data: { type: "check-update", entry },
    source,
    waitUntil: (p: Promise<unknown>) => lifetime.push(p),
  });
  await Promise.all(lifetime);
  return source.postMessage;
}

/** 已经装好、外壳是 build 这一版的 SW。 */
async function installedWith(build: string) {
  routes.set("/", async () => html(shellHtml(build)));
  routes.set("/offline.html", async () => html(OFFLINE_HTML));
  routes.set(`/assets/index-${build}.js`, async () => new Response("js"));
  routes.set(`/assets/index-${build}.css`, async () => new Response("css"));
  await install();
  await activate();
  net.mockClear();
}

/** 服务器上换成了 build 这一版：外壳与它引用的产物都取得到。 */
function newBuildOnServer(build: string) {
  routes.set("/", async () => html(shellHtml(build)));
  routes.set(`/assets/index-${build}.js`, async () => new Response("js2"));
  routes.set(`/assets/index-${build}.css`, async () => new Response("css2"));
}

beforeEach(() => {
  routes = new Map();
  listeners = new Map();
  caches = new FakeCacheStorage();
  net.mockClear();
  self = {
    location: new URL(ORIGIN),
    clients: { claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(),
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  loadServiceWorker();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sw.js 安装与激活", () => {
  it("安装时预存离线页、外壳与外壳引用的入口产物：首次装上之后断网也打得开", async () => {
    await installedWith("aaa");

    const cache = caches.current();
    expect(await cache.text("/offline.html")).toBe(OFFLINE_HTML);
    expect(await cache.text("/")).toBe(shellHtml("aaa"));
    expect(await cache.text("/assets/index-aaa.js")).toBe("js");
    expect(await cache.text("/assets/index-aaa.css")).toBe("css");
  });

  it("外壳取不到不拖垮安装：离线页在就算装好，外壳等下一次导航再存", async () => {
    routes.set("/offline.html", async () => html(OFFLINE_HTML));
    routes.set("/", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(install()).resolves.toBeUndefined();
    expect(await caches.current().text("/offline.html")).toBe(OFFLINE_HTML);
  });

  it("激活清掉旧版缓存并接管页面，但从不 skipWaiting", async () => {
    await (
      await caches.open("agentre-static-v1")
    ).put("/", html(shellHtml("old")));
    await installedWith("aaa");

    expect(await caches.keys()).not.toContain("agentre-static-v1");
    expect(self.clients.claim).toHaveBeenCalled();
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });
});

describe("sw.js 导航：有外壳缓存时缓存优先", () => {
  it("网络挂着也立即给缓存的外壳，任何应用路由都是同一份", async () => {
    await installedWith("aaa");
    routes.delete("/");

    const d = navigate("/chat/42?x=1");

    expect(await (await d.respondedWith!).text()).toBe(shellHtml("aaa"));
    expect(net).toHaveBeenCalled();
  });

  it("后台取回的新外壳写进缓存：下一次打开（重新加载）就是新版本", async () => {
    await installedWith("aaa");
    routes.set("/", async () => html(shellHtml("bbb")));
    routes.set("/chat", async () => html(shellHtml("bbb")));
    routes.set("/assets/index-bbb.js", async () => new Response("js2"));
    routes.set("/assets/index-bbb.css", async () => new Response("css2"));

    const d = navigate("/chat");
    expect(await (await d.respondedWith!).text()).toBe(shellHtml("aaa"));
    await settle(d);

    expect(await caches.current().text("/")).toBe(shellHtml("bbb"));
    expect(await caches.current().text("/assets/index-bbb.js")).toBe("js2");
  });

  it("后台拿到 5xx / 非 HTML 不覆盖缓存的外壳", async () => {
    await installedWith("aaa");
    routes.set("/chat", async () => html("<h1>502 Bad Gateway</h1>", 502));
    const d = navigate("/chat");
    await d.respondedWith;
    await settle(d);

    routes.set(
      "/chat",
      async () =>
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
    );
    const d2 = navigate("/chat");
    await d2.respondedWith;
    await settle(d2);

    expect(await caches.current().text("/")).toBe(shellHtml("aaa"));
  });
});

describe("sw.js 发现新版本：回答页面的 check-update", () => {
  it("服务器上的入口与页面正在跑的不同：回 update-available，并把新外壳存好", async () => {
    await installedWith("aaa");
    routes.set("/", async () => html(shellHtml("bbb")));
    routes.set("/assets/index-bbb.js", async () => new Response("js2"));
    routes.set("/assets/index-bbb.css", async () => new Response("css2"));

    const reply = await askForUpdate("/assets/index-aaa.js");

    expect(reply).toHaveBeenCalledWith({ type: "update-available" });
    expect(await caches.current().text("/")).toBe(shellHtml("bbb"));
    expect(await caches.current().text("/assets/index-bbb.js")).toBe("js2");
  });

  it("缓存已被导航那一路换成新版、页面仍是旧的：照样回 update-available", async () => {
    await installedWith("aaa");
    newBuildOnServer("bbb");
    routes.set("/chat", async () => html(shellHtml("bbb")));
    const d = navigate("/chat");
    await d.respondedWith;
    await settle(d);

    const reply = await askForUpdate("/assets/index-aaa.js");

    expect(reply).toHaveBeenCalledWith({ type: "update-available" });
  });

  it("新外壳的产物还在路上也先回答：提示条不等预存", async () => {
    await installedWith("aaa");
    routes.set("/", async () => html(shellHtml("bbb")));
    // /assets/index-bbb.* 没登记：这两个请求一直挂着。
    const source = { postMessage: vi.fn() };
    listeners.get("message")!({
      data: { type: "check-update", entry: "/assets/index-aaa.js" },
      source,
      waitUntil: () => {},
    });

    await vi.waitFor(() =>
      expect(source.postMessage).toHaveBeenCalledWith({
        type: "update-available",
      }),
    );
  });

  it("入口相同、或网络不通：一声不吭", async () => {
    await installedWith("aaa");
    expect(await askForUpdate("/assets/index-aaa.js")).not.toHaveBeenCalled();

    routes.set("/", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await askForUpdate("/assets/index-aaa.js")).not.toHaveBeenCalled();
  });

  it("查新版本绕过 HTTP 缓存", async () => {
    await installedWith("aaa");
    await askForUpdate("/assets/index-aaa.js");

    const call = net.mock.calls.find(([input]) => keyOf(input).endsWith("/"));
    expect(call?.[1]).toMatchObject({ cache: "no-store" });
  });
});

describe("sw.js 导航：没有外壳缓存（首次安装、缓存被清）", () => {
  async function withoutShell() {
    await installedWith("aaa");
    await caches.current().entries.delete(keyOf("/"));
  }

  it("10 秒拿不到页面退离线页；10 秒之前不退", async () => {
    await withoutShell();
    vi.useFakeTimers();

    const d = navigate("/chat/42");
    let settled = false;
    void d.respondedWith!.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const page = await (await d.respondedWith!).text();
    expect(page).toContain('data-reason="offline"');
  });

  it("超时之后网络才到：照样把外壳存下，下次就是缓存优先", async () => {
    await withoutShell();
    vi.useFakeTimers();
    let arrive!: (r: Response) => void;
    routes.set(
      "/chat",
      () =>
        new Promise<Response>((resolve) => {
          arrive = resolve;
        }),
    );

    newBuildOnServer("bbb");
    const d = navigate("/chat");
    await vi.advanceTimersByTimeAsync(10_000);
    await d.respondedWith;
    arrive(html(shellHtml("bbb")));
    await settle(d);

    expect(await caches.current().text("/")).toBe(shellHtml("bbb"));
  });

  it("5xx 退离线页的「服务器暂时不可用」变体", async () => {
    await withoutShell();
    routes.set("/chat", async () => html("<h1>502 Bad Gateway</h1>", 502));

    const page = await (await navigate("/chat").respondedWith!).text();

    expect(page).toContain('data-reason="server"');
    expect(page).not.toContain("Bad Gateway");
  });

  it("网络直接失败退离线页", async () => {
    await withoutShell();
    routes.set("/chat", () => Promise.reject(new TypeError("Failed to fetch")));

    const page = await (await navigate("/chat").respondedWith!).text();

    expect(page).toContain('data-reason="offline"');
  });

  it("及时拿到页面就原样交出并存为外壳", async () => {
    await withoutShell();
    routes.set("/chat", async () => html(shellHtml("aaa")));

    const d = navigate("/chat");
    expect(await (await d.respondedWith!).text()).toBe(shellHtml("aaa"));
    await settle(d);

    expect(await caches.current().text("/")).toBe(shellHtml("aaa"));
  });
});

describe("sw.js 不碰的请求", () => {
  it("/v1/、非 GET、跨源一律不调 respondWith", async () => {
    await installedWith("aaa");

    expect(navigate("/v1/auth/me").respondedWith).toBeUndefined();
    expect(dispatchFetch("/v1/devices").respondedWith).toBeUndefined();
    expect(
      dispatchFetch("/v1/devices", { method: "POST" }).respondedWith,
    ).toBeUndefined();
    expect(
      dispatchFetch("/x.js", { origin: "https://cdn.example" }).respondedWith,
    ).toBeUndefined();
  });

  it("带扩展名的导航（直接打开 /offline.html 之类）不给外壳", async () => {
    await installedWith("aaa");
    expect(navigate("/manifest.webmanifest").respondedWith).toBeUndefined();
  });

  it("/assets/ 仍是命中即返回、未命中取回顺手存下", async () => {
    await installedWith("aaa");
    routes.set("/assets/chat-x.js", async () => new Response("chunk"));

    const first = dispatchFetch("/assets/chat-x.js");
    expect(await (await first.respondedWith!).text()).toBe("chunk");
    await vi.waitFor(async () =>
      expect(await caches.current().text("/assets/chat-x.js")).toBe("chunk"),
    );

    routes.delete("/assets/chat-x.js");
    const again = dispatchFetch("/assets/chat-x.js");
    expect(await (await again.respondedWith!).text()).toBe("chunk");
  });
});
