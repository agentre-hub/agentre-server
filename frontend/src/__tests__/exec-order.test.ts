/**
 * 执行目标排列的纯计算（决策 10 / 11），以及提交载荷的形状（决策 14）。
 *
 * 排列以 backend sync_id 数组表达 —— rank 是位置性的（重排即变），device_id 也不
 * 唯一（一台机器可挂多个 backend）。no_device 的档（后端行没写运行设备，规格
 * 2026-08-21 决策 14）在浏览器语境下永远不可派发，不参与排序：它钉在原位，可
 * 移动的档跨过它换位。
 *
 * 顺序本身没有「这个浏览器那一份」：排的就是账号默认（sort_order），所以提交载荷
 * 里不该出现任何调用方标识。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import {
  isMovableTier,
  reorderTargets,
  saveExecTargetOrder,
} from "@/lib/execOrder";

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

const local = { backend_sync_id: "b-local", availability: "no_device" };
const nuc = { backend_sync_id: "b-nuc", availability: "available" };
const mac = { backend_sync_id: "b-mac", availability: "offline" };
const pi = { backend_sync_id: "b-pi", availability: "unpaired" };

describe("isMovableTier", () => {
  it("只有 no_device 不可移动；离线 / 未配对的档照样能排", () => {
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

  it("no_device 档钉在原位：可移动的档跨过它换位（决策 11）", () => {
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

  it("对 no_device 档本身调用返回 null：它不可移动", () => {
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

describe("saveExecTargetOrder（写的是账号默认顺序）", () => {
  it("提交的载荷只有 Agent 与排列 —— 不带任何调用方标识", async () => {
    mockedApi.mockResolvedValueOnce({});

    await saveExecTargetOrder({
      agentSyncId: "agent-1",
      backendSyncIds: ["b-nuc", "b-mac"],
    });

    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(mockedApi.mock.calls[0][0]).toBe("/v1/workspace/exec-target-order");
    // client_id 必须不在这里。它曾经是「这个浏览器那一份顺序」的键；那一层已经
    // 整个删掉（决策 14），继续发它只会让读代码的人以为还有按浏览器区分的存储。
    expect(JSON.parse(String(mockedApi.mock.calls[0][1]?.body))).toEqual({
      agent_sync_id: "agent-1",
      backend_sync_ids: ["b-nuc", "b-mac"],
    });
  });
});
