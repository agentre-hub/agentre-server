import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import * as accountChannel from "@/lib/accountChannel";
import { useOrgData } from "@/pages/org/useOrgData";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn() };
});

const mockedApi = vi.mocked(api);
const mockedStartChannel = vi.mocked(accountChannel.startAccountChannel);
const {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
  AccountChannelSyncVersion,
} = accountChannel;

/**
 * 组织面自己的取数与账号级通道挂载（规格「server 端的组织管理面」+「账号级实时
 * 通道」）。**验收的核心断言在最后一条用例**：通道整个连不上时，组织面的首次加载
 * 与刷新都不受影响——通道只是「早一点知道该拉了」，不是数据能不能拉到的前提。
 */
describe("useOrgData", () => {
  let stop: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    mockedApi.mockReset();
    mockedStartChannel.mockReset();
    stop = vi.fn<() => void>();
    mockedStartChannel.mockReturnValue({ stop });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Given the page mounts, When data loads, Then it fetches both the org chart and the backend picker list", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/workspace/org") {
        return { departments: [], agents: [] };
      }
      if (path === "/v1/workspace/org/backends") {
        return { backends: [] };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const { result } = renderHook(() => useOrgData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.chart).toEqual({ departments: [], agents: [] });
    expect(result.current.backends).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("Given the account channel is mounted, When the hook unmounts, Then the channel is stopped", async () => {
    mockedApi.mockResolvedValue({ departments: [], agents: [], backends: [] });

    const { unmount } = renderHook(() => useOrgData());
    await waitFor(() => expect(mockedStartChannel).toHaveBeenCalledTimes(1));

    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("Given the account channel signals a refresh, When onRefresh fires, Then the org data is re-fetched", async () => {
    let callCount = 0;
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/workspace/org") {
        callCount += 1;
        return { departments: [], agents: [] };
      }
      return { backends: [] };
    });

    renderHook(() => useOrgData());
    await waitFor(() => expect(mockedStartChannel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(callCount).toBe(1));

    const onRefresh = mockedStartChannel.mock.calls[0][0].onRefresh;
    await act(async () => onRefresh(AccountChannelSyncVersion));

    await waitFor(() => expect(callCount).toBe(2));

    // 组织面只认同步版本那一类。别人发了条消息、一台机器上线，都与这一页无关：
    // 跟着重打两条请求纯属白费。
    await act(async () => onRefresh(AccountChannelMirrorChanged));
    await act(async () => onRefresh(AccountChannelDevicePresence));
    expect(callCount).toBe(2);

    // 建连 / 重连 / 兜底轮询那一路说不出种类，照样重拉：它的意思是「你可能落后了」。
    await act(async () => onRefresh(null));
    await waitFor(() => expect(callCount).toBe(3));
  });

  it("Given the account channel never connects at all (mount throws / handle is inert), When the hook is used, Then the initial load still succeeds — nothing about the org face depends on the channel being up", async () => {
    mockedApi.mockImplementation(async (path: string) =>
      path === "/v1/workspace/org"
        ? { departments: [], agents: [] }
        : { backends: [] },
    );
    // 通道整个连不上的极端：mount 本身就抛。组织面必须照常能读到数据。
    mockedStartChannel.mockImplementation(() => {
      throw new Error("channel unavailable");
    });

    const { result } = renderHook(() => useOrgData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.chart).toEqual({ departments: [], agents: [] });
  });

  it("Given the org endpoint fails, When reload runs, Then it surfaces an error message instead of throwing", async () => {
    mockedApi.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useOrgData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeTruthy();
  });
});
