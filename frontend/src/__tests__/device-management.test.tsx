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
    expect(screen.getAllByText(/Online/).length).toBeGreaterThan(0);
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
  });
});
