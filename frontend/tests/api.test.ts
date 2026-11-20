import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, ApiError, ApiTimeoutError, setCsrfToken } from "@/lib/api";

describe("api()", () => {
  beforeEach(() => {
    setCsrfToken("csrf-xyz");
    global.fetch = vi.fn();
  });

  it("attaches X-CSRF-Token on POST", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 0, msg: "ok", data: { ok: true } }),
    });
    await api("/v1/x", { method: "POST", body: JSON.stringify({}) });
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("csrf-xyz");
    expect(call[1].credentials).toBe("include");
  });

  it("throws ApiError on non-zero code", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ code: 30100, msg: "user not found", data: null }),
    });
    await expect(api("/v1/x")).rejects.toBeInstanceOf(ApiError);
  });

  describe("超时", () => {
    afterEach(() => vi.useRealTimers());

    /** 永不回应、只在 signal 中止时拒绝的 fetch。 */
    function hangingFetch() {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        (_p: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            // 与真 fetch 一致：signal 已中止时立即拒绝。
            if (init.signal?.aborted) reject(init.signal.reason);
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason ?? new DOMException("aborted")),
            );
          }),
      );
    }

    it("15 秒未回：以 ApiTimeoutError 拒绝，14 秒时仍在等", async () => {
      vi.useFakeTimers();
      hangingFetch();
      let outcome: unknown = "pending";
      api("/v1/x").catch((e) => (outcome = e));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(2);
      expect(outcome).toBeInstanceOf(ApiTimeoutError);
    });

    it("正常回应后不留定时器", async () => {
      vi.useFakeTimers();
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: "ok", data: 1 }),
      });
      await expect(api("/v1/x")).resolves.toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("调用方自带的 signal 仍能中止请求，且不被读成超时", async () => {
      hangingFetch();
      const ctl = new AbortController();
      const p = api("/v1/x", { signal: ctl.signal });
      ctl.abort(new Error("caller"));
      const err = await p.catch((e) => e);
      expect(err).not.toBeInstanceOf(ApiTimeoutError);
      expect((err as Error).message).toBe("caller");
    });

    it("调用方的 signal 已中止时，请求不会发出后继续挂着", async () => {
      hangingFetch();
      const ctl = new AbortController();
      ctl.abort(new Error("early"));
      await expect(api("/v1/x", { signal: ctl.signal })).rejects.toThrow(
        "early",
      );
    });

    it("传了 signal 时超时照样生效", async () => {
      vi.useFakeTimers();
      hangingFetch();
      const ctl = new AbortController();
      let outcome: unknown = "pending";
      api("/v1/x", { signal: ctl.signal }).catch((e) => (outcome = e));
      await vi.advanceTimersByTimeAsync(15_001);
      expect(outcome).toBeInstanceOf(ApiTimeoutError);
    });
  });
});
