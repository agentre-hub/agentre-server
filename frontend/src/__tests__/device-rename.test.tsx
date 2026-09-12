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
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";
import Devices from "@/pages/Devices";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

function renderDevices() {
  return render(
    <MemoryRouter>
      <Devices />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

/**
 * 三台设备，全都自报同一个主机名——这就是这个功能存在的理由：同一台 Mac 上的三个
 * checkout 在账号里就是三行一模一样的 `wangyizhideMacBook-Pro.local`，要撤销其中一台
 * 时用户根本不知道该点哪一个。第二台已经起了备注名。
 */
const listResponse = {
  devices: [
    {
      id: 1,
      name: "wangyizhideMacBook-Pro.local",
      display_name: "",
      kind: "desktop",
      platform: "darwin/arm64",
      version: "dev",
      fingerprint: "fp-1",
      last_seen_at: 1754000000000,
      status: 1,
      online: false,
      is_this_device: false,
    },
    {
      id: 2,
      name: "wangyizhideMacBook-Pro.local",
      display_name: "主 checkout",
      kind: "desktop",
      platform: "darwin/arm64",
      version: "dev",
      fingerprint: "fp-2",
      last_seen_at: 1754000000000,
      status: 1,
      online: false,
      is_this_device: true,
    },
  ],
};

/** 打开某一行的改名对话框：行级更多菜单 → 「重命名」。 */
async function openRenameDialog(rowName: string) {
  const row = screen
    .getByText(rowName)
    .closest('[data-slot="card"]') as HTMLElement;
  // Radix 的菜单开在 pointerdown 上，不是 click。
  fireEvent.pointerDown(
    within(row).getByRole("button", { name: `Actions for ${rowName}` }),
    { button: 0, ctrlKey: false },
  );
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
  return screen.findByRole("dialog");
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
});

describe("设备备注名（账号级）", () => {
  it("设过备注名的行显示备注名，没设过的显示设备自报名", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();

    expect(await screen.findByText("主 checkout")).toBeTruthy();
    expect(screen.getByText("wangyizhideMacBook-Pro.local")).toBeTruthy();
  });

  it("改名走 PATCH /v1/devices/:id，成功后整行跟着改口", async () => {
    let renamed = false;
    const calls: { path: string; init?: RequestInit }[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/devices") {
        return renamed
          ? {
              devices: [
                { ...listResponse.devices[0], display_name: "办公室那台" },
                listResponse.devices[1],
              ],
            }
          : listResponse;
      }
      if (path === "/v1/devices/1") {
        renamed = true;
        return { display_name: "办公室那台" };
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("wangyizhideMacBook-Pro.local");
    const dialog = await openRenameDialog("wangyizhideMacBook-Pro.local");

    const input = within(dialog).getByRole("textbox") as HTMLInputElement;
    // 没设过备注名时输入框是空的，设备自报名退到占位符上——不然用户一打开就以为
    // 自己已经起过名字，清空反而成了唯一能表达「用自报名」的操作。
    expect(input.value).toBe("");
    expect(input.getAttribute("placeholder")).toBe(
      "wangyizhideMacBook-Pro.local",
    );

    fireEvent.change(input, { target: { value: "办公室那台" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("办公室那台")).toBeTruthy());
    const patch = calls.find((c) => c.path === "/v1/devices/1");
    expect(patch).toBeTruthy();
    expect(patch?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      display_name: "办公室那台",
    });
  });

  it("已有备注名的行打开就带着它，清空即回落到设备自报名", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/devices/2")
        return { display_name: "wangyizhideMacBook-Pro.local" };
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("主 checkout");
    const dialog = await openRenameDialog("主 checkout");

    const input = within(dialog).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("主 checkout");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(calls.some((c) => c.path === "/v1/devices/2")).toBe(true),
    );
    expect(
      JSON.parse(
        String(calls.find((c) => c.path === "/v1/devices/2")?.init?.body),
      ),
    ).toEqual({ display_name: "" });
  });

  it("改名失败时保留对话框与输入，并说出这件事没成", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/devices/1") throw new Error("boom");
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("wangyizhideMacBook-Pro.local");
    const dialog = await openRenameDialog("wangyizhideMacBook-Pro.local");

    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "办公室那台" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(within(dialog).getByText(/Could not rename/)).toBeTruthy(),
    );
    // 输入没被吞掉：重试不必重打一遍。
    expect(
      (within(dialog).getByRole("textbox") as HTMLInputElement).value,
    ).toBe("办公室那台");
  });

  it("撤销确认框点名的是生效的显示名，不是设备自报名", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    const row = (await screen.findByText("主 checkout")).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    fireEvent.pointerDown(
      within(row).getByRole("button", { name: "Actions for 主 checkout" }),
      { button: 0, ctrlKey: false },
    );
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Revoke" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Revoke 主 checkout?")).toBeTruthy();
  });
});
