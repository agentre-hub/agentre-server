import { beforeEach, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import {
  browserClientId,
  browserDisplayName,
  ensureRelayTicket,
  storedBrowserClientId,
} from "@/lib/relayTicket";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

it("does not reuse the removed device fingerprint storage key", () => {
  localStorage.setItem("agentre.deviceFingerprint", "old-fingerprint");

  expect(storedBrowserClientId()).toBeNull();
  expect(localStorage.getItem("agentre.browserClientId")).toBeNull();
});

const mockedApi = vi.mocked(api);

beforeEach(() => {
  localStorage.clear();
  mockedApi.mockReset();
});

it("uses a stable browser client id but creates no device", async () => {
  mockedApi.mockResolvedValue({
    access_token: "relay-ticket",
    expires_in: 120,
  });

  const firstId = browserClientId();
  const secondId = browserClientId();
  const ticket = await ensureRelayTicket();

  expect(secondId).toBe(firstId);
  expect(ticket).toEqual({
    accessToken: "relay-ticket",
    clientId: firstId,
    clientName: browserDisplayName(),
  });
  expect(mockedApi).toHaveBeenCalledWith("/v1/relay/ticket", {
    method: "POST",
  });
  expect(mockedApi).not.toHaveBeenCalledWith(
    "/v1/oauth/device/register",
    expect.anything(),
  );
});
