import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monaco 装载器（规格 2026-09-08 决策 6）。
 *
 * 三个 chunk 全是网络来的，测的是**缓存这一格**：装成之后不重复装，装砸了之后
 * 还能再装。真实 monaco 在这里全部换成桩 —— 这一层要证明的是装载器自己的缓存
 * 语义，把几 MB 真拉一遍既慢又证明不了它。
 */
const registerJsonLanguage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/monacoWorkerEnv", () => ({}));
vi.mock("monaco-editor/basic-languages/monaco.contribution", () => ({}));
vi.mock("monaco-editor/editor/editor.api", () => ({
  editor: {},
  languages: {},
}));
vi.mock("@agentre-hub/agentre-ui", () => ({ registerJsonLanguage }));

/** 每条用例要一份没装过的装载器：`cached` 是模块级的一格。 */
async function freshLoader() {
  vi.resetModules();
  return (await import("@/lib/monacoLoader")).loadMonaco;
}

describe("Monaco 装载器", () => {
  beforeEach(() => {
    registerJsonLanguage.mockReset();
  });

  it("装成之后不再装第二次：进程内单例", async () => {
    const loadMonaco = await freshLoader();

    const first = await loadMonaco();
    const second = await loadMonaco();

    expect(second).toBe(first);
    expect(registerJsonLanguage).toHaveBeenCalledTimes(1);
  });

  // 部署换了带哈希的产物、一次瞬时断网 —— 这几个 chunk 拉失败是常态。失败的那
  // 一份若留在缓存里，这一屏此后再也装不上 Monaco：换个文件、关掉再开都还是同
  // 一个 rejected promise，而面板那颗重试只重读文件、够不着装载器。
  it("一次装载失败之后还能再装：失败的那一份不留在缓存里", async () => {
    const loadMonaco = await freshLoader();
    registerJsonLanguage.mockImplementationOnce(() => {
      throw new Error("chunk 拉不下来");
    });

    await expect(loadMonaco()).rejects.toThrow("chunk 拉不下来");

    await expect(loadMonaco()).resolves.toBeTruthy();
    expect(registerJsonLanguage).toHaveBeenCalledTimes(2);
  });
});
