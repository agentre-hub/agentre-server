import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import i18n from "@/i18n";
import Device from "@/pages/Device";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const pendingAgentred = {
  device_kind: "agentred",
  platform: "linux",
  version: "0.4.0",
  capabilities: { code: true, files: true },
  expires_in: 600,
};

const pendingDesktop = {
  device_kind: "desktop",
  platform: "darwin",
  version: "0.3.0",
  capabilities: { code: true },
  expires_in: 600,
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.history.replaceState({}, "", "/device?user_code=A4F7Q2");
  mockedApi.mockReset();
});

describe("approval risk copy", () => {
  it("compute node (agentred) approval states the arbitrary-code risk", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path.startsWith("/v1/oauth/device/pending")) return pendingAgentred;
      throw new Error("unexpected call: " + path);
    });

    render(
      <MemoryRouter>
        <Device />
      </MemoryRouter>,
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/compute node/i)).toBeTruthy();
    expect(within(dialog).getByText(/arbitrary code/i)).toBeTruthy();
  });

  it("view-only client (desktop) approval keeps the standard copy without the risk", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path.startsWith("/v1/oauth/device/pending")) return pendingDesktop;
      throw new Error("unexpected call: " + path);
    });

    render(
      <MemoryRouter>
        <Device />
      </MemoryRouter>,
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Authorize this device")).toBeTruthy();
    expect(within(dialog).queryByText(/arbitrary code/i)).toBeNull();
    expect(within(dialog).queryByText(/compute node/i)).toBeNull();
  });
});
