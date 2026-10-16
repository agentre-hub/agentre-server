import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import { AddDeviceGuide } from "@/components/AddDeviceGuide";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import Devices from "@/pages/Devices";

import { edgeClasses } from "./helpers/edge-classes";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/hooks/use-relay", () => ({
  useRelayChannel: (target: string | null) => ({
    client: target
      ? { request: async () => ({ total: 3n, running: 2n, waiting: 1n }) }
      : null,
    relayState: target ? "connected" : "disconnected",
    relayTicket: null,
    relayTicketError: null,
    handshakeRejection: null,
  }),
}));

const mockedApi = vi.mocked(api);

const device = {
  id: 1,
  name: "build-box-02",
  kind: "agentred",
  platform: "linux/amd64",
  version: "0.5.2",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
  is_this_device: false,
  protocol_mismatch: false,
  daemon_commit: "a1b2c3d",
  daemon_build_known: true,
};

function mockConsole(devices: unknown[]) {
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/devices") return { devices };
    if (path === "/v1/release/latest") return { known: true, version: "0.6.0" };
    if (path.startsWith("/v1/workspace/device-detail"))
      return {
        device_id: 1,
        kind: "agentred",
        runnable_agents: [
          { sync_id: "agent-1", name: "Frontend Agent", rank: 2 },
        ],
        projects: [{ sync_id: "proj-1", name: "proj", configured: true }],
      };
    throw new Error("unexpected call: " + path);
  });
}

function renderDevices() {
  return render(
    <MemoryRouter>
      <Devices />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

function withMobile<T>(mobile: boolean, run: () => Promise<T>) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return run().finally(() => {
    window.matchMedia = original;
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
});

describe("devices page is borderless", () => {
  it("desktop row, expanded panels (details, port forward, upgrade) draw no edges", async () => {
    mockConsole([device]);
    renderDevices();
    await screen.findByText("build-box-02");
    fireEvent.click(screen.getByTestId("device-expand-1"));
    await screen.findByTestId("device-upgrade-1");
    await screen.findByText("Frontend Agent");

    expect(edgeClasses(screen.getByTestId("device-row-1"))).toEqual([]);
  });

  it("blocked upgrade panel draws no edges", async () => {
    mockConsole([{ ...device, protocol_mismatch: true }]);
    renderDevices();
    await screen.findByText("build-box-02");
    fireEvent.click(screen.getByTestId("device-expand-1"));
    await screen.findByTestId("device-upgrade-1");

    expect(edgeClasses(screen.getByTestId("device-upgrade-1"))).toEqual([]);
  });

  it("mobile row draws no edges", async () => {
    mockConsole([device]);
    await withMobile(true, async () => {
      renderDevices();
      await screen.findByText("build-box-02");
      expect(edgeClasses(screen.getByTestId("device-row-1"))).toEqual([]);
    });
  });

  it("loading skeleton draws no edges", () => {
    mockedApi.mockImplementation(() => new Promise(() => {}));
    renderDevices();
    expect(edgeClasses(screen.getByTestId("device-list-skeleton"))).toEqual([]);
  });

  it("the page is not wrapped in a card; only rows are cards", async () => {
    mockConsole([device]);
    const { container } = renderDevices();
    await screen.findByText("build-box-02");
    for (const card of container.querySelectorAll('[data-slot="card"]')) {
      expect((card as HTMLElement).dataset.testid).toMatch(/^device-row-/);
    }
  });
});

describe("add-device guide is borderless", () => {
  function renderGuide() {
    return render(
      <MemoryRouter>
        <AddDeviceGuide />
      </MemoryRouter>,
      { wrapper: ThemeProvider },
    );
  }

  it("every step (agentred and desktop kinds) draws no edges, footers included", () => {
    renderGuide();
    const guide = screen.getByTestId("add-device-guide");
    expect(edgeClasses(guide)).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", { name: "Desktop (Agentre App)" }),
    );
    expect(edgeClasses(guide)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: /^Step 2/ }));
    expect(edgeClasses(guide)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /^Step 3/ }));
    expect(edgeClasses(guide)).toEqual([]);
  });

  it("the command and its label are one fill component", () => {
    renderGuide();
    const command = screen.getByTestId("add-device-command-login");
    const block = within(
      command.closest('[role="group"]') as HTMLElement,
    ).getByTestId("add-device-copy-login");
    expect(block).toBeTruthy();
    expect(command.closest('[role="group"]')?.className).toContain(
      "bg-field-fill",
    );
  });
});
