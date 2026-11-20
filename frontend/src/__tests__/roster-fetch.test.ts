/**
 * 名单共享取数（规格 2026-11-20 决策 8）。
 *
 * 设备、Agent、项目名单与「需要你」计数：同一时刻多个调用方共用一个在飞请求，结果
 * 在约 10 秒内复用；收到对应的账号信号、`refresh(null)`、写操作或用户的重试时作废。
 *
 * 断言一律数 `api()` 的调用次数：这里要证的就是「同一屏上不再各打各的」。
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAccountChannel } from "@/hooks/use-account-channel";
import * as accountChannel from "@/lib/accountChannel";
import { agentRoster } from "@/lib/agents";
import { api } from "@/lib/api";
import { attentionRoster } from "@/lib/attentionCount";
import { deviceRoster, renameDevice } from "@/lib/devices";
import { createProject, projectRoster } from "@/lib/projects";
import { invalidateRosters, RosterReuseMs } from "@/lib/rosterFetch";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedApi = vi.mocked(api);

function callsTo(path: string): number {
  return mockedApi.mock.calls.filter(([p]) => String(p) === path).length;
}

/** 每条路径一份能区分出「是第几次取」的应答。 */
function serve() {
  let n = 0;
  mockedApi.mockImplementation(async (path: string) => {
    n += 1;
    switch (path) {
      case "/v1/devices":
        return { devices: [{ id: n }] };
      case "/v1/workspace/agents":
        return { agents: [{ sync_id: `a${n}` }] };
      case "/v1/workspace/projects":
        return { projects: [{ sync_id: `p${n}`, name: "p" }] };
      case "/v1/agent-sessions/attention-count":
        return { needs_attention: n, unread: 0 };
      case "/v1/devices/1":
        return { display_name: "x" };
      case "/v1/workspace/org/projects":
        return { sync_id: "p", version: 1 };
      default:
        throw new Error("unexpected: " + path);
    }
  });
}

beforeEach(() => {
  mockedApi.mockReset();
  serve();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("共用在飞请求", () => {
  it("同一时刻的几个调用方只打一个请求，拿到的是同一份结果", async () => {
    const [a, b, c] = await Promise.all([
      deviceRoster.get(),
      deviceRoster.get(),
      deviceRoster.get(),
    ]);

    expect(callsTo("/v1/devices")).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("四份名单各是各的请求，互不顶替", async () => {
    await Promise.all([
      deviceRoster.get(),
      agentRoster.get(),
      projectRoster.get(),
      attentionRoster.get(),
    ]);

    expect(callsTo("/v1/devices")).toBe(1);
    expect(callsTo("/v1/workspace/agents")).toBe(1);
    expect(callsTo("/v1/workspace/projects")).toBe(1);
    expect(callsTo("/v1/agent-sessions/attention-count")).toBe(1);
  });
});

describe("短期复用", () => {
  it("取回来之后 10 秒内再问，复用那一份；过了 10 秒重新取", async () => {
    vi.useFakeTimers();
    const first = await deviceRoster.get();

    vi.advanceTimersByTime(RosterReuseMs - 1);
    expect(await deviceRoster.get()).toBe(first);
    expect(callsTo("/v1/devices")).toBe(1);

    vi.advanceTimersByTime(1);
    const second = await deviceRoster.get();
    expect(callsTo("/v1/devices")).toBe(2);
    expect(second).not.toBe(first);
  });

  it("失败不进缓存：下一次调用重新取", async () => {
    mockedApi.mockRejectedValueOnce(new Error("network down"));
    await expect(deviceRoster.get()).rejects.toThrow("network down");

    await expect(deviceRoster.get()).resolves.toEqual([{ id: 1 }]);
    expect(callsTo("/v1/devices")).toBe(2);
  });

  it("在飞时被作废：之后的调用另起一个请求，旧的那次回来也不覆盖新的", async () => {
    let releaseFirst!: (v: unknown) => void;
    mockedApi.mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = resolve)),
    );
    const stale = deviceRoster.get();

    deviceRoster.invalidate();
    const fresh = await deviceRoster.get();
    releaseFirst({ devices: [{ id: 99 }] });
    await stale;

    expect(await deviceRoster.get()).toBe(fresh);
    expect(callsTo("/v1/devices")).toBe(2);
  });
});

describe("作废", () => {
  async function warmAll() {
    await Promise.all([
      deviceRoster.get(),
      agentRoster.get(),
      projectRoster.get(),
      attentionRoster.get(),
    ]);
    mockedApi.mockClear();
  }
  async function readAll() {
    await Promise.all([
      deviceRoster.get(),
      agentRoster.get(),
      projectRoster.get(),
      attentionRoster.get(),
    ]);
  }

  it("在线态信号只作废设备", async () => {
    await warmAll();
    invalidateRosters(accountChannel.AccountChannelDevicePresence);
    await readAll();

    expect(callsTo("/v1/devices")).toBe(1);
    expect(mockedApi).toHaveBeenCalledTimes(1);
  });

  it("同步版本信号作废 Agent 与项目", async () => {
    await warmAll();
    invalidateRosters(accountChannel.AccountChannelSyncVersion);
    await readAll();

    expect(callsTo("/v1/workspace/agents")).toBe(1);
    expect(callsTo("/v1/workspace/projects")).toBe(1);
    expect(mockedApi).toHaveBeenCalledTimes(2);
  });

  it("镜像信号作废「需要你」计数", async () => {
    await warmAll();
    invalidateRosters(accountChannel.AccountChannelMirrorChanged);
    await readAll();

    expect(callsTo("/v1/agent-sessions/attention-count")).toBe(1);
    expect(mockedApi).toHaveBeenCalledTimes(1);
  });

  it("null（建连 / 重连 / 轮询 / 用户重试）作废全部", async () => {
    await warmAll();
    invalidateRosters(null);
    await readAll();

    expect(mockedApi).toHaveBeenCalledTimes(4);
  });

  it("账号通道的信号一到就作废，不等订阅者自己想起来", async () => {
    renderHook(() => useAccountChannel(["unrelated"], () => {}));
    await deviceRoster.get();
    const call = vi
      .mocked(accountChannel.startAccountChannel)
      .mock.calls.at(-1);

    call![0].onRefresh(accountChannel.AccountChannelDevicePresence);
    await deviceRoster.get();
    call![0].onRefresh(null);
    await deviceRoster.get();

    expect(callsTo("/v1/devices")).toBe(3);
  });

  it("改设备备注名之后设备名单作废", async () => {
    await deviceRoster.get();
    await renameDevice(1, "x");
    await deviceRoster.get();

    expect(callsTo("/v1/devices")).toBe(2);
  });

  it("项目写操作之后项目树作废——失败也作废，服务端可能已经写进去了", async () => {
    await projectRoster.get();
    await createProject({ name: "n" });
    await projectRoster.get();
    expect(callsTo("/v1/workspace/projects")).toBe(2);

    mockedApi.mockRejectedValueOnce(new Error("timeout"));
    await expect(createProject({ name: "n" })).rejects.toThrow("timeout");
    await projectRoster.get();
    expect(callsTo("/v1/workspace/projects")).toBe(3);
  });
});
