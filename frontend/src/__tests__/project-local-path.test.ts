import { rpcMethods } from "@agentre-hub/agentre-wire";
/**
 * 桌面端本机路径的写入通路（规格 2026-08-21 决策 1）。
 *
 * 打桩点与目录选择器同一个：**`RelayClient.request` 这一个公开方法**。整条通路是
 * 浏览器 → `/v1/relay/client` → 那台桌面端的 `project.*`，服务端只做字节透传，
 * 它既不解析也不落库——所以这一批用例全绿**也不能证明**真的桌面端认得这两个方法，
 * 那一条留给收尾时拿真进程跑一次。
 *
 * 这里能证明的是：方法名与形状对得上契约，四类失败各自可分辨。
 */
import { describe, expect, it, vi } from "vitest";

import {
  classifyProjectLocalPathError,
  clearDesktopLocalPath,
  ProjectLocalPathErrorCode,
  setDesktopLocalPath,
} from "@/lib/projectLocalPath";
import { RelayError } from "@/lib/relayClient";

describe("桌面端本机路径的写入", () => {
  it("按契约的方法名与字段发出去，并交回生效后的状态", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ path: "/Users/me/code/hub", configured: true });

    const result = await setDesktopLocalPath(
      { request },
      "proj-1",
      "/Users/me/code/hub",
    );

    expect(request).toHaveBeenCalledWith(rpcMethods.projectSetLocalPath, {
      projectSyncId: "proj-1",
      path: "/Users/me/code/hub",
    });
    expect(result).toEqual({ path: "/Users/me/code/hub", configured: true });
  });

  it("移除走的是另一个方法，只带项目标识——它不该长成「把路径设成空串」", async () => {
    const request = vi.fn().mockResolvedValue({ path: "", configured: false });

    const result = await clearDesktopLocalPath({ request }, "proj-1");

    expect(request).toHaveBeenCalledWith(rpcMethods.projectClearLocalPath, {
      projectSyncId: "proj-1",
    });
    expect(result).toEqual({ path: "", configured: false });
  });

  it("没有连接时如实给「掉线」，不抛一个说不清的 TypeError", async () => {
    await expect(setDesktopLocalPath(null, "proj-1", "/x")).rejects.toThrow();
    expect(
      classifyProjectLocalPathError(
        await setDesktopLocalPath(null, "proj-1", "/x").catch(
          (e: unknown) => e,
        ),
      ).kind,
    ).toBe("disconnected");
  });

  it("应答缺字段时按「没配上」处理，不假装成功", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const result = await setDesktopLocalPath({ request }, "proj-1", "/x");
    expect(result).toEqual({ path: "", configured: false });
  });
});

describe("失败分类", () => {
  it("按错误码分，不按 message——message 是那一侧的 Go 文本，改一个字就散了", () => {
    const cases: [number, string][] = [
      [ProjectLocalPathErrorCode.notSynced, "notSynced"],
      [ProjectLocalPathErrorCode.invalidPath, "invalidPath"],
      [ProjectLocalPathErrorCode.pathNotFound, "pathNotFound"],
      [-1, "disconnected"],
    ];
    for (const [code, kind] of cases) {
      expect(
        classifyProjectLocalPathError(new RelayError(code, "boom", null)).kind,
      ).toBe(kind);
    }
  });

  it("认不出来的一律 unknown 并带上原文，不编一个类", () => {
    const failure = classifyProjectLocalPathError(new Error("plain"));
    expect(failure.kind).toBe("unknown");
    expect(failure.message).toBe("plain");
  });

  it("「那台机器还没同步到这个项目」与「路径不存在」必须是两类——出路完全不同", () => {
    expect(
      classifyProjectLocalPathError(
        new RelayError(ProjectLocalPathErrorCode.notSynced, "x", null),
      ).kind,
    ).not.toBe(
      classifyProjectLocalPathError(
        new RelayError(ProjectLocalPathErrorCode.pathNotFound, "x", null),
      ).kind,
    );
  });
});
