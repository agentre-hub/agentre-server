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
import i18n from "@/i18n";
import Devices from "@/pages/Devices";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const listResponse = {
  devices: [
    {
      id: 1,
      name: "nuc-01",
      kind: "agentred",
      platform: "linux",
      version: "0.4.0",
      fingerprint: "fp-1",
      capabilities: { code: true, files: true },
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
      capabilities: { code: true },
      last_seen_at: 1753990000000,
      status: 1,
      online: false,
      is_this_device: true,
    },
  ],
};

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

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    expect(await screen.findByText("nuc-01")).toBeTruthy();
    expect(screen.getByText("laptop")).toBeTruthy();
    expect(screen.getByText(/Compute node/)).toBeTruthy();
    expect(screen.getByText(/Desktop/)).toBeTruthy();
    expect(screen.getByText(/linux/)).toBeTruthy();
    expect(screen.getByText(/darwin/)).toBeTruthy();
    // 在线态列来自 API 的 online 字段（真实中继在线态），不是 status 推算（R20）：
    // 逐行按 API 给的 online 值断言，而不是全页面找一个 "Online" 就算数。
    const nucCard = screen.getByText("nuc-01").closest('[data-slot="card"]');
    const laptopCard = screen.getByText("laptop").closest('[data-slot="card"]');
    expect(within(nucCard as HTMLElement).getByText(/Online/)).toBeTruthy();
    expect(within(laptopCard as HTMLElement).getByText(/Offline/)).toBeTruthy();
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

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findByText("nuc-01");

    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);

    const dialog = await screen.findByRole("dialog");
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

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Could not load your devices. Please try again."),
    ).toBeTruthy();
    expect(
      screen.queryByText(/No devices yet\. Devices you authorize/),
    ).toBeNull();
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

    render(
      <MemoryRouter>
        <Devices />
      </MemoryRouter>,
    );
    await screen.findByText("nuc-01");

    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);
    const dialog = await screen.findByRole("dialog");
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
});
