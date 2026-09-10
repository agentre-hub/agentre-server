import { describe, expect, it } from "vitest";

import { agentredVersionState, compareVersions } from "@/lib/agentredVersion";

/**
 * lib/agentredVersion 是「这台 agentred 跑的是哪一版、要不要劝它升级」的唯一判定，
 * 设备卡（宽屏与窄屏两处画法）都只读它的结论。直接钉住它，而不是只经设备页面间接
 * 覆盖：一个排错的版本号在页面上表现为「少一枚徽标」，太安静了。
 */
describe("compareVersions", () => {
  it("orders release versions numerically, not lexically", () => {
    expect(compareVersions("0.5.2", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.6.0", "0.6.0")).toBe(0);
  });

  it("puts a pre-release before the release it leads to", () => {
    expect(compareVersions("0.6.0-beta.1", "0.6.0")).toBeLessThan(0);
    expect(compareVersions("0.6.0", "0.6.0-beta.1")).toBeGreaterThan(0);
  });

  // 预发布段按 `.` 分节比，数字节按数值比：字面比法会把 beta.10 排在 beta.2 之前，
  // 于是一台跑 beta.2 的机器在 beta.10 已经发布之后被判成「已是最新」——正是决策 19
  // 不许发生的那种「借一个结论冒充另一个」。
  it("orders pre-release counters numerically", () => {
    expect(compareVersions("0.6.0-beta.2", "0.6.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("0.6.0-beta.10", "0.6.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("0.6.0-beta", "0.6.0-beta.1")).toBeLessThan(0);
  });

  // 构建元数据（`+` 之后那一段）按 semver 不参与排序。把它当成预发布段的话，一台跑
  // 0.6.0+abc123 的机器会被永久判成旧于 0.6.0，一直劝升，而点下去的每一次一键升级
  // 都只会拿回 ALREADY_LATEST。
  it("ignores build metadata", () => {
    expect(compareVersions("0.6.0+abc123", "0.6.0")).toBe(0);
    expect(compareVersions("0.6.0-beta.1+abc", "0.6.0-beta.1")).toBe(0);
    expect(compareVersions("0.6.0+abc", "0.6.1")).toBeLessThan(0);
  });

  // 不可比就是不可比：nightly 串、空串、"dev" 都不能拿去和正式版排序，硬排会把一台
  // 机器判成过期然后一直劝升。
  it("returns null for anything that is not a comparable version", () => {
    expect(compareVersions("dev", "0.6.0")).toBeNull();
    expect(compareVersions("nightly-20260101-abc", "0.6.0")).toBeNull();
    expect(compareVersions("", "0.6.0")).toBeNull();
  });
});

describe("agentredVersionState", () => {
  const release = {
    version: "0.5.2",
    protocolMismatch: false,
    commit: "a1b2c3d",
    buildKnown: true,
  };

  it("nudges a release build that is older than the latest known version", () => {
    expect(agentredVersionState({ ...release, latest: "0.6.0" })).toEqual({
      kind: "upgradable",
      version: "0.5.2",
      latest: "0.6.0",
    });
  });

  it("leaves a build that is already current unbadged", () => {
    expect(agentredVersionState({ ...release, latest: "0.5.2" })).toEqual({
      kind: "current",
      version: "0.5.2",
    });
  });

  // 决策 19：拿不到最新版信息与「已是最新」是两个状态，不能借「没有徽标」冒充。
  it("keeps 'latest unknown' apart from 'already current'", () => {
    expect(agentredVersionState({ ...release, latest: "" })).toEqual({
      kind: "latest-unknown",
      version: "0.5.2",
    });
  });

  // 决策 5：未注入构建变量的本地构建自称 1.0.0，比任何 0.x 正式版都「新」。
  it("never nudges a build with no short commit", () => {
    expect(
      agentredVersionState({ ...release, commit: "", latest: "0.6.0" }),
    ).toEqual({ kind: "dev-build", version: "0.5.2" });
  });

  // 「不知道这台机器的构建」与「commit 是空串」是两件事。
  it("passes no judgement when the build is unknown", () => {
    expect(
      agentredVersionState({
        ...release,
        commit: "",
        buildKnown: false,
        latest: "0.6.0",
      }),
    ).toEqual({ kind: "latest-unknown", version: "0.5.2" });
  });

  it("says nothing at all before any version was reported", () => {
    expect(
      agentredVersionState({ ...release, version: "", latest: "0.6.0" }),
    ).toEqual({ kind: "unknown" });
  });

  it("turns a protocol-version rejection into the strong state", () => {
    expect(
      agentredVersionState({
        ...release,
        protocolMismatch: true,
        latest: "0.6.0",
      }),
    ).toEqual({ kind: "protocol-mismatch", version: "0.5.2" });
  });
});
