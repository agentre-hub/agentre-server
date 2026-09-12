/**
 * 「这个浏览器能不能用通行密钥，不能的话是哪一种不能」。
 *
 * 分两种是因为它们的**补救办法相反**：浏览器太老要换浏览器；源不是安全上下文
 * （本站有时用 http 提供）要换成 https，换几个浏览器都一样。此前两处调用点各写
 * 一句 `"PublicKeyCredential" in window`，只答得出「不能」，于是账号页对着一个
 * 完全支持通行密钥的浏览器说「这个浏览器不支持」。
 *
 * `PublicKeyCredential` 与 `navigator.credentials` 在规范里都带 [SecureContext]，
 * 在 http 源上整个不存在 —— 实测同一个 Chromium：
 *   http://<lan-ip>:7391/  → isSecureContext=false, PublicKeyCredential=false
 *   http://127.0.0.1:7391/ → isSecureContext=true,  PublicKeyCredential=true
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { passkeySupport } from "@/lib/passkeySupport";

/** 造出「这个源信不过」的样子：API 不在，且 isSecureContext 明说 false。 */
function insecureOrigin() {
  Reflect.deleteProperty(window, "PublicKeyCredential");
  vi.spyOn(window, "isSecureContext", "get").mockReturnValue(false);
}

/** 造出「源没问题，是浏览器太老」的样子。 */
function oldBrowser() {
  Reflect.deleteProperty(window, "PublicKeyCredential");
  vi.spyOn(window, "isSecureContext", "get").mockReturnValue(true);
}

function withPublicKeyCredential() {
  Object.defineProperty(window, "PublicKeyCredential", {
    value: function PublicKeyCredential() {},
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "PublicKeyCredential");
});

describe("passkeySupport", () => {
  it("API 在就是能用", () => {
    withPublicKeyCredential();
    expect(passkeySupport()).toBe("available");
  });

  // API 在场就说明这个源已经够格了 —— 这一条比 isSecureContext 说什么更硬。
  it("API 在场时不因为 isSecureContext 说 false 就改口", () => {
    withPublicKeyCredential();
    vi.spyOn(window, "isSecureContext", "get").mockReturnValue(false);
    expect(passkeySupport()).toBe("available");
  });

  // 键在、值是 undefined 的情形：登录页此前用的就是真值判断（`!!window.
  // PublicKeyCredential`），账号页用的是 `"PublicKeyCredential" in window`。两处
  // 口径不一，统一到严的那一边——一个 undefined 的构造器谁也调不动。
  it("键在但值是 undefined 时不算能用", () => {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    vi.spyOn(window, "isSecureContext", "get").mockReturnValue(true);
    expect(passkeySupport()).toBe("unsupported");
  });

  it("源不是安全上下文时说的是源，不是浏览器", () => {
    insecureOrigin();
    expect(passkeySupport()).toBe("insecure-origin");
  });

  it("源没问题而 API 不在，才是浏览器不支持", () => {
    oldBrowser();
    expect(passkeySupport()).toBe("unsupported");
  });

  // isSecureContext 是 jsdom 没实现、老浏览器也可能没有的属性。拿不准时保持旧口径
  // （「浏览器不支持」），不去凭空指控部署方式。
  it("连 isSecureContext 都问不到时退回「浏览器不支持」", () => {
    Reflect.deleteProperty(window, "PublicKeyCredential");
    vi.spyOn(window, "isSecureContext", "get").mockReturnValue(
      undefined as unknown as boolean,
    );
    expect(passkeySupport()).toBe("unsupported");
  });
});
