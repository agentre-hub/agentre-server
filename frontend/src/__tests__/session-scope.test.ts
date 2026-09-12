import { describe, expect, it } from "vitest";

import { scopeOfGroup } from "@/lib/sessionScope";
import type {
  MirrorIndexGroup,
  MirrorIndexGroupRow,
} from "@/pages/chat/chatRows";

/**
 * 组 ⇄ scope 这套本站词汇（见 lib/sessionScope 的头注）。这里只盯机器那一档:
 * 它是唯一一处 scope 的值不等于组键的轴 —— 组键是设备标识,scope 是指纹。
 */

function row(over: Partial<MirrorIndexGroupRow>): MirrorIndexGroupRow {
  return {
    key: "conv-1",
    conversationId: "conv-1",
    sessionId: 0,
    fingerprint: "",
    machineFingerprint: "",
    agentSyncId: "",
    projectSyncId: "",
    updatedAt: 0,
    title: "",
    lifecycleState: "idle",
    ...over,
  };
}

function machineGroup(rows: MirrorIndexGroupRow[]): MirrorIndexGroup {
  return {
    key: "device-1",
    kind: "machine",
    label: "coding",
    depth: 0,
    offline: false,
    rows,
  };
}

describe("scopeOfGroup 机器轴", () => {
  // 端点上的机器 scope 说的是**承载**这条对话的那台机器（服务端按它分组、按它筛）。
  // 拿发起端指纹去问的话，从 web 控制台派出去的那些对话会拿一个账号里根本不存在的
  // 指纹去翻这一组:翻回来的是另一批,或者一条都没有。
  it("按承载机器的指纹拼 scope，而不是发起端", () => {
    const group = machineGroup([
      row({
        key: "c1",
        conversationId: "c1",
        fingerprint: "fp-browser-1",
        machineFingerprint: "fp-agentred",
      }),
      row({
        key: "c2",
        conversationId: "c2",
        fingerprint: "fp-browser-2",
        machineFingerprint: "fp-agentred",
      }),
    ]);
    expect(scopeOfGroup(group)).toBe("machine:fp-agentred");
  });

  // 一组行必然同属一台机器（组就是按机器分的）；万一凑不出唯一的一台就不给 scope,
  // 不编一个 —— 编出来的那一组翻回来的是别的东西。
  it("凑不出唯一一台机器时不给 scope", () => {
    const group = machineGroup([
      row({ key: "c1", conversationId: "c1", machineFingerprint: "fp-a" }),
      row({ key: "c2", conversationId: "c2", machineFingerprint: "fp-b" }),
    ]);
    expect(scopeOfGroup(group)).toBeUndefined();
  });
});
