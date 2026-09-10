/**
 * 输入框里那份 Skill 补全（`useSessionSkillCommands`）。
 *
 * 它要拼齐三样事实，来路各不相同，这正是它存在的理由：
 *   · **问哪台机器** —— 这条会话跑在哪，指纹从组织读端点那一档下行；
 *   · **带哪份授权** —— R15e「一档一块」的授权存在组织架构库里，那台机器上没有；
 *   · **在哪个目录** —— 项目级 skill 只在这一轮的 cwd 下才解析得出来。
 *
 * 拼不齐就一条都不问：发一次注定答错的调用，代价是菜单里出现一批叫不动的名字。
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { fetchSkillCommands } from "@/lib/skillCatalog";

import { useSessionSkillCommands } from "@/hooks/use-session-skill-commands";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
// 只替中继那一次调用：`parseSkillAuthorizations` 是同模块里的纯函数，整块 mock
// 掉会让它变成 undefined，于是授权解析静默失败成空授权——正是本用例要钉的那格。
vi.mock("@/lib/skillCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/skillCatalog")>()),
  fetchSkillCommands: vi.fn(),
}));

const mockedApi = vi.mocked(api);
const mockedFetch = vi.mocked(fetchSkillCommands);

/** 一份组织读端点的应答：一个 agent、两档执行目标(两台不同的机器)。 */
const ORG = {
  agents: [
    {
      sync_id: "agent-1",
      exec_targets: [
        {
          sync_id: "t-other",
          backend_type: "claudecode",
          device_fingerprint: "fp-other",
          skills_json: '[{"id":"other@pack","enabled":true}]',
          current: false,
        },
        {
          sync_id: "t-here",
          backend_type: "claudecode",
          device_fingerprint: "fp-here",
          skills_json: '[{"id":"superpowers@official","enabled":true}]',
          current: true,
        },
      ],
    },
  ],
};

beforeEach(() => {
  mockedApi.mockReset();
  mockedFetch.mockReset();
  mockedApi.mockResolvedValue(ORG as never);
  mockedFetch.mockResolvedValue({ commands: [], discovery: "ok" });
});

describe("useSessionSkillCommands", () => {
  it("按指纹认出这一档，把它的授权与这一轮的 cwd 一起报过去", async () => {
    mockedFetch.mockResolvedValue({
      commands: [{ name: "cago", description: "cago 框架" }],
      discovery: "ok",
    });

    const { result } = renderHook(() =>
      useSessionSkillCommands({
        agentSyncId: "agent-1",
        backendType: "claudecode",
        fingerprint: "fp-here",
        cwd: "/srv/project",
      }),
    );

    await waitFor(() =>
      expect(result.current).toEqual([
        { name: "cago", description: "cago 框架" },
      ]),
    );
    expect(mockedFetch).toHaveBeenCalledWith({
      fingerprint: "fp-here",
      backendType: "claudecode",
      cwd: "/srv/project",
      // 认的是**这台机器上那一档**的授权，不是排在最前的那一档。
      authorized: [{ id: "superpowers@official", enabled: true }],
    });
  });

  it("这台机器上没有对得上的档时按空授权问 —— 机器仍答得出它自己的 skill", async () => {
    mockedFetch.mockResolvedValue({
      commands: [{ name: "init" }],
      discovery: "ok",
    });

    const { result } = renderHook(() =>
      useSessionSkillCommands({
        agentSyncId: "agent-1",
        backendType: "claudecode",
        fingerprint: "fp-stranger",
        cwd: "",
      }),
    );

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(mockedFetch).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: "fp-stranger", authorized: [] }),
    );
  });

  it("没有指纹或没有 backend 时一次都不问", async () => {
    const { result, rerender } = renderHook(
      (props: { fingerprint: string; backendType: string }) =>
        useSessionSkillCommands({
          agentSyncId: "agent-1",
          cwd: "",
          ...props,
        }),
      { initialProps: { fingerprint: "", backendType: "claudecode" } },
    );

    expect(result.current).toEqual([]);
    rerender({ fingerprint: "fp-here", backendType: "" });
    await Promise.resolve();
    expect(result.current).toEqual([]);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("这台机器答不出时给空清单 —— 输入框照常能用，只是没有补全", async () => {
    mockedFetch.mockRejectedValue(new Error("拨不通"));

    const { result } = renderHook(() =>
      useSessionSkillCommands({
        agentSyncId: "agent-1",
        backendType: "claudecode",
        fingerprint: "fp-here",
        cwd: "",
      }),
    );

    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it("组织读端点失败也不阻断：按空授权照问一次", async () => {
    mockedApi.mockRejectedValue(new Error("401"));
    mockedFetch.mockResolvedValue({
      commands: [{ name: "init" }],
      discovery: "ok",
    });

    const { result } = renderHook(() =>
      useSessionSkillCommands({
        agentSyncId: "agent-1",
        backendType: "claudecode",
        fingerprint: "fp-here",
        cwd: "",
      }),
    );

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(mockedFetch).toHaveBeenCalledWith(
      expect.objectContaining({ authorized: [] }),
    );
  });
});
