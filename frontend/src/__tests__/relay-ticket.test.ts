import { beforeEach, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { browserDisplayName, ensureRelayTicket } from "@/lib/relayTicket";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

beforeEach(() => {
  localStorage.clear();
  mockedApi.mockReset();
});

// 决策 8/9：对端身份由服务端从账号派生并签进票里，浏览器只是把它读出来用。
// 自己生成一个存在 localStorage 里的随机数，清一次站点数据就换人，此前从网页发起
// 的对话在账号镜像里当场成为孤儿。
it("takes its client id from the ticket the server issued", async () => {
  mockedApi.mockResolvedValue({
    access_token: "relay-ticket",
    expires_in: 120,
    client_id: "sha256:account-web-peer",
  });

  const ticket = await ensureRelayTicket();

  expect(ticket).toEqual({
    accessToken: "relay-ticket",
    clientId: "sha256:account-web-peer",
    clientName: browserDisplayName(),
  });
  expect(mockedApi).toHaveBeenCalledWith("/v1/relay/ticket", {
    method: "POST",
  });
});

it("keeps no browser-side identity and registers no device", async () => {
  mockedApi.mockResolvedValue({
    access_token: "relay-ticket",
    expires_in: 120,
    client_id: "sha256:account-web-peer",
  });
  const setItem = vi.spyOn(Storage.prototype, "setItem");

  await ensureRelayTicket();

  expect(setItem).not.toHaveBeenCalled();
  expect(localStorage.getItem("agentre.browserClientId")).toBeNull();
  expect(localStorage.getItem("agentre.deviceFingerprint")).toBeNull();
  expect(mockedApi).not.toHaveBeenCalledWith(
    "/v1/oauth/device/register",
    expect.anything(),
  );
  setItem.mockRestore();
});
