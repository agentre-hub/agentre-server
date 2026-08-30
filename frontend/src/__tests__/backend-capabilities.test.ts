import { describe, expect, it } from "vitest";

import { decodePermissionModeMeta } from "@/lib/backendCapabilities";

/**
 * 过线的是 Protobuf 的 `agentre.wire.RuntimeCapabilitiesResponse`：`capabilities` 是
 * 一串 `CapabilityEntry`，权限档位单独一格 `permission_mode`，字段名按 protobuf-es
 * 的小驼峰。这几条用例照真实形状写。
 *
 * 它此前解的是**上一代**的形状（Go `capability.Capabilities` 原样透传的 JSON，
 * `capabilities.PermissionModeMeta.AllowedModes` 这种 Go 导出名）。中继改走 Protobuf
 * 之后那个形状一次都不会再出现，于是每一台机器上的每一条对话都解成 null，界面常驻
 * 一句「这台机器此刻列不出权限档位」，权限档位控件整颗消失。
 */
const claudecode = {
  capabilities: [{ name: "set_permission_mode", enabled: true }],
  permissionMode: {
    allowedModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
    defaultMode: "acceptEdits",
    switchableDuringTurn: true,
    order: ["default", "acceptEdits", "plan", "bypassPermissions"],
    launchDefaultMode: "",
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
      permissionMode: {
        allowedModes: ["default", "plan"],
        defaultMode: "default",
        switchableDuringTurn: false,
      },
    });
    expect(meta?.allowedModes).toEqual(["default", "plan"]);
    expect(meta?.switchableDuringTurn).toBe(false);
  });

  // order 缺席时退回 allowedModes 的顺序——不是「没有顺序」。
  it("没报 order 时按 allowedModes 的顺序循环", () => {
    const meta = decodePermissionModeMeta({
      permissionMode: { allowedModes: ["default", "plan"] },
    });
    expect(meta?.order).toEqual(["default", "plan"]);
  });

  // **空集合是一句肯定的话**：这个后端没有权限门（builtin 就是这样）。
  it("空档位集合是「这个后端没有权限门」，不是「没答」", () => {
    const meta = decodePermissionModeMeta({
      permissionMode: { allowedModes: [] },
    });
    expect(meta).not.toBeNull();
    expect(meta?.allowedModes).toEqual([]);
  });

  // 而解不动一律是 null。混成空集合，界面就会对着一台答不上来的机器说
  // 「这个后端没有权限档位」——用户无法证伪的假话。
  it.each([
    ["空对象", {}],
    ["permission_mode 没报（对端太老）", { capabilities: [] }],
    ["permissionMode 不是对象", { permissionMode: 1 }],
    ["allowedModes 缺席", { permissionMode: {} }],
    ["null", null],
    ["字符串", "nope"],
  ])("解不动的应答（%s）返回 null 而不是空集合", (_label, raw) => {
    expect(decodePermissionModeMeta(raw)).toBeNull();
  });
});
