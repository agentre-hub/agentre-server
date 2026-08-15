/**
 * 这个浏览器自己的派发顺序：排列的纯计算（决策 7 / 10 / 11），以及设备身份在哪
 * 一侧取得。
 *
 * 排列以 backend sync_id 数组表达 —— rank 是位置性的（重排即变），device_id 也不
 * 唯一（一台机器可挂多个 backend）。skipped_for_web 的档在浏览器语境下永远不可
 * 派发，不参与排序：它钉在原位，可移动的档跨过它换位。
 *
 * 身份取得是**读写分侧**的：读路径只认已经存在的身份，不因为「想读一份偏好」就
 * 凭空建出一台设备行——总览页是纯读页，打开它不该在用户的设备列表里多一台机器；
 * 注册只发生在用户真排了一次序的写路径上。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import {
  callerClientId,
  isMovableTier,
  reorderTargets,
  saveExecTargetOrder,
} from "@/lib/execOrder";
import { browserClientId } from "@/lib/relayTicket";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  mockedApi.mockReset();
});

const local = { backend_sync_id: "b-local", availability: "skipped_for_web" };
const nuc = { backend_sync_id: "b-nuc", availability: "available" };
const mac = { backend_sync_id: "b-mac", availability: "offline" };
const pi = { backend_sync_id: "b-pi", availability: "unpaired" };

describe("isMovableTier", () => {
  it("只有 skipped_for_web 不可移动；离线 / 未配对的档照样能排", () => {
    expect(isMovableTier(local)).toBe(false);
    expect(isMovableTier(nuc)).toBe(true);
    expect(isMovableTier(mac)).toBe(true);
    expect(isMovableTier(pi)).toBe(true);
  });
});

describe("reorderTargets", () => {
  it("相邻两档换位，返回新的 backend sync_id 排列", () => {
    expect(reorderTargets([nuc, mac, pi], 1, -1)).toEqual([
      "b-mac",
      "b-nuc",
      "b-pi",
    ]);
    expect(reorderTargets([nuc, mac, pi], 1, 1)).toEqual([
      "b-nuc",
      "b-pi",
      "b-mac",
    ]);
  });

  it("skipped_for_web 档钉在原位：可移动的档跨过它换位（决策 11）", () => {
    expect(reorderTargets([nuc, local, mac], 2, -1)).toEqual([
      "b-mac",
      "b-local",
      "b-nuc",
    ]);
  });

  it("越界方向返回 null（第一个不能再上移、最后一个不能再下移）", () => {
    expect(reorderTargets([local, nuc, mac], 1, -1)).toBeNull();
    expect(reorderTargets([local, nuc, mac], 2, 1)).toBeNull();
  });

  it("对 skipped_for_web 档本身调用返回 null：它不可移动", () => {
    expect(reorderTargets([local, nuc, mac], 0, 1)).toBeNull();
  });

  it("没有 backend sync_id 的档既不可移动也不进排列（服务端只收非空标识）", () => {
    const anonymous = { availability: "unpaired" };
    expect(isMovableTier(anonymous)).toBe(false);
    expect(reorderTargets([nuc, anonymous, mac], 1, -1)).toBeNull();
    expect(reorderTargets([nuc, anonymous, mac], 2, -1)).toEqual([
      "b-mac",
      "b-nuc",
    ]);
  });
});

describe("callerClientId（读路径只认已有身份，不注册）", () => {
  it("这台浏览器还没注册过时返回 null，且一个请求都不发", () => {
    expect(callerClientId()).toBeNull();
    // 读一份偏好不得建出一台设备行：总览页是纯读页，打开它不该让用户的设备
    // 列表凭空多一台机器（也正是 e2e「真实空态」守着的那条断言）。
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it("创建过 client ID 后纯本地读取，关标签页不丢失", () => {
    const fingerprint = browserClientId();
    window.sessionStorage.clear();
    mockedApi.mockClear();

    expect(callerClientId()).toBe(fingerprint);
    expect(mockedApi).not.toHaveBeenCalled();
  });
});

describe("saveExecTargetOrder（写路径才创建 client ID）", () => {
  it("第一次排序创建 client ID，但不注册设备", async () => {
    mockedApi.mockResolvedValueOnce({});

    const fingerprint = await saveExecTargetOrder({
      agentSyncId: "agent-1",
      backendSyncIds: ["b-nuc", "b-mac"],
    });

    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(mockedApi.mock.calls[0][0]).toBe("/v1/workspace/exec-target-order");
    expect(JSON.parse(String(mockedApi.mock.calls[0][1]?.body))).toEqual({
      client_id: fingerprint,
      agent_sync_id: "agent-1",
      backend_sync_ids: ["b-nuc", "b-mac"],
    });
    // 返回指纹，调用方据此按自己的顺序重读这条链，不必再猜一次身份。
    expect(callerClientId()).toBe(fingerprint);
  });

  it("已有 client ID 时直接复用", async () => {
    const fingerprint = browserClientId();
    mockedApi.mockClear();
    mockedApi.mockResolvedValueOnce({});

    expect(
      await saveExecTargetOrder({
        agentSyncId: "agent-1",
        backendSyncIds: ["b-nuc"],
      }),
    ).toBe(fingerprint);
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(mockedApi.mock.calls[0][0]).toBe("/v1/workspace/exec-target-order");
  });
});
