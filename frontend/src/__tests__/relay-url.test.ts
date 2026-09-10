/**
 * 中继 URL 与票据的携带方式。
 *
 * 票**不在** URL 上：它走 Sec-WebSocket-Protocol（`agentre.bearer.<token>` 伪子协议），
 * 因此不会落进 ingress access log、反代日志、浏览器 history 与 Referer。
 *
 * 目标也不在 URL 上：它从连接级降到了通道级（决策 10），`daemon_fingerprint` 随之
 * 取消——一个账号一条连接，每条虚拟通道开通时自己声明目标。
 */
import { describe, expect, it, vi } from "vitest";

import { bearerSubprotocol, relayClientUrl } from "@/lib/relayUrl";

describe("relayClientUrl", () => {
  it("账号级连接的 url 上什么都不带：没有目标，也没有票", () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "console.example.com",
    });
    expect(relayClientUrl()).toBe("wss://console.example.com/v1/relay/client");
  });

  it("http 源用 ws 协议", () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "localhost:8443",
    });
    expect(relayClientUrl().startsWith("ws://localhost:8443")).toBe(true);
  });
});

describe("bearerSubprotocol", () => {
  it("把票包成伪子协议，前缀与服务端 bearerSubprotocolPrefix 同源", () => {
    expect(bearerSubprotocol("tok-123")).toBe("agentre.bearer.tok-123");
  });
});
