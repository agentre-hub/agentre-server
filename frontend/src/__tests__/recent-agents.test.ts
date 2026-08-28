/**
 * 「最近用过」那一组的数据源。
 *
 * 只住在这个浏览器里（localStorage）：它是一份使用习惯，不是账号数据，没必要
 * 为它加字段、加迁移、加一个写入端点。代价是换浏览器记不住——换来的是这一整
 * 组功能不依赖后端。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECENT_AGENTS_KEY,
  readRecentAgents,
  rememberAgent,
} from "@/lib/recentAgents";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("readRecentAgents", () => {
  it("没记过任何一个时是空的，不是 null", () => {
    expect(readRecentAgents()).toEqual([]);
  });

  it("存的不是 JSON、或不是字符串数组时当作没记过，而不是把界面崩掉", () => {
    for (const junk of ['{"a":1}', "[1,2,3]", "not json", '"agent-1"']) {
      localStorage.setItem(RECENT_AGENTS_KEY, junk);
      expect(readRecentAgents()).toEqual([]);
    }
  });
});

describe("rememberAgent", () => {
  it("最近用的排在最前", () => {
    rememberAgent("a1");
    rememberAgent("a2");
    expect(readRecentAgents()).toEqual(["a2", "a1"]);
  });

  it("再次用到已经记过的那个只把它提到最前，不留下两条", () => {
    rememberAgent("a1");
    rememberAgent("a2");
    rememberAgent("a1");
    expect(readRecentAgents()).toEqual(["a1", "a2"]);
  });

  it("只留最近 5 个：这一组是入口不是历史，长了就不再是「最近」", () => {
    for (const id of ["a1", "a2", "a3", "a4", "a5", "a6"]) rememberAgent(id);
    expect(readRecentAgents()).toEqual(["a6", "a5", "a4", "a3", "a2"]);
  });

  it("空标识不记：它不指向任何 Agent，记下来只会在列表里占一格", () => {
    rememberAgent("");
    expect(readRecentAgents()).toEqual([]);
  });

  // 隐私模式 / 配额满时 localStorage 会抛。这一组只是入口的排序，
  // 记不下来最多是下次不显示「最近用过」，绝不该让「新对话」整个打不开。
  it("写不进去时咽掉异常，调用方照常往下走", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => rememberAgent("a1")).not.toThrow();
  });

  it("读不出来时也不抛", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readRecentAgents()).toEqual([]);
  });
});
