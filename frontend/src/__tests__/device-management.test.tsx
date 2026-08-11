import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { ThemeProvider } from "@/lib/theme";
import i18n from "@/i18n";
import Devices from "@/pages/Devices";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

// Devices 现在也套 AuthLayout，顶栏里的 AppControls 要从 context 取主题。
function renderDevices() {
  return render(
    <MemoryRouter>
      <Devices />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

const listResponse = {
  devices: [
    {
      id: 1,
      name: "nuc-01",
      kind: "agentred",
      platform: "linux",
      version: "0.4.0",
      fingerprint: "fp-1",
      last_seen_at: 1754000000000,
      status: 1,
      online: true,
      is_this_device: false,
    },
    {
      id: 2,
      name: "laptop",
      kind: "desktop",
      platform: "darwin",
      version: "0.3.0",
      fingerprint: "fp-2",
      last_seen_at: 1753990000000,
      status: 1,
      online: false,
      is_this_device: true,
    },
  ],
};

/**
 * 撤销入口在行级更多菜单（规格「设备」节）：打开某行菜单 → 点「撤销」→ 确认框。
 */
async function openRevokeDialog(deviceName: string) {
  const row = screen
    .getByText(deviceName)
    .closest('[data-slot="card"]') as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Row actions" }));
  const menu = await within(row).findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Revoke" }));
  return screen.findByRole("dialog");
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
});

describe("device management page", () => {
  it("lists every device with name, kind, platform, last-active and status", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();

    expect(await screen.findByText("nuc-01")).toBeTruthy();
    expect(screen.getByText("laptop")).toBeTruthy();
    expect(screen.getByText(/Compute node/)).toBeTruthy();
    // 精确匹配「Desktop」类型 chip：TopBar 的 Fresh（Desktop connected）也含
    // Desktop 子串，宽正则会把两个都捞回来（设计对齐后页面多了一个 Desktop 文本）。
    expect(screen.getByText("Desktop")).toBeTruthy();
    expect(screen.getByText(/linux/)).toBeTruthy();
    expect(screen.getByText(/darwin/)).toBeTruthy();
    // 在线态列来自 API 的 online 字段（真实中继在线态），不是 status 推算（R20）：
    // 逐行断言；desktop 离线要表达 App 未运行，而不是笼统的机器离线。
    const nucCard = screen.getByText("nuc-01").closest('[data-slot="card"]');
    const laptopCard = screen.getByText("laptop").closest('[data-slot="card"]');
    expect(within(nucCard as HTMLElement).getByText(/Online/)).toBeTruthy();
    expect(
      within(laptopCard as HTMLElement).getByText(/Agentre is not running/),
    ).toBeTruthy();
  });

  it("revoke confirmation carries the R4 delay note, then revokes and removes the device", async () => {
    let revoked = false;
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") {
        return revoked
          ? { devices: listResponse.devices.filter((d) => d.id !== 1) }
          : listResponse;
      }
      if (path === "/v1/oauth/token/revoke") {
        revoked = true;
        return {};
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    const dialog = await openRevokeDialog("nuc-01");
    expect(within(dialog).getByText("Revoke this device?")).toBeTruthy();
    const body =
      within(dialog).getByText(/can no longer refresh/i).textContent ?? "";
    expect(body).toMatch(/can no longer refresh/i);
    expect(body).toMatch(/offline/i);
    expect(body).toMatch(/still be accepted/i);
    expect(body).toMatch(/not instant/i);

    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/oauth/token/revoke",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"device_id":1'),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("nuc-01")).toBeNull();
    });
    expect(screen.getByText("laptop")).toBeTruthy();
  });

  // 列表加载失败必须说出来。只认 ApiError 会让「代理返回非 JSON 的 502」「浏览器离线」
  // 这类 SyntaxError / TypeError 被静默吞掉，而 finally 照样把 loading 置 false ——
  // 用户看到的是「还没有任何设备」，而他名下的设备一台没少。
  it("reports a load failure instead of rendering the empty state", async () => {
    mockedApi.mockImplementation(async () => {
      throw new SyntaxError("Unexpected token '<' ... is not valid JSON");
    });

    renderDevices();

    expect(
      await screen.findByText("Could not load your devices. Please try again."),
    ).toBeTruthy();
    expect(screen.queryByText("No devices yet.")).toBeNull();
  });

  it("keeps the device and shows an error when revoke fails", async () => {
    let calls = 0;
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/oauth/token/revoke") {
        calls += 1;
        throw new Error("boom");
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    const dialog = await openRevokeDialog("nuc-01");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(calls).toBe(1));
    expect(
      within(dialog).getByText(
        "Could not revoke this device. Please try again.",
      ),
    ).toBeTruthy();
    // 「keeps the device」这一半也要断言：撤销失败时那一行不能被乐观地移掉。
    expect(screen.getByText("nuc-01")).toBeTruthy();
  });

  // 规格「设备」节：不可撤销的设备不显示撤销动作。已撤销（status≠ACTIVE）的
  // 设备没有可撤销的凭据，行级菜单里不能出现「撤销」。
  it("a revoked device shows no revoke action in its row menu", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices")
        return {
          devices: [
            {
              id: 7,
              name: "retired",
              kind: "agentred",
              platform: "linux",
              version: "0.2.0",
              fingerprint: "fp-7",
              last_seen_at: 1753000000000,
              status: 2,
              online: false,
              is_this_device: false,
            },
          ],
        };
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    const row = (await screen.findByText("retired")).closest(
      '[data-slot="card"]',
    ) as HTMLElement;

    // 已撤销行连行级菜单都不渲染（没有可做的动作）
    expect(
      within(row).queryByRole("button", { name: "Row actions" }),
    ).toBeNull();
  });
});
