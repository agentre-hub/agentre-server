import { describe, expect, it } from "vitest";

import { phoneScopeOf } from "@/pages/chat/phoneScopeLists";

describe("phoneScopeOf", () => {
  // 手机范围弹层项目档末尾摆「随手对话」（2026-11-19），选中即换到这一档，
  // 不再落回「全部」（那是清单还没摆这一行时的兜底）。
  it("共享包的「随手对话」选中值换到随手对话这一档", () => {
    expect(phoneScopeOf({ kind: "unassignedProject" })).toEqual({
      kind: "unassigned",
    });
  });
});
