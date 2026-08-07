import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { api, ApiError } from "@/lib/api";
import Device from "../Device";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const pending = {
  device_kind: "agentred",
  platform: "darwin",
  version: "0.1.0",
  capabilities: { compute: true },
  expires_in: 600,
};

function renderDevice() {
  return render(
    <MemoryRouter>
      <Device />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  // 文案断言按英文写，锁住语言，免得跟着宿主环境的 navigator.language 漂。
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  window.history.replaceState({}, "", "/device?user_code=A4F-7Q2");
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("Device deny", () => {
  it("surfaces the server error when the code is no longer deniable", async () => {
    // 服务端把 deny 改成了带条件的 UPDATE：行已被换取/已拒绝时命中 0 行，
    // 返回 400 user_code_invalid。此时 onDeny 里的 api() 会抛，页面必须把
    // 这条错误显示出来——否则对话框原地不动、没有任何反馈，用户走不下去。
    // 30205 / 这条文案就是后端 code.DeviceFlowUserCodeInvalid 的原样返回。
    const serverMsg = "user_code malformed or not found";
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/oauth/device/pending")) return pending;
      throw new ApiError(30205, serverMsg, 400);
    });

    renderDevice();
    const denyButton = await screen.findByRole("button", { name: "Deny" });
    fireEvent.click(denyButton);

    expect(await screen.findByText(serverMsg)).toBeTruthy();
  });

  it("shows the denied notice and closes the dialog on success", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/oauth/device/pending")) return pending;
      return {};
    });

    renderDevice();
    const denyButton = await screen.findByRole("button", { name: "Deny" });
    fireEvent.click(denyButton);

    expect(
      await screen.findByText("Authorization denied. You can close this page."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Deny" })).toBeNull(),
    );
  });
});
