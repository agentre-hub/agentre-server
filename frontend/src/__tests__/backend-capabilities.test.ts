import { describe, expect, it } from "vitest";

import { decodePermissionModeMeta } from "@/lib/backendCapabilities";

// 过线的是 Go 的 capability.Capabilities 原样透传（没有 json tag），所以字段名是
// Go 的导出名。这几条用例照真实形状写。
const claudecode = {
  capabilities: {
    Set: { set_permission_mode: true },
    PermissionModeMeta: {
      AllowedModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
      DefaultMode: "acceptEdits",
      SwitchableDuringTurn: true,
      Order: ["default", "acceptEdits", "plan", "bypassPermissions"],
      LaunchDefaultMode: "",
    },
  },
};

describe("decodePermissionModeMeta", () => {
  it("原样交出 runtime 报的档位集合、默认档与循环顺序", () => {
    expect(decodePermissionModeMeta(claudecode)).toEqual({
      allowedModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
      defaultMode: "acceptEdits",
      order: ["default", "acceptEdits", "plan", "bypassPermissions"],
      switchableDuringTurn: true,
    });
  });

  // codex 只有两档，而本站此前对它给空数组、控件整颗消失。
  it("只报两档的 runtime 就是两档", () => {
    const meta = decodePermissionModeMeta({
      capabilities: {
        PermissionModeMeta: {
          AllowedModes: ["default", "plan"],
          DefaultMode: "default",
          SwitchableDuringTurn: false,
        },
      },
    });
    expect(meta?.allowedModes).toEqual(["default", "plan"]);
    expect(meta?.switchableDuringTurn).toBe(false);
  });

  // Order 缺席时退回 allowedModes 的顺序——不是「没有顺序」。
  it("没报 Order 时按 allowedModes 的顺序循环", () => {
    const meta = decodePermissionModeMeta({
      capabilities: {
        PermissionModeMeta: { AllowedModes: ["default", "plan"] },
      },
    });
    expect(meta?.order).toEqual(["default", "plan"]);
  });

  // **空集合是一句肯定的话**：这个后端没有权限门（builtin 就是这样）。
  it("空档位集合是「这个后端没有权限门」，不是「没答」", () => {
    const meta = decodePermissionModeMeta({
      capabilities: { PermissionModeMeta: { AllowedModes: [] } },
    });
    expect(meta).not.toBeNull();
    expect(meta?.allowedModes).toEqual([]);
  });

  // 而解不动一律是 null。混成空集合，界面就会对着一台答不上来的机器说
  // 「这个后端没有权限档位」——用户无法证伪的假话。
  it.each([
    ["空对象", {}],
    ["capabilities 不是对象", { capabilities: 1 }],
    ["没有 PermissionModeMeta", { capabilities: {} }],
    ["AllowedModes 缺席", { capabilities: { PermissionModeMeta: {} } }],
    ["null", null],
    ["字符串", "nope"],
  ])("解不动的应答（%s）返回 null 而不是空集合", (_label, raw) => {
    expect(decodePermissionModeMeta(raw)).toBeNull();
  });
});
