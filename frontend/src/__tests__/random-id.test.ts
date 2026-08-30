/**
 * 随机标识守卫（2026-08-30 的「连不上 coding，请重试。」）。
 *
 * 本站是**用 http 部署**的（`http://coding.local:8443`），那是一个非安全上下文，
 * 而 `crypto.randomUUID` 在规范里带 `[SecureContext]`：它在那里根本不存在，调用
 * 直接抛 `TypeError`。抛出的点在派发逻辑里，界面把它当成「不是 DispatchRunError」
 * 的那一支，于是对着一台明明连得上的机器说「连不上」。
 *
 * 所以随机标识只有一处实现，且它不假定安全上下文：`crypto.getRandomValues` 没有
 * 这层门槛，http 上照常可用。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { randomId } from "@/lib/randomId";

/** 把全局 crypto 换成 http 部署下真正拿得到的那一份（没有 randomUUID）。 */
function insecureContext() {
  const real = globalThis.crypto;
  vi.stubGlobal("crypto", {
    getRandomValues: (buffer: Uint8Array) => real.getRandomValues(buffer),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomId", () => {
  it("安全上下文里用 crypto.randomUUID", () => {
    const spy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("11111111-2222-4333-8444-555555555555");
    expect(randomId()).toBe("11111111-2222-4333-8444-555555555555");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // 这一条是本轮的回归断言：非安全上下文里不能抛，也不能给出空串或恒等值。
  it("非安全上下文里 crypto.randomUUID 缺席时照常给出唯一标识", () => {
    insecureContext();
    expect(typeof crypto.randomUUID).toBe("undefined");

    const ids = Array.from({ length: 200 }, () => randomId());
    expect(new Set(ids).size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
