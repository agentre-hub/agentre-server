import { describe, expect, it, vi } from "vitest";

import { registerServiceWorker } from "@/lib/service-worker";

/**
 * service worker 注册的守卫。
 *
 * 注册本身是「锦上添花」的那一类：它失败最坏也只是没有离线页，绝不能反过来把
 * 应用启动打断。所以这里钉住三件事：生产才注册、scope 是根、失败被吞成一条 warn。
 *
 * sw.js 的内部行为（install/activate/fetch）不在这里测：那是一份 public/ 下的纯
 * JS，没有可注入的缝合面，在 jsdom 里手搓一遍只会在测一份假实现。它由真浏览器
 * 验证（见 docs/verification.md）。
 */
describe("service worker 注册", () => {
  it("生产路径：以 scope / 注册 /sw.js", async () => {
    const register = vi.fn().mockResolvedValue({ scope: "/" });

    const result = await registerServiceWorker({ enabled: true, register });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(result).not.toBeNull();
  });

  it("dev 路径：根本不碰 register", async () => {
    const register = vi.fn();

    await registerServiceWorker({ enabled: false, register });

    expect(register).not.toHaveBeenCalled();
  });

  it("注册被拒时不冒泡，只记一条 warn", async () => {
    const error = new Error("blocked by policy");
    const warn = vi.fn();
    const register = vi.fn().mockRejectedValue(error);

    await expect(
      registerServiceWorker({ enabled: true, register, warn }),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), error);
  });

  it("浏览器没有 serviceWorker 时静默跳过，不抛错", async () => {
    await expect(registerServiceWorker({ enabled: true })).resolves.toBeNull();
  });
});
