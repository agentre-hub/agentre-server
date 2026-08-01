import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, ApiError, setCsrfToken } from "@/lib/api";

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
});
