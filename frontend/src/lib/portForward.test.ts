/**
 * 端口转发库（`@/lib/portForward`）里能脱离整条中继/组件栈单测的那一段：
 *
 *  - 两条失败分辨函数（`classifyPortForwardError` 认 wire 错误码，
 *    `classifyPortForwardLinkError` 认 `/v1/port-forwards/links` 的 HTTP 状态码）；
 *  - `allocatePortForwardLink` 打的路径、方法、请求体形状；
 *  - `byPort` 的排序在多带一个 `target` 字段之后仍然成立。
 *
 * 声明族（list / create / setEnabled / delete）经中继裸传那几个函数，连同「打开 /
 * 复制走同一个分配前缀」的宿主行为，由 `src/__tests__/device-port-forward.test.tsx`
 * 跑整条生产通路覆盖——那条路径的价值在于「方法选错、参数形状不对」这类错必红，
 * 在这里另起一份 relay 桩只会重复那份夹具，不会多测出什么。
 */
import { describe, expect, it, vi } from "vitest";

import { ApiError, api } from "@/lib/api";
import { RelayError } from "@/lib/relayClient";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

import {
  allocatePortForwardLink,
  byPort,
  classifyPortForwardError,
  classifyPortForwardLinkError,
  type PortForwardDeclaration,
} from "@/lib/portForward";

function declaration(
  over: Partial<PortForwardDeclaration> = {},
): PortForwardDeclaration {
  return {
    id: "1",
    port: 3000,
    target: "http://127.0.0.1:3000",
    name: "dev",
    enabled: true,
    ...over,
  };
}

describe("classifyPortForwardError", () => {
  it("Given 不是 RelayError, Then 归为 disconnected（通道都没开起来）", () => {
    expect(classifyPortForwardError(new Error("boom")).kind).toBe(
      "disconnected",
    );
  });

  it("Given ErrCodePortForwardNotDeclared, Then 归为 gone", () => {
    const failure = classifyPortForwardError(
      new RelayError(-32070, "mapping not declared", null),
    );
    expect(failure.kind).toBe("gone");
  });

  it("Given ErrCodePortForwardDisabled, Then 归为 disabled", () => {
    expect(
      classifyPortForwardError(new RelayError(-32071, "disabled", null)).kind,
    ).toBe("disabled");
  });

  it("Given ErrCodePortForwardPortTaken（目标已经声明过）, Then 归为 targetTaken", () => {
    expect(
      classifyPortForwardError(
        new RelayError(-32074, "target already declared", null),
      ).kind,
    ).toBe("targetTaken");
  });

  it("Given ErrCodePortForwardInvalidTarget, Then 归为 invalidTarget", () => {
    expect(
      classifyPortForwardError(new RelayError(-32076, "invalid target", null))
        .kind,
    ).toBe("invalidTarget");
  });

  it("Given RelayClient 自造的 -1, Then 归为 disconnected", () => {
    expect(
      classifyPortForwardError(new RelayError(-1, "relay: 请求超时", null))
        .kind,
    ).toBe("disconnected");
  });

  it("Given 认不出来的错误码, Then 归为 unknown 并带上原文", () => {
    const failure = classifyPortForwardError(
      new RelayError(-9999, "谁也没见过", null),
    );
    expect(failure).toEqual({ kind: "unknown", message: "谁也没见过" });
  });
});

describe("classifyPortForwardLinkError", () => {
  it("Given 503（base_domain 没配）, Then 归为 unavailable 并原样带上服务端文案", () => {
    const err = new ApiError(31200, "这个部署此刻提供不了端口转发", 503);
    expect(classifyPortForwardLinkError(err)).toEqual({
      kind: "unavailable",
      message: "这个部署此刻提供不了端口转发",
    });
  });

  it("Given 404（不是这个账号的设备 / 映射已撤销）, Then 归为 notFound", () => {
    const err = new ApiError(40400, "not found", 404);
    expect(classifyPortForwardLinkError(err).kind).toBe("notFound");
  });

  it("Given 其余状态码的 ApiError, Then 归为 unknown", () => {
    const err = new ApiError(50000, "server error", 500);
    expect(classifyPortForwardLinkError(err).kind).toBe("unknown");
  });

  it("Given 连 ApiError 都不是（比如网络断了）, Then 归为 unknown 并带上原文", () => {
    expect(classifyPortForwardLinkError(new Error("network down"))).toEqual({
      kind: "unknown",
      message: "network down",
    });
  });
});

describe("allocatePortForwardLink", () => {
  it("Given 一台设备与一条映射 id, Then POST /v1/port-forwards/links 带 device_id + mapping_id", async () => {
    mockedApi.mockResolvedValue({
      prefix: "abcd1234efgh",
      url: "https://abcd1234efgh.fw.agentre.docker.local:8443/",
    });

    const link = await allocatePortForwardLink(12, "3");

    expect(mockedApi).toHaveBeenCalledWith("/v1/port-forwards/links", {
      method: "POST",
      body: JSON.stringify({ device_id: 12, mapping_id: 3 }),
    });
    expect(link).toEqual({
      prefix: "abcd1234efgh",
      url: "https://abcd1234efgh.fw.agentre.docker.local:8443/",
    });
  });
});

describe("byPort", () => {
  it("Given 乱序的声明, Then 按 port 升序排, target 原样带着", () => {
    const sorted = byPort([
      declaration({ id: "2", port: 8080, target: "http://127.0.0.1:8080" }),
      declaration({ id: "1", port: 3000, target: "http://127.0.0.1:3000" }),
    ]);
    expect(sorted.map((m) => m.port)).toEqual([3000, 8080]);
    expect(sorted.map((m) => m.target)).toEqual([
      "http://127.0.0.1:3000",
      "http://127.0.0.1:8080",
    ]);
  });
});
