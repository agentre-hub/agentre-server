/**
 * 中继 URL 与票据的携带方式。
 *
 * 票**不在** URL 上：它走 Sec-WebSocket-Protocol（`agentre.bearer.<token>` 伪子协议），
 * 因此不会落进 ingress access log、反代日志、浏览器 history 与 Referer。URL 上只剩
 * daemon_fingerprint —— 目标指纹不是凭据。
 */
import { describe, expect, it, vi } from "vitest";

import { bearerSubprotocol, relayClientUrl } from "@/lib/relayUrl";

describe("relayClientUrl", () => {
  it("只把 daemon_fingerprint 拼进 wss url，票不在里面", () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "console.example.com",
    });
    const url = relayClientUrl("fp-mac");
    expect(url).toContain("wss://console.example.com/v1/relay/client");
    expect(url).toContain("daemon_fingerprint=fp-mac");
    expect(url).not.toContain("access_token");
  });

  it("http 源用 ws 协议", () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "localhost:8443",
    });
    expect(relayClientUrl("fp").startsWith("ws://localhost:8443")).toBe(true);
  });
});

describe("bearerSubprotocol", () => {
  it("把票包成伪子协议，前缀与服务端 bearerSubprotocolPrefix 同源", () => {
    expect(bearerSubprotocol("tok-123")).toBe("agentre.bearer.tok-123");
  });
});
