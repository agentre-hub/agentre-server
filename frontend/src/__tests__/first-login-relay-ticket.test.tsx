/**
 * 首次登录那一次加载：账号通道的取票请求必须带得上 CSRF token。
 *
 * 现场是左下角那句「未连接 · 每 30 秒刷新」——只在**首次登录**出现，刷一次就好了。
 * 它不是网络抖动：
 *
 *  - CSRF token 由 `/v1/auth/me` 带下来，`useMe` 在 effect 里写进 `sessionStorage`；
 *    `main.tsx` 的 `loadCsrfToken()` 只在模块加载时读一遍。首次登录时那格是空的
 *    （sessionStorage 按标签页存，这个账号在这个标签页里从没登录过），所以整个
 *    首屏都得等 `useMe` 那个 effect 把它填上。
 *  - 而 React 的 passive effect 是**自下而上**跑的：`RequireAuth` 放行子树的那一次
 *    提交里，子树（外壳 → 那盏灯 → `ensureChannel` → 取票 POST）的 effect 全部
 *    先跑完，`useMe` 里那个 `setCsrfToken` 才跑。于是首次登录的取票 POST 必然不带
 *    token，被 CSRF 中间件 403。
 *  - 403 之后不会自愈：`subscribeSignals` 的 catch 只喊一次 `onSignalClosed`，而
 *    `heardConnection` 还是 false，灯就此钉在 `disconnected`（见 accountChannel 的
 *    那两段注释）。
 *
 * 所以这里钉的不是「灯是什么颜色」，而是它上游那一下：**通道开起来的时候，
 * 写请求该带的东西必须已经在手上**。
 */
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

import { ConnectionEscape } from "@/components/ConnectionStatus";
import RequireAuth from "@/components/RequireAuth";
import { setCsrfToken } from "@/lib/api";

const me = {
  user_id: 1,
  email: "dev@agentre.dev",
  display_name: "Dev User",
  avatar_url: "",
  github_login: "dev",
  csrf_token: "csrf-from-me",
};

/** 取票那一发请求带的头，null 表示还没发出去。 */
let ticketHeaders: Headers | null = null;

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

function envelope(data: unknown): Response {
  return {
    ok: true,
    json: async () => ({ code: 0, msg: "", data }),
  } as unknown as Response;
}

beforeEach(() => {
  ticketHeaders = null;
  sessionStorage.clear();
  // 首次登录：这个标签页里没有任何存货，模块级读数也得跟着空。
  setCsrfToken(null);

  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const headers = new Headers(init?.headers);
      if (path === "/v1/auth/me") return envelope(me);
      if (path === "/v1/relay/ticket") {
        ticketHeaders = headers;
        return envelope({
          access_token: "tk",
          expires_in: 120,
          peer_fingerprint: "sha256:web",
        });
      }
      return envelope(null);
    },
  ) as unknown as typeof fetch;

  // 票拿到之后连接会真的去开 socket；这里只要它别去连网。
  globalThis.WebSocket = class {
    close(): void {}
    send(): void {}
    addEventListener(): void {}
  } as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
  vi.restoreAllMocks();
});

it("首次登录:账号通道的取票 POST 带得上 CSRF token", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <RequireAuth>
        <ConnectionEscape variant="bar" />
      </RequireAuth>
    </MemoryRouter>,
  );

  await waitFor(() => expect(ticketHeaders).not.toBeNull());
  expect(ticketHeaders!.get("X-CSRF-Token")).toBe("csrf-from-me");
});
