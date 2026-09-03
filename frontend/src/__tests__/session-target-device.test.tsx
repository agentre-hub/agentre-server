import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useReconnectProbe,
  useSessionTargetDevice,
} from "@/components/session/useSessionTargetDevice";
import { ApiError } from "@/lib/api";
import { fetchDevices, type DeviceItem } from "@/lib/devices";

vi.mock("@/lib/devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/devices")>();
  return { ...actual, fetchDevices: vi.fn() };
});

const mocked = vi.mocked(fetchDevices);

function machine(over: Partial<DeviceItem> = {}): DeviceItem {
  return {
    id: 7,
    name: "nuc-01",
    kind: "agentred",
    platform: "linux",
    version: "0.4.0",
    fingerprint: "sha256:aaaa",
    last_seen_at: 0,
    status: 1,
    online: true,
    is_this_device: false,
    protocol_mismatch: false,
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

  // 探测撞上 401：会话已经失效，页面据此提示重新登录，而不是继续说「机器离线」。
  it("探测拿到 401 时判定会话失效", async () => {
    mocked.mockResolvedValueOnce([machine()]);
    mocked.mockRejectedValue(new ApiError(0, "unauthorized", 401));

    const { result } = renderHook(() => useTarget(7, "reconnecting"));

    await waitFor(() => expect(result.current.meValid).toBe(false));
  });
});
