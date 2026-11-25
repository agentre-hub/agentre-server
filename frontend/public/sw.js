/* global self, caches, fetch, Response, URL */
/*
 * Agentre web console 的 service worker（classic，非 module）。
 *
 * 规格 2026-11-25 决策 B1、B3。应用的身份与列表已经存在本机（任务 10 的本地存储），
 * 有外壳就能在没网时打开；这份 SW 因此把外壳做成缓存优先：
 *
 * - 外壳（index.html）缓存优先。所有应用路由回的都是同一份 index.html，缓存在同一个
 *   键（SHELL_URL）下：有缓存立即给，同时在后台把这次导航的网络响应存回去，下一次
 *   打开（或点「重新加载」）就是新版本。
 * - 新版本由页面来问（message "check-update"，带上它正在跑的入口脚本）：SW 绕过
 *   HTTP 缓存取一次外壳，入口不同就回 "update-available"。比较的是「页面在跑的」与
 *   「服务器上的」，不是「缓存里的」——缓存可能早被上一次导航换成了新版，而眼前这个
 *   页面仍是旧的。提示条的出现由页面决定，这里只回答。
 * - 无外壳缓存时（首次安装、缓存被清）导航走网络，但最多等 10 秒，拿不到就退离线页；
 *   拿到 5xx 退离线页的「服务器暂时不可用」变体，不把 nginx 的裸错误页交给用户。
 *   离线页里的地址仍是原地址，它自己探测到联网后 reload 就回到原处。
 * - /assets/ 下带内容 hash 的产物命中即返回、未命中取回顺手存下。
 * - 不做 skipWaiting：部署新 sw.js 时不能把正在用的页面脚下的 SW 换掉，新 SW 等这些
 *   页面都关掉再接管。
 * - API 与 /v1/ 一律不碰，也绝不缓存 JSON；账号中继是 WebSocket，SW 不拦截它。
 */

// 换缓存策略就换一个新名字，旧缓存由 activate 清掉（v1 是 network-first 那一代）。
const CACHE = "agentre-static-v2";
const KEEP = [CACHE];
const OFFLINE_URL = "/offline.html";
const SHELL_URL = "/";
const NAVIGATION_TIMEOUT_MS = 10000;

/** 离线页里的变体标记：页面按它选文案（offline / server）。 */
const OFFLINE_REASON = 'data-reason="offline"';
const SERVER_REASON = 'data-reason="server"';

self.addEventListener("install", (event) => {
  // 离线页是必需的：取不到就别装。外壳是尽力而为：这一趟取不到，下一次导航再存。
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll([OFFLINE_URL]).then(() =>
        fetch(SHELL_URL, { cache: "no-store" })
          .then((response) =>
            isShell(response) ? storeShell(response) : undefined,
          )
          .catch(() => undefined),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !KEEP.includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "check-update") return;
  event.waitUntil(
    checkForUpdate(data.entry).then(({ updated, precaching }) => {
      if (updated && event.source) {
        event.source.postMessage({ type: "update-available" });
      }
      return precaching;
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // 非 GET / 跨源 / /v1/ 一律直接放行：不调 respondWith，浏览器按原样走网络。
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/")) return;

  if (request.mode === "navigate") {
    // 带扩展名的是静态文件（/offline.html、/manifest.webmanifest……），不是应用路由。
    if (hasExtension(url.pathname)) return;
    handleNavigation(event);
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    // 内容 hash 写进了文件名，内容一变文件名就变，所以命中即返回、未命中取回后
    // 顺手存下。
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => Response.error());
      }),
    );
    return;
  }

  // 其余（manifest、图标、离线页的探测……）原样走网络。
});

function handleNavigation(event) {
  // 这一趟网络无论谁用得上都要发：有缓存时它是后台更新，没缓存时它就是答案。
  // 拿到外壳就顺手存（先 clone，再把原件交给页面）。
  let storing = Promise.resolve();
  const network = fetch(event.request).then((response) => {
    if (isShell(response)) storing = storeShell(response.clone());
    return response;
  });
  event.waitUntil(
    network.then(
      () => storing,
      () => undefined,
    ),
  );
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(SHELL_URL))
      .then((cached) => cached ?? firstVisit(network)),
  );
}

/** 没有外壳缓存：网络最多等 10 秒；失败或超时给离线页，5xx 给「服务器」变体。 */
function firstVisit(network) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
  });
  return Promise.race([network.catch(() => null), timeout]).then((response) => {
    clearTimeout(timer);
    if (!response) return offlinePage(OFFLINE_REASON);
    if (response.status >= 500) return offlinePage(SERVER_REASON);
    return response;
  });
}

function offlinePage(reason) {
  return caches
    .open(CACHE)
    .then((cache) => cache.match(OFFLINE_URL))
    .then((cached) => {
      if (!cached) return Response.error();
      return cached.text().then(
        (text) =>
          new Response(text.replace(OFFLINE_REASON, reason), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      );
    });
}

/**
 * 取一次服务器上的外壳（绕过 HTTP 缓存）并存下；入口与页面报来的不同即有新版本。
 * 网络不通、拿到的不是外壳都当「没有新版本」。外壳存好就回答，它引用的产物由
 * `precaching` 在后台继续预存——提示条不必等它。
 */
function checkForUpdate(pageEntry) {
  const none = { updated: false, precaching: undefined };
  return fetch(SHELL_URL, { cache: "no-store" })
    .then((response) => {
      if (!isShell(response)) return none;
      return response.text().then((html) =>
        putShell(html).then(({ precaching }) => {
          const latest = entryOf(html);
          return {
            updated: Boolean(pageEntry && latest && latest !== pageEntry),
            precaching,
          };
        }),
      );
    })
    .catch(() => none);
}

/** 存外壳并等它引用的产物也预存完（尽力而为）：重新加载时不必再下。 */
function storeShell(response) {
  return response
    .text()
    .then((html) => putShell(html))
    .then(({ precaching }) => precaching);
}

/**
 * 把外壳写进缓存；`precaching` 是预存它引用的 /assets/ 产物那一趟（装在对象里交出，
 * 调用方自己决定等不等它）。
 */
function putShell(html) {
  return caches.open(CACHE).then((cache) =>
    cache
      .put(
        SHELL_URL,
        new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      )
      .then(() => ({
        precaching: Promise.all(
          assetsOf(html).map((asset) =>
            cache
              .match(asset)
              .then((hit) => hit || cache.add(asset))
              .catch(() => undefined),
          ),
        ),
      })),
  );
}

function isShell(response) {
  if (!response || !response.ok || response.redirected) return false;
  const type = response.headers.get("Content-Type") || "";
  return type.includes("text/html");
}

/** 外壳的入口脚本：vite 产物里唯一一个 type="module" 且带 src 的 <script>。 */
function entryOf(html) {
  const tags = html.match(/<script\b[^>]*>/g) || [];
  for (const tag of tags) {
    if (!/\btype="module"/.test(tag)) continue;
    const src = tag.match(/\bsrc="([^"]+)"/);
    if (src) return src[1];
  }
  return null;
}

function assetsOf(html) {
  const found = html.match(/(?:src|href)="\/assets\/[^"]+"/g) || [];
  return [
    ...new Set(found.map((attr) => attr.slice(attr.indexOf('"') + 1, -1))),
  ];
}

function hasExtension(pathname) {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return last.includes(".");
}
