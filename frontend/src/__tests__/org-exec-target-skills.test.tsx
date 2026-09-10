/**
 * 详情「执行」栏折在行内的**技能选择器**。
 *
 * 这一块此前是一个自由文本框，让用户凭记忆手打 skill id —— 浏览器没有任何办法
 * 知道那台机器上到底装了什么。桌面端一直是从本机实际装了什么里挑
 * （`agentre` 的 `exec-target-skills-block.tsx` + `capability-picker.tsx`），这一侧
 * 走同一条判据，取数换成中继上的 `skills.catalog`。
 *
 * 三态 `discovery` 各有各的说法，一条都不能合并（wire 的 `SkillDiscovery*` 注释）：
 *   · `ok`         —— 照目录增删；
 *   · `unavailable` —— 这台机器**此刻**答不出（CLI 找不到 / 枚举失败）。空目录
 *                      **不等于**「这台机器没有技能」，界面必须这么说；
 *   · `unsupported` —— 这种 backend 没有发现器，是稳定答案。
 *
 * 以及两处「不做注定失败的网络往返」：不支持技能的后端（白名单，不拨就知道）不给
 * 展开入口；离线的档展开了也不拨号，直接给离线说明——已授权的仍列得出、移得掉。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import { OrgExecTargetSection } from "@/pages/org/OrgExecTargetSection";
import type { OrgExecTargetItem } from "@/pages/org/types";
import { fetchSkillCatalog } from "@/lib/skillCatalog";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/lib/skillCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skillCatalog")>();
  return { ...actual, fetchSkillCatalog: vi.fn() };
});

const mockedFetch = vi.mocked(fetchSkillCatalog);

function target(over: Partial<OrgExecTargetItem> = {}): OrgExecTargetItem {
  return {
    sync_id: "t-1",
    rank: 1,
    backend_sync_id: "backend-1",
    backend_name: "公司的 Claude",
    backend_type: "claudecode",
    device_id: 21,
    device_name: "公司 Mac mini",
    device_fingerprint: "fp-online",
    is_local_reference: false,
    availability: "available",
    current: true,
    ...over,
  };
}

function renderOne(
  over: Partial<OrgExecTargetItem> = {},
  onChangeSkills = vi.fn(),
) {
  render(
    <OrgExecTargetSection
      agentSyncId="agent-1"
      targets={[target(over)]}
      backends={[]}
      onCreate={vi.fn()}
      onRemove={vi.fn()}
      onChangeSkills={onChangeSkills}
      onReordered={vi.fn()}
    />,
  );
  return onChangeSkills;
}

/** 最近一次写回的授权集（onChangeSkills 收到的 skills_json）。 */
function lastWritten(spy: ReturnType<typeof vi.fn>) {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error("onChangeSkills was never called");
  return JSON.parse(String(call[1])) as Array<{ id: string; enabled: boolean }>;
}

const twoPacks = {
  discovery: "ok" as const,
  packs: [
    {
      id: "agentre/web",
      name: "Web",
      description: "上网找东西",
      skills: ["search", "fetch"],
      installed: true,
      enabled: false,
      globallyEnabled: false,
    },
    {
      id: "agentre/db",
      name: "Database",
      description: "查库",
      skills: ["query"],
      installed: false,
      enabled: false,
      globallyEnabled: false,
    },
  ],
};

beforeEach(() => {
  mockedFetch.mockReset();
  mockedFetch.mockResolvedValue({ discovery: "ok", packs: [] });
});

describe("技能选择器：从那台机器实际装了什么里挑", () => {
  it("展开一档就拨这一档的指纹，并把这一档已有的授权报进去", async () => {
    renderOne({ skills_json: `[{"id":"agentre/web","enabled":true}]` });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(mockedFetch).toHaveBeenCalledWith({
      fingerprint: "fp-online",
      backendType: "claudecode",
      authorized: [{ id: "agentre/web", enabled: true }],
    });
  });

  it("discovery=ok：列出那台机器上真实装了的包，不再让用户手打 id", async () => {
    mockedFetch.mockResolvedValue(twoPacks);
    renderOne();
    expect(await screen.findByText("Web")).toBeTruthy();
    expect(screen.getByText("Database")).toBeTruthy();
    expect(
      screen.queryByPlaceholderText(/skill id/i),
      "手打 skill id 的输入框应当已经不在了",
    ).toBeNull();
  });

  it("三态：强制开 → 强制关 → 继承，切回继承是把这一项从授权集里拿掉", async () => {
    mockedFetch.mockResolvedValue(twoPacks);
    const onChange = renderOne();
    await screen.findByText("Web");

    fireEvent.click(screen.getByRole("radio", { name: "Force on Web" }));
    expect(lastWritten(onChange)).toEqual([
      { id: "agentre/web", enabled: true },
    ]);

    fireEvent.click(screen.getByRole("radio", { name: "Force off Web" }));
    expect(lastWritten(onChange)).toEqual([
      { id: "agentre/web", enabled: false },
    ]);

    fireEvent.click(
      screen.getByRole("radio", {
        name: "Inherit the global setting for Web",
      }),
    );
    expect(lastWritten(onChange)).toEqual([]);
  });

  it("没装在这台机器上的包只能看不能授权", async () => {
    mockedFetch.mockResolvedValue(twoPacks);
    renderOne();
    await screen.findByText("Database");
    const disabled = (name: string) =>
      (screen.getByRole("radio", { name }) as HTMLButtonElement).disabled;
    expect(disabled("Force on Database")).toBe(true);
    expect(disabled("Force off Database")).toBe(true);
    // 装了的那个照常能挑。
    expect(disabled("Force on Web")).toBe(false);
  });

  it("discovery=unavailable：说「这台机器此刻答不出」，绝不说成「没有技能」", async () => {
    mockedFetch.mockResolvedValue({ discovery: "unavailable", packs: [] });
    renderOne({ skills_json: `[{"id":"agentre/web","enabled":true}]` });
    expect(
      await screen.findByText(/couldn't list the skill packs/i),
    ).toBeTruthy();
    expect(screen.queryByText(/No skill packs are installed/i)).toBeNull();
    // 已授权的仍在场、仍可移除。
    expect(screen.getByText("agentre/web")).toBeTruthy();
  });

  it("discovery=unsupported：这种后端没有技能这一说，是稳定答案", async () => {
    mockedFetch.mockResolvedValue({ discovery: "unsupported", packs: [] });
    renderOne();
    expect(
      await screen.findByText(/doesn't support skill packs/i),
    ).toBeTruthy();
  });

  it("discovery=ok 且一个包都没有：这才是「一个都没装」，与答不出分开说", async () => {
    mockedFetch.mockResolvedValue({ discovery: "ok", packs: [] });
    renderOne();
    expect(
      await screen.findByText(/No skill packs are installed/i),
    ).toBeTruthy();
  });

  it("拨不通：降级成「列不出可添加的包」，已授权的仍可移除", async () => {
    mockedFetch.mockRejectedValue(new Error("relay: 连接失败"));
    const onChange = renderOne({
      skills_json: `[{"id":"agentre/web","enabled":true}]`,
    });
    expect(await screen.findByText(/couldn't be reached/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Revoke agentre\/web/ }),
    );
    expect(lastWritten(onChange)).toEqual([]);
  });

  it("离线的档不做一次注定失败的往返：不拨号，直接给离线说明", async () => {
    renderOne({ availability: "offline" });
    expect(await screen.findByText(/machine is offline/i)).toBeTruthy();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("不支持技能的后端连展开入口都没有（白名单，不拨就知道）", async () => {
    renderOne({ backend_type: "builtin" });
    // 共享件替它渲染一句「这种后端不支持技能」，没有折叠入口。
    expect(
      await screen.findByText(/No skill overrides on this target/i),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Skills for/i }),
      "不支持技能的档不该有展开入口",
    ).toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("支持技能的后端有展开入口，且展开即拨号", async () => {
    renderOne();
    expect(screen.getByRole("button", { name: /Skills for/i })).toBeTruthy();
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
  });
});
