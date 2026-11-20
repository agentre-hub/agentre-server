import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useReconnectProbe,
  useSessionTargetDevice,
} from "@/components/session/useSessionTargetDevice";
import { api, ApiError } from "@/lib/api";
import { type DeviceItem } from "@/lib/devices";
import { invalidateRosters } from "@/lib/rosterFetch";

// mock 在 api 这一层而不是 fetchDevices：初次取数走共享名单（deviceRoster），它在
// devices.ts 里直接调本模块的 fetchDevices，换掉导出够不着它。
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

/** 设备名单那一条端点的替身：交进来的是名单，线上包一层 `{ devices }`。 */
const mocked = {
  mockReset: () => mockedApi.mockReset(),
  mockResolvedValue: (list: DeviceItem[]) =>
    mockedApi.mockResolvedValue({ devices: list }),
  mockResolvedValueOnce: (list: DeviceItem[]) =>
    mockedApi.mockResolvedValueOnce({ devices: list }),
  mockRejectedValue: (e: unknown) => mockedApi.mockRejectedValue(e),
  mockRejectedValueOnce: (e: unknown) => mockedApi.mockRejectedValueOnce(e),
  get mock() {
    return mockedApi.mock;
  },
};

function machine(over: Partial<DeviceItem> = {}): DeviceItem {
  return {
    id: 7,
    name: "nuc-01",
    display_name: "",
    kind: "agentred",
    platform: "linux",
    version: "0.4.0",
    fingerprint: "sha256:aaaa",
    last_seen_at: 0,
    status: 1,
    online: true,
    is_this_device: false,
    protocol_mismatch: false,
    daemon_commit: "a1b2c3d",
    daemon_build_known: true,
    ...over,
  };
}

/** 两个 hook 在组件里是前后脚跑的，测试也照那个顺序装起来。 */
function useTarget(did: number, relayState: string) {
  const target = useSessionTargetDevice(did);
  useReconnectProbe(target.probe, did, relayState);
  return target;
}

describe("useSessionTargetDevice", () => {
  beforeEach(() => {
    mocked.mockReset();
  });

  it("认出目标那一台，并带出它的在线态", async () => {
    mocked.mockResolvedValue([machine(), machine({ id: 8, online: false })]);

    const { result } = renderHook(() => useTarget(7, "connected"));

    await waitFor(() => expect(result.current.device?.id).toBe(7));
    expect(result.current.machineOnline).toBe(true);
    expect(result.current.deviceError).toBeNull();
  });

  // 名单里没有这一台：如实报错，而不是把 device 留成 null 让页面无限转圈。
  it("名单里没有目标设备时报错", async () => {
    mocked.mockResolvedValue([machine({ id: 8 })]);

    const { result } = renderHook(() => useTarget(7, "connected"));

    await waitFor(() => expect(result.current.deviceError).toBeTruthy());
    expect(result.current.device).toBeNull();
  });

  // 上一次取数失败（网络抖动）留下的错误必须清掉：不清的话，嵌入右栏从那次失败起
  // 永久卡在错误态——之后切到哪台机器、取数多成功都只显示旧错误，只能整页刷新救回。
  it("换设备后一次成功的取数会清掉上一次的错误", async () => {
    mocked.mockRejectedValueOnce(new Error("flaky"));
    mocked.mockResolvedValue([machine({ id: 8 })]);

    const { result, rerender } = renderHook(
      ({ did }: { did: number }) => useTarget(did, "connected"),
      { initialProps: { did: 7 } },
    );
    await waitFor(() => expect(result.current.deviceError).toBeTruthy());

    rerender({ did: 8 });

    await waitFor(() => expect(result.current.device?.id).toBe(8));
    expect(result.current.deviceError).toBeNull();
  });

  // 断线原因只探一次（R11）：reconnecting 期间会反复渲染，每次都探一遍等于把一条
  // 已经连不上的链路再压上一串请求。
  it("reconnecting 期间只探一次原因", async () => {
    mocked.mockResolvedValue([machine({ online: false })]);

    const { result, rerender } = renderHook(
      ({ state }: { state: string }) => useTarget(7, state),
      { initialProps: { state: "reconnecting" } },
    );

    await waitFor(() => expect(mocked.mock.calls.length).toBe(2)); // 取设备 + 探测
    rerender({ state: "reconnecting" });
    rerender({ state: "reconnecting" });
    expect(mocked.mock.calls.length).toBe(2);
    expect(result.current.machineOnline).toBe(false);
  });

  // 规格 2026-11-20 决策 8：同一屏上外壳与对话页也在要设备名单，目标设备不再单独
  // 打一遍；但断线探因要的是**这一刻**的在线态，不吃复用。
  it("初次取数与同屏的其他调用方共用一个请求，断线探因另取新的", async () => {
    mocked.mockResolvedValue([machine()]);

    const { result, rerender } = renderHook(
      ({ state }: { state: string }) => ({
        a: useTarget(7, state),
        b: useSessionTargetDevice(7),
      }),
      { initialProps: { state: "connected" } },
    );
    await waitFor(() => expect(result.current.a.device?.id).toBe(7));
    await waitFor(() => expect(result.current.b.device?.id).toBe(7));
    expect(mocked.mock.calls.length).toBe(1);

    rerender({ state: "reconnecting" });
    await waitFor(() => expect(mocked.mock.calls.length).toBe(2));
  });

  it("名单被作废之后换台机器会取新的", async () => {
    mocked.mockResolvedValue([machine(), machine({ id: 8 })]);
    const { result, rerender } = renderHook(
      ({ did }: { did: number }) => useSessionTargetDevice(did),
      { initialProps: { did: 7 } },
    );
    await waitFor(() => expect(result.current.device?.id).toBe(7));

    act(() => invalidateRosters(null));
    rerender({ did: 8 });

    await waitFor(() => expect(result.current.device?.id).toBe(8));
    expect(mocked.mock.calls.length).toBe(2);
  });

  // 复用的名单里没有目标那一台，不能直接判「找不到」：它可能是 10 秒内刚配对的。
  // 先取一份新的再下结论，否则旧名单就把新事实藏住了。
  it("复用的名单里没有目标时先取新的再下结论", async () => {
    mocked.mockResolvedValueOnce([machine()]);
    mocked.mockResolvedValueOnce([machine(), machine({ id: 8 })]);
    const { result, rerender } = renderHook(
      ({ did }: { did: number }) => useSessionTargetDevice(did),
      { initialProps: { did: 7 } },
    );
    await waitFor(() => expect(result.current.device?.id).toBe(7));

    rerender({ did: 8 });

    await waitFor(() => expect(result.current.device?.id).toBe(8));
    expect(result.current.deviceError).toBeNull();
    expect(mocked.mock.calls.length).toBe(2);
  });

  // 探测撞上 401：会话已经失效，页面据此提示重新登录，而不是继续说「机器离线」。
  it("探测拿到 401 时判定会话失效", async () => {
    mocked.mockResolvedValueOnce([machine()]);
    mocked.mockRejectedValue(new ApiError(0, "unauthorized", 401));

    const { result } = renderHook(() => useTarget(7, "reconnecting"));

    await waitFor(() => expect(result.current.meValid).toBe(false));
  });
});
