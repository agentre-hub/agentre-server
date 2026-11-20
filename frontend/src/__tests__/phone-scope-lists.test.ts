import { describe, expect, it } from "vitest";

import { phoneScopeOf } from "@/pages/chat/phoneScopeLists";

describe("phoneScopeOf", () => {
  it("共享包新增的「随手对话」选中值落回「全部」：本站手机范围清单不摆这一行，没有对应的页面范围", () => {
    expect(phoneScopeOf({ kind: "unassignedProject" })).toEqual({
      kind: "all",
    });
  });
});
