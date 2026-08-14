/**
 * 这个浏览器自己的派发顺序：排列的纯计算（决策 7 / 10 / 11）。
 *
 * 排列以 backend sync_id 数组表达 —— rank 是位置性的（重排即变），device_id 也不
 * 唯一（一台机器可挂多个 backend）。skipped_for_web 的档在浏览器语境下永远不可
 * 派发，不参与排序：它钉在原位，可移动的档跨过它换位。
 */
import { describe, expect, it } from "vitest";

import { isMovableTier, reorderTargets } from "@/lib/execOrder";

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
