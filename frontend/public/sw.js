/* global self, caches, fetch, Response, URL */
/*
 * Agentre web console 的 service worker（classic，非 module）。
 *
 * 这份 SW 刻意保持"薄"：唯一的离线资产是 /offline.html，唯一的缓存对象是
 * /assets/ 下带内容 hash 的构建产物。理由：
 *
 * - 不做 skipWaiting。部署新版本时不能把一个正在使用的页面脚下的 SW 换掉——
 *   那会在用户打字打到一半时让新旧 bundle 混着跑。
 * - 导航是 network-first 而不是 cache-first。服务端特意让 index.html 走 no-cache，
 *   就是为了滚动更新一定能到达用户；cache-first 的 app shell 会把旧构建悄悄钉死。
 * - API 与 /v1/ 一律不碰，也绝不缓存 JSON。控制台没有 API 本来就没法用，缓存它
 *   只会让"离线可用"变成一句谎话。
 * - 账号中继是 WebSocket，service worker 根本不拦截它，这里也不去做。
 */

const CACHE = "agentre-static-v1";
// activate 时保留的名单。改缓存策略就是换一个新名字，旧缓存由 activate 清掉。
const KEEP = [CACHE];
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  // 只预缓存那一张自足的离线页。不调 skipWaiting：等现有页面自己卸载。
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL])),
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // 非 GET / 跨源 / /v1/ 一律直接放行：不调 respondWith，浏览器按原样走网络。
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/")) return;

  if (request.mode === "navigate") {
    // network-first：拿到就一定是最新部署；断网才退到那张静态离线页。
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    // 内容 hash 写进了文件名，内容一变文件名就变，所以命中即返回、未命中取回后
    // 顺手存下。这是这一层唯一敢做 cache-first 的一类请求。
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

  // 其余（manifest、图标、字体、外部……）原样走网络。
});
