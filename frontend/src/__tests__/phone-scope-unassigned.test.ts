import { describe, expect, it } from "vitest";

import type { MirrorIndexRow } from "@/pages/chat/chatRows";
import {
  phoneDataAxis,
  phoneScopeKey,
  phoneServerScope,
  readPhoneScope,
  withPhoneScope,
} from "@/pages/chat/phoneScope";
import {
  buildScopeUnassigned,
  phoneScopeOf,
  scopeValueOf,
  tallyRows,
} from "@/pages/chat/phoneScopeLists";

/**
 * 手机首页的「随手对话」范围（不属于任何项目的对话）。
 *
 * 范围弹层此前没有这一档：桌面左栏的项目轴有「随手对话」组，手机上一条随手对话只能
 * 在「全部」里翻（2026-11-19 用户反馈）。端点早就认 `unassigned-project` 这个 scope
 * （组头「查看全部」翻的就是它），缺的只是手机这一侧的接线。
 */
describe("phone scope · 随手对话", () => {
  it("地址往返：写进地址再读回来还是随手对话，且与项目同属项目轴", () => {
    const params = withPhoneScope(new URLSearchParams("filter=unread"), {
      kind: "unassigned",
    });
    expect(params.get("axis")).toBe("project");
    expect(params.get("filter")).toBe("unread");
    expect(readPhoneScope(params)).toEqual({ kind: "unassigned" });
  });

  it("取数：项目轴 + 端点的 unassigned-project scope，范围身份独立", () => {
    expect(phoneDataAxis({ kind: "unassigned" })).toBe("project");
    expect(phoneServerScope({ kind: "unassigned" })).toBe("unassigned-project");
    expect(phoneScopeKey({ kind: "unassigned" })).not.toBe(
      phoneScopeKey({ kind: "all" }),
    );
  });

  it("与共享清单的选中值互译", () => {
    expect(scopeValueOf({ kind: "unassigned" })).toEqual({
      kind: "unassignedProject",
    });
    expect(phoneScopeOf({ kind: "unassignedProject" })).toEqual({
      kind: "unassigned",
    });
  });

  it("计数：没有项目的行数进随手对话，有事等你的亮点", () => {
    const row = (projectSyncId: string, waiting = false) =>
      ({
        projectSyncId,
        agentSyncId: "",
        lifecycleState: "idle",
        waitingForInput: waiting,
      }) as unknown as MirrorIndexRow;
    const tally = tallyRows([row(""), row("", true), row("p-1")]);

    expect(buildScopeUnassigned(tally)).toEqual({ count: 2, needsYou: true });
  });

  it("数不出来（还没在「全部」下载入过）时这一行照样摆，只是不带数", () => {
    expect(buildScopeUnassigned(null)).toEqual({});
  });
});
