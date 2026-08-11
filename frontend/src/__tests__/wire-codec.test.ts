/**
 * wire 编解码与 Go 侧黄金样本的逐字段同构测试(测试接缝 1)。
 *
 * 黄金样本由 agentre 仓 wire 包里的 golden_test.go 用真实 Go marshaler 生成,
 * 提交在这里的 fixtures/wire/。本测试断言:TS 编解码对同一批帧解出的结构,
 * 与 Go 序列化出来的字节**逐字段一致**;并且带未知字段的帧在 decode → encode
 * 往返后未知字段不丢。
 */
import { describe, expect, it } from "vitest";

import {
  type WireObject,
  MethodSessionPull,
  NotifyEvent,
  decodeEventFrame,
  decodeFrame,
  decodeJournaledNotification,
  decodeRunAck,
  decodeRunParams,
  decodeRunResultDoneFrame,
  decodeSessionAttachParams,
  decodeSessionAttachResult,
  decodeSessionListResult,
  decodeSessionPendingWaitersParams,
  decodeSessionPendingWaitersResult,
  decodeSessionPullParams,
  decodeSessionPullResult,
  decodeSessionSummary,
  decodeAutonomousTurnStartedFrame,
  decodeUsageWire,
  encodeEventFrame,
  encodeFrame,
  encodeRunAck,
  encodeRunParams,
  encodeSessionAttachParams,
  encodeSessionPendingWaitersParams,
  encodeSessionPullParams,
  encodeSessionPullResult,
  encodeRunResultDoneFrame,
} from "@/lib/wire";

import runParamsFixture from "./fixtures/wire/run-params.json";
import runAckFixture from "./fixtures/wire/run-ack.json";
import sessionSummaryFixture from "./fixtures/wire/session-summary.json";
import sessionSummaryLegacyFixture from "./fixtures/wire/session-summary-legacy.json";
import sessionListResultFixture from "./fixtures/wire/session-list-result.json";
import sessionListResultLegacyFixture from "./fixtures/wire/session-list-result-legacy.json";
import sessionPullParamsFixture from "./fixtures/wire/session-pull-params.json";
import sessionPullResultFixture from "./fixtures/wire/session-pull-result.json";
import journaledNotificationFixture from "./fixtures/wire/journaled-notification.json";
import sessionAttachParamsFixture from "./fixtures/wire/session-attach-params.json";
import sessionAttachResultFixture from "./fixtures/wire/session-attach-result.json";
import sessionPendingWaitersParamsFixture from "./fixtures/wire/session-pending-waiters-params.json";
import sessionPendingWaitersResultFixture from "./fixtures/wire/session-pending-waiters-result.json";
import eventFrameFixture from "./fixtures/wire/event-frame.json";
import runResultDoneFrameFixture from "./fixtures/wire/run-result-done-frame.json";
import usageWireFixture from "./fixtures/wire/usage-wire.json";
import autonomousTurnStartedFixture from "./fixtures/wire/autonomous-turn-started.json";
import runParamsExtraFixture from "./fixtures/wire/run-params-extra.json";
import sessionPullResultExtraFixture from "./fixtures/wire/session-pull-result-extra.json";
import frameEnvelopeRequestFixture from "./fixtures/wire/frame-envelope-request.json";
import frameEnvelopeResponseFixture from "./fixtures/wire/frame-envelope-response.json";
import frameEnvelopeNotificationFixture from "./fixtures/wire/frame-envelope-notification.json";
import frameEnvelopeErrorFixture from "./fixtures/wire/frame-envelope-error.json";

/** decode → encode → parse 必须逐字段等于 Go 侧产出的原始帧;返回解码结果供定向断言。 */
function assertRoundTrip<T extends WireObject>(
  decode: (v: unknown) => T,
  encode: (v: T) => string,
  fixture: unknown,
  what: string,
): T {
  const decoded = decode(fixture);
  expect(
    JSON.parse(encode(decoded)),
    `${what} 往返后应与 Go 真实帧逐字段相同`,
  ).toEqual(fixture);
  return decoded;
}

describe("wire 编解码:与 Go 侧黄金样本逐字段同构", () => {
  it("RunParams 解出新字段(peerFingerprint/title/agentSyncId/providerSessionId/source*)", () => {
    const p = assertRoundTrip(
      decodeRunParams,
      encodeRunParams,
      runParamsFixture,
      "RunParams",
    );
    expect(p.sessionId).toBe(42);
    expect(p.agentId).toBe(7);
    // R9:别的对端发起的那条会话上开新一轮时点名的 origin。
    expect(p.peerFingerprint).toBe("fp-desktop");
    expect(p.cwd).toBe("/home/agent/proj");
    expect(p.title).toBe("重构登录页");
    expect(p.agentSyncId).toBe("01JZ7W2A8KZ4R5T6Y7U8I9O0P1Q");
    expect(p.providerSessionId).toBe("sess_abc123");
    expect(p.sourceDevice).toBe("fp-web-1");
    expect(p.sourceDeviceName).toBe("Chrome · macOS");
    // 嵌套结构原样透传(mcpServers 在 Go 侧无 JSON tag,PascalCase 不动)。
    expect(p.mcpServers).toHaveLength(1);
    expect((p.mcpServers as Array<Record<string, unknown>>)[0].Name).toBe(
      "org",
    );
    expect(p.enabledPlugins).toEqual({
      "auto-continue": true,
      dangerous: false,
    });
  });

  it("RunParams 带未知字段:解码后仍在,往返不丢", () => {
    const p = assertRoundTrip(
      decodeRunParams,
      encodeRunParams,
      runParamsExtraFixture,
      "RunParams(extra)",
    );
    expect(p.futureField).toEqual({ nested: true });
    expect(p.clientNote).toBe("来自浏览器的自定义字段");
  });

  it("RunAck 解出 providerSessionId 与回退信号", () => {
    const a = assertRoundTrip(
      decodeRunAck,
      encodeRunAck,
      runAckFixture,
      "RunAck",
    );
    expect(a.sessionId).toBe(42);
    expect(a.providerSessionId).toBe("sess_abc123");
    expect(a.launchPermissionMode).toBe("default");
    expect(a.providerFallbackKey).toBe("key-fallback");
  });

  it("SessionSummary 解出 R7 新列;老会话如实留空(键缺失)", () => {
    const s = assertRoundTrip(
      decodeSessionSummary,
      (v) => JSON.stringify(v),
      sessionSummaryFixture,
      "SessionSummary",
    );
    expect(s.title).toBe("重构登录页");
    expect(s.agentSyncId).toBe("01JZ7W2A8KZ4R5T6Y7U8I9O0P1Q");
    expect(s.providerSessionId).toBe("sess_abc123");
    expect(s.lifecycleState).toBe("running");
    expect(s.waitingForInput).toBe(true);
    expect(s.latestSeq).toBe(12);
    // R5 的「最后活动时间」：唯一真相源在执行端那台机器上，随清单过线。
    expect(s.updatedAt).toBe(1754800000000);
    // 逐字段同构：它是被 codec 认识并校验的字段，不是漏进来的未知键。
    expect(() =>
      decodeSessionSummary({ ...sessionSummaryFixture, updatedAt: "昨天" }),
    ).toThrow(TypeError);

    const legacy = assertRoundTrip(
      decodeSessionSummary,
      (v) => JSON.stringify(v),
      sessionSummaryLegacyFixture,
      "SessionSummary(legacy)",
    );
    expect(legacy.title).toBeUndefined();
    expect(legacy.agentSyncId).toBeUndefined();
    expect(legacy.providerSessionId).toBeUndefined();
    expect(legacy.lifecycleState).toBe("idle");
    expect(legacy.peerFingerprint).toBe("fp-desktop");
    expect(legacy.updatedAt).toBeUndefined();
  });

  it("SessionListResult 逐条解出会话", () => {
    const r = assertRoundTrip(
      decodeSessionListResult,
      (v) => JSON.stringify(v),
      sessionListResultFixture,
      "SessionListResult",
    );
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[0].title).toBe("重构登录页");
    expect(r.sessions[1].title).toBeUndefined();
    // 升级过的 agentred 如实声明自己支持 R7 / 决策 8 的那几列。
    expect(r.supportsSessionMetadata).toBe(true);
  });

  it("未升级的 agentred 的清单里没有 supportsSessionMetadata（兼容性信号）", () => {
    // 老 agentred 不认识这个键，应答里根本没有它 —— 客户端据此把「这台机器没升级」
    // 与「这台机器上的老会话」区分开，并如实说明需要升级而不是静默失败。
    const r = assertRoundTrip(
      decodeSessionListResult,
      (v) => JSON.stringify(v),
      sessionListResultLegacyFixture,
      "SessionListResult(legacy)",
    );
    expect(r.supportsSessionMetadata).toBeUndefined();
    expect(() =>
      decodeSessionListResult({
        ...sessionListResultLegacyFixture,
        supportsSessionMetadata: "yes",
      }),
    ).toThrow(TypeError);
  });

  it("SessionPullParams 独占游标(首次 0)+ 限制", () => {
    const p = assertRoundTrip(
      decodeSessionPullParams,
      encodeSessionPullParams,
      sessionPullParamsFixture,
      "SessionPullParams",
    );
    expect(p.cursor).toBe(0);
    expect(p.limit).toBe(200);
  });

  it("JournaledNotification 的 params 不含 seq(补齐端自己盖)", () => {
    const n = assertRoundTrip(
      decodeJournaledNotification,
      (v) => JSON.stringify(v),
      journaledNotificationFixture,
      "JournaledNotification",
    );
    expect(n.seq).toBe(11);
    expect(n.method).toBe(NotifyEvent);
    const frame = decodeEventFrame(n.params);
    expect(frame.seq).toBeUndefined();
    expect(frame.sessionId).toBe(42);
  });

  it("SessionPullResult 解出通知 / 游标 / HasMore / OldestSeq", () => {
    const r = assertRoundTrip(
      decodeSessionPullResult,
      encodeSessionPullResult,
      sessionPullResultFixture,
      "SessionPullResult",
    );
    expect(r.notifications).toHaveLength(2);
    expect(r.notifications?.[0].seq).toBe(11);
    expect(r.notifications?.[1].method).toBe("runtime.runResultDone");
    expect(r.cursor).toBe(12);
    expect(r.hasMore).toBe(false);
    expect(r.oldestSeq).toBe(1);
  });

  it("SessionPullResult 带未知字段:serverVersion 不丢", () => {
    const r = assertRoundTrip(
      decodeSessionPullResult,
      encodeSessionPullResult,
      sessionPullResultExtraFixture,
      "SessionPullResult(extra)",
    );
    expect(r.serverVersion).toBe("1.2.3");
  });

  it("attach 参数 / 结果", () => {
    const p = assertRoundTrip(
      decodeSessionAttachParams,
      encodeSessionAttachParams,
      sessionAttachParamsFixture,
      "SessionAttachParams",
    );
    expect(p.sessionId).toBe(42);
    const r = assertRoundTrip(
      decodeSessionAttachResult,
      (v) => JSON.stringify(v),
      sessionAttachResultFixture,
      "SessionAttachResult",
    );
    expect(r.lifecycleState).toBe("running");
    expect(r.latestSeq).toBe(12);
    expect(r.backendType).toBe("claudecode");
  });

  it("pendingWaiters 参数 / 结果原样透传", () => {
    const p = assertRoundTrip(
      decodeSessionPendingWaitersParams,
      encodeSessionPendingWaitersParams,
      sessionPendingWaitersParamsFixture,
      "SessionPendingWaitersParams",
    );
    expect(p.sessionId).toBe(42);
    const r = assertRoundTrip(
      decodeSessionPendingWaitersResult,
      (v) => JSON.stringify(v),
      sessionPendingWaitersResultFixture,
      "SessionPendingWaitersResult",
    );
    expect(r.toolPermissions).toHaveLength(1);
    expect(
      (r.toolPermissions as Array<Record<string, unknown>>)[0].RequestID,
    ).toBe("perm-1");
    expect(r.askUserQuestions).toHaveLength(1);
  });

  it("EventFrame 解出 sessionId / seq / 真实 event 载荷", () => {
    const f = assertRoundTrip(
      decodeEventFrame,
      encodeEventFrame,
      eventFrameFixture,
      "EventFrame",
    );
    expect(f.sessionId).toBe(42);
    expect(f.seq).toBe(11);
    expect(f.event).toEqual({ kind: "text_delta", text: "你好" });
  });

  it("RunResultDoneFrame 解出 usage / 终态", () => {
    const f = assertRoundTrip(
      decodeRunResultDoneFrame,
      encodeRunResultDoneFrame,
      runResultDoneFrameFixture,
      "RunResultDoneFrame",
    );
    expect(f.sessionId).toBe(42);
    expect(f.usage?.totalTokens).toBe(155);
    expect(f.model).toBe("claude-sonnet-4-5");
    expect(f.turnToken).toBe(9);
  });

  it("UsageWire 解出全部计数", () => {
    const u = assertRoundTrip(
      decodeUsageWire,
      (v) => JSON.stringify(v),
      usageWireFixture,
      "UsageWire",
    );
    expect(u.promptTokens).toBe(100);
    expect(u.totalTokens).toBe(155);
  });

  it("AutonomousTurnStartedFrame 解出 trigger / turnToken / seq", () => {
    const f = decodeAutonomousTurnStartedFrame(autonomousTurnStartedFixture);
    expect(f.sessionId).toBe(42);
    expect(f.trigger).toBe("auto");
    expect(f.turnToken).toBe(9);
    expect(f.seq).toBe(13);
    // 往返同构。
    expect(JSON.parse(JSON.stringify(f))).toEqual(autonomousTurnStartedFixture);
  });

  it("JSON-RPC 信封:请求 / 响应 / 通知 / 错误", () => {
    const req = assertRoundTrip(
      decodeFrame,
      encodeFrame,
      frameEnvelopeRequestFixture,
      "Frame(request)",
    );
    expect(req.jsonrpc).toBe("2.0");
    expect(req.id).toBe(1);
    expect(req.method).toBe(MethodSessionPull);
    expect(decodeSessionPullParams(req.params).cursor).toBe(0);

    const res = assertRoundTrip(
      decodeFrame,
      encodeFrame,
      frameEnvelopeResponseFixture,
      "Frame(response)",
    );
    expect(res.id).toBe(1);
    expect(decodeSessionListResult(res.result).sessions).toHaveLength(1);

    const notif = assertRoundTrip(
      decodeFrame,
      encodeFrame,
      frameEnvelopeNotificationFixture,
      "Frame(notification)",
    );
    expect(notif.method).toBe(NotifyEvent);
    expect(notif.id).toBeUndefined();
    expect(decodeEventFrame(notif.params).seq).toBe(11);

    const err = assertRoundTrip(
      decodeFrame,
      encodeFrame,
      frameEnvelopeErrorFixture,
      "Frame(error)",
    );
    expect(err.error?.code).toBe(-32014);
    expect(err.error?.message).toBe("session not found");
  });
});
