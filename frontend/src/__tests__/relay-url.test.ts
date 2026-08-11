/**
 * 中继 URL 构造：设备 JWT 放进 query 的 access_token（浏览器 WebSocket 无法设头，
 * 服务端 queryTokenBridge 兜住），daemon_fingerprint 指向目标 agentred。
 */
import { describe, expect, it, vi } from "vitest";

import { relayClientUrl } from "@/lib/relayUrl";

describe("relayClientUrl", () => {
  it("把 daemon_fingerprint 与 access_token 拼进 wss url", () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "console.example.com",
    });
    const url = relayClientUrl("fp-mac", "jwt-abc");
    expect(url).toContain("wss://console.example.com/v1/relay/client");
    expect(url).toContain("daemon_fingerprint=fp-mac");
    expect(url).toContain("access_token=jwt-abc");
  });

  it("http 源用 ws 协议", () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "localhost:8443",
    });
    expect(relayClientUrl("fp", "tok").startsWith("ws://localhost:8443")).toBe(
      true,
    );
  });
});
