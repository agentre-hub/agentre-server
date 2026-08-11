/**
 * 浏览器设备身份模块（R1 消费侧）。断言：
 *  1. 指纹持久化、按指纹幂等重新注册不新增设备行（同一 fingerprint 换同一台设备）。
 *  2. 有效期内复用缓存的 token，不重复注册；临近过期重新注册换新。
 *  3. 已被解除授权后不再自动重新注册（R2 的「刷新页面仍表达为已解除授权」）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "@/lib/api";
import {
  WebDeviceRevokedError,
  clearWebDeviceRevoked,
  clearWebDeviceToken,
  ensureWebDevice,
  getFingerprint,
  isWebDeviceRevoked,
  markWebDeviceRevoked,
  tokenExpiryMs,
} from "@/lib/webDevice";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

function makeJwt(expSeconds: number): string {
  const header = window.btoa(JSON.stringify({ alg: "HS256" }));
  const payload = window
    .btoa(JSON.stringify({ sub: "1", exp: expSeconds }))
    .replace(/=/g, "");
  return `${header}.${payload}.sig`;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  mockedApi.mockReset();
});

describe("浏览器设备身份", () => {
  it("无缓存时注册一台 kind=web 设备并持久化指纹与 token", async () => {
    mockedApi.mockResolvedValue({
      access_token: makeJwt(Math.floor(Date.now() / 1000) + 900),
      device_id: 7,
    });

    const web = await ensureWebDevice();

    expect(web.fingerprint).toBeTruthy();
    expect(web.deviceId).toBe(7);
    expect(getFingerprint()).toBe(web.fingerprint);
    // 指纹稳定：同一浏览器重复获取返回同一个值。
    expect(await ensureWebDevice()).toEqual(web);
    // 注册只发生一次（token 未过期时直接复用缓存）。
    expect(mockedApi).toHaveBeenCalledTimes(1);
    const [path, init] = mockedApi.mock.calls[0];
    expect(path).toBe("/v1/oauth/device/register");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      fingerprint: web.fingerprint,
    });
  });

  it("临近过期时重新注册换新 token", async () => {
    mockedApi.mockResolvedValueOnce({
      access_token: makeJwt(Math.floor(Date.now() / 1000) + 300),
      device_id: 7,
    });
    const first = await ensureWebDevice();

    // 第二次：token 仍在有效期 → 复用缓存，不再注册。
    mockedApi.mockResolvedValueOnce({
      access_token: makeJwt(Math.floor(Date.now() / 1000) + 900),
      device_id: 7,
    });
    const cached = await ensureWebDevice();
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(cached.accessToken).toBe(first.accessToken);

    // 把缓存的 token 改成已过期 → 重新注册换新。
    window.sessionStorage.setItem(
      "agentre.webDeviceToken",
      JSON.stringify({
        accessToken: makeJwt(Math.floor(Date.now() / 1000) - 60),
        deviceId: 7,
      }),
    );
    const refreshed = await ensureWebDevice();
    expect(mockedApi).toHaveBeenCalledTimes(2);
    expect(refreshed.accessToken).not.toBe(first.accessToken);
  });

  it("解除授权后不再自动重新注册,并抛 WebDeviceRevokedError", async () => {
    mockedApi.mockResolvedValueOnce({
      access_token: makeJwt(Math.floor(Date.now() / 1000) + 900),
      device_id: 7,
    });
    await ensureWebDevice();

    markWebDeviceRevoked();
    expect(isWebDeviceRevoked()).toBe(true);

    await expect(ensureWebDevice()).rejects.toBeInstanceOf(
      WebDeviceRevokedError,
    );
    // 注册请求一次都没再发。
    expect(mockedApi).toHaveBeenCalledTimes(1);

    // 用户重新登录（清除标记 + 清 token 缓存）后可再注册一台新设备。
    clearWebDeviceRevoked();
    clearWebDeviceToken();
    mockedApi.mockResolvedValueOnce({
      access_token: makeJwt(Math.floor(Date.now() / 1000) + 900),
      device_id: 8,
    });
    const web = await ensureWebDevice();
    expect(web.deviceId).toBe(8);
  });

  // R2 的服务端执行点：同一指纹的设备行已被解除授权时注册端点回 403。浏览器据此
  // 落 revoked 标记并按 R11 表达，而不是把它当成一次服务端故障不停重试。
  it("注册被拒(403 已解除授权) → 落 revoked 标记并抛 WebDeviceRevokedError", async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(30301, "device revoked", 403));

    await expect(ensureWebDevice()).rejects.toBeInstanceOf(
      WebDeviceRevokedError,
    );
    expect(isWebDeviceRevoked()).toBe(true);
    // 标记落下后不再发第二次注册请求。
    await expect(ensureWebDevice()).rejects.toBeInstanceOf(
      WebDeviceRevokedError,
    );
    expect(mockedApi).toHaveBeenCalledTimes(1);
  });

  it("tokenExpiryMs 解出 JWT 的 exp", () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    expect(tokenExpiryMs(makeJwt(exp))).toBe(exp * 1000);
    expect(tokenExpiryMs("not-a-jwt")).toBeNull();
  });
});
