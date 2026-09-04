import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import {
  toDeviceMentionItems,
  useDeviceMentions,
} from "@/hooks/use-device-mentions";
import { api } from "@/lib/api";
import type { DeviceItem } from "@/lib/devices";

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

const device = (over: Partial<DeviceItem> = {}): DeviceItem => ({
  id: 1,
  name: "linux-srv",
  kind: "agentred",
  platform: "linux",
  version: "0.3.0",
  fingerprint: "sha256:lan",
  last_seen_at: 1,
  status: 1,
  online: true,
  is_this_device: false,
  protocol_mismatch: false,
  daemon_commit: "",
  daemon_build_known: false,
  ...over,
});

describe("toDeviceMentionItems", () => {
  it("Given the account's devices, When they feed the @ menu, Then each keeps its fingerprint, name and reachability", () => {
    expect(
      toDeviceMentionItems([
        device(),
        device({
          id: 2,
          name: "NAS",
          fingerprint: "sha256:nas",
          online: false,
        }),
      ]),
    ).toEqual([
      { fp: "sha256:lan", name: "linux-srv", online: true },
      { fp: "sha256:nas", name: "NAS", online: false },
    ]);
  });

  // 指纹是设备提及在正文里的唯一身份(共享包的 MentionRef.fp)。写不出指纹就写不出
  // 一个指得回那台机器的引用,与其发一个 fp="" 的空壳,不如不列。
  it("Given a device with no fingerprint, When the @ menu is built, Then it is left out", () => {
    expect(toDeviceMentionItems([device({ fingerprint: "" })])).toEqual([]);
  });
});

// 这一端的宿主接缝就是「/v1/devices 的响应 → `@` 菜单的视图契约」。菜单弹层本身
// 由共享包的用例守着 —— jsdom 下 ProseMirror 的 coordsAtPos 拿不到 getClientRects,
// 弹层在这个仓库里开不出来,所以这里测到接缝为止,不去假装能观察它。
describe("useDeviceMentions", () => {
  it("Given the account has devices, When the composer mounts, Then they arrive as mention items", async () => {
    mockedApi.mockResolvedValue({ devices: [device()] });

    const { result } = renderHook(() => useDeviceMentions());

    await waitFor(() =>
      expect(result.current).toEqual([
        { fp: "sha256:lan", name: "linux-srv", online: true },
      ]),
    );
    expect(mockedApi).toHaveBeenCalledWith("/v1/devices");
  });
});
