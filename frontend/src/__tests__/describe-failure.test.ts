/**
 * 失败分类（规格 2026-11-05-ux-polish W5）。
 *
 * 一次失败给用户的是三样东西：一句说得出事实的话、一个对的出口、以及一份只进剪贴板
 * 的原文。这里钉的是「认的是结构化信号」——ApiError 的码 / 状态、RelayError 的 wire 码、
 * 派发那两个错误类——只在没有结构化信号的地方（浏览器的 fetch TypeError）才看 message。
 */
import {
  ErrCodeMethodNotFound,
  ErrCodeProtocolVersion,
  ErrCodeUnauthorized,
  ErrCodeUnsupported,
} from "@agentre-hub/agentre-wire";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { ApiError } from "@/lib/api";
import { describeFailure } from "@/lib/describeFailure";
import { DispatchConnectionError, DispatchRunError } from "@/lib/dispatch";
import { loadErrorText } from "@/lib/loadError";
import { EXPECTED_REJECTION } from "@/lib/protocolMismatch";
import { RelayError } from "@/lib/relayClient";

const zh = i18n.getFixedT("zh-CN");
const en = i18n.getFixedT("en");

const zhCtx = { t: zh, what: "看板没取回来", machine: "build-box-01" };
const enCtx = {
  t: en,
  what: "Couldn't load the board",
  machine: "build-box-01",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 可见的那一句里不许出现原文的任何一段。 */
function expectNoRaw(message: string, raw: string) {
  expect(message).not.toContain(raw);
}

describe("describeFailure · 离线 / 断网", () => {
  it("浏览器自己的 fetch 失败：网络好像断了，给重试", () => {
    const f = describeFailure(new TypeError("Failed to fetch"), zhCtx);
    expect(f.category).toBe("offline");
    expect(f.exit).toBe("retry");
    expect(f.message).toBe("看板没取回来，网络好像断了。");
    expect(f.diagnostic).toContain("Failed to fetch");
  });

  it("浏览器报离线时，哪怕错误本身说不清，也是断网", () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    const f = describeFailure(new Error("whatever"), zhCtx);
    expect(f.category).toBe("offline");
    expect(f.exit).toBe("retry");
  });

  it("代码缺陷的 TypeError 不是断网", () => {
    const f = describeFailure(
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      zhCtx,
    );
    expect(f.category).toBe("unknown");
  });

  it("中继自己造的 -1（连接未就绪 / 断线 / 超时）：连不到那台机器", () => {
    const f = describeFailure(new RelayError(-1, "relay: 连接未就绪"), zhCtx);
    expect(f.category).toBe("offline");
    expect(f.exit).toBe("retry");
    expect(f.message).toContain("build-box-01");
    expectNoRaw(f.message, "relay: 连接未就绪");
  });

  it("派发连不上（DispatchConnectionError）同属离线，不论原因说了什么", () => {
    const f = describeFailure(
      new DispatchConnectionError(new Error("dial tcp: i/o timeout")),
      zhCtx,
    );
    expect(f.category).toBe("offline");
    expect(f.exit).toBe("retry");
    expect(f.diagnostic).toContain("dial tcp: i/o timeout");
  });

  it("服务端说那台设备离线（业务码 RelayDaemonOffline）", () => {
    const f = describeFailure(new ApiError(30401, "设备离线", 409), zhCtx);
    expect(f.category).toBe("offline");
    expect(f.exit).toBe("retry");
    expectNoRaw(f.message, "设备离线");
  });
});

describe("describeFailure · 版本过旧", () => {
  it("那台机器的 agentred 旧：出口是去设备页", () => {
    const detail =
      'peer speaks wire protocol version "4.5.6", this build speaks "1.2.3"; both ends must run the same release';
    const f = describeFailure(
      new RelayError(ErrCodeProtocolVersion, detail),
      zhCtx,
    );
    expect(f.category).toBe("versionTooOld");
    expect(f.exit).toBe("devices");
    expect(f.message).toContain("build-box-01");
    expectNoRaw(f.message, "peer speaks");
    expect(f.diagnostic).toContain(detail);
  });

  it("这个页面旧：去设备页没用，出口是无（句子里说刷新页面）", () => {
    const f = describeFailure(
      new RelayError(ErrCodeProtocolVersion, EXPECTED_REJECTION.detail),
      zhCtx,
    );
    expect(f.category).toBe("versionTooOld");
    expect(f.exit).toBe("none");
    expect(f.message).toContain("刷新");
  });

  it("那台机器不认这个方法（MethodNotFound）= 它的 agentred 太旧", () => {
    const f = describeFailure(
      new DispatchRunError(
        new RelayError(ErrCodeMethodNotFound, "method not found"),
      ),
      zhCtx,
    );
    expect(f.category).toBe("versionTooOld");
    expect(f.exit).toBe("devices");
  });
});

describe("describeFailure · 权限", () => {
  it.each([
    ["HTTP 403 / Forbidden", new ApiError(30005, "无权限", 403)],
    ["HTTP 401 / Unauthorized", new ApiError(30004, "未登录", 401)],
    ["那台机器不认凭据", new RelayError(ErrCodeUnauthorized, "unauthorized")],
  ])("%s → 权限，没有出口", (_name, err) => {
    const f = describeFailure(err, zhCtx);
    expect(f.category).toBe("permission");
    expect(f.exit).toBe("none");
    expectNoRaw(f.message, (err as Error).message);
  });
});

describe("describeFailure · 对端拒绝", () => {
  it("那台机器明确拒绝（wire 码，非内部错误）：说是它拒绝的，不给重试", () => {
    const f = describeFailure(
      new DispatchRunError(new RelayError(ErrCodeUnsupported, "unsupported")),
      zhCtx,
    );
    expect(f.category).toBe("peerRefused");
    expect(f.exit).toBe("none");
    expect(f.message).toContain("build-box-01");
    expectNoRaw(f.message, "unsupported");
  });
});

describe("describeFailure · 未知", () => {
  it("对端内部错误：事实句 + 重试，原文与码只进诊断", () => {
    const raw = 'exec: "claude": executable file not found in $PATH';
    const f = describeFailure(
      new DispatchRunError(new RelayError(-32603, raw)),
      zhCtx,
    );
    expect(f.category).toBe("unknown");
    expect(f.exit).toBe("retry");
    expect(f.message).toBe("看板没取回来。");
    expect(f.diagnostic).toContain(raw);
    expect(f.diagnostic).toContain("-32603");
    expect(f.diagnostic).toContain("DispatchRunError");
  });

  it("认不出的业务码：不贴服务端那句中文 msg", () => {
    const f = describeFailure(new ApiError(30000, "操作失败", 400), enCtx);
    expect(f.category).toBe("unknown");
    expect(f.exit).toBe("retry");
    expect(f.message).toBe("Couldn't load the board.");
    expect(f.diagnostic).toContain("操作失败");
    expect(f.diagnostic).toContain("30000");
    expect(f.diagnostic).toContain("400");
  });

  it.each([
    ["字符串", "boom", "boom"],
    ["普通对象", { reason: "weird" }, "weird"],
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
  ])("非 Error 的抛出物（%s）归未知，诊断仍有内容", (_name, thrown, inDiag) => {
    const f = describeFailure(thrown, zhCtx);
    expect(f.category).toBe("unknown");
    expect(f.exit).toBe("retry");
    expect(f.message).toBe("看板没取回来。");
    expect(f.diagnostic).toContain(inDiag);
  });

  it("循环的 cause 链不会让诊断死循环", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    const f = describeFailure(b, zhCtx);
    expect(f.category).toBe("unknown");
    expect(f.diagnostic).toContain("b");
  });
});

describe("describeFailure · 两种语言", () => {
  it("英文界面整句英文，不夹中文", () => {
    const f = describeFailure(new TypeError("Failed to fetch"), enCtx);
    expect(f.message).toBe(
      "Couldn't load the board — the network seems to be down.",
    );
    expect(f.message).not.toMatch(/[一-鿿]/);
  });

  it("不给机器名时句子说「那台机器」，不留空洞", () => {
    const f = describeFailure(new RelayError(-1, "x"), {
      t: zh,
      what: "看板没取回来",
    });
    expect(f.message).toContain("那台机器");
    expect(f.message).not.toContain("{{");
  });
});

/**
 * 规格 W5：「接入：…、`Device`、各 loadError 调用方」——读失败那几处同样经分类说
 * 事实句，不再是一句不分青红皂白的兜底话。
 */
describe("loadErrorText · 经 describeFailure 分类", () => {
  it("断网说断网，句首是调用方那半句", () => {
    expect(
      loadErrorText(
        new TypeError("Failed to fetch"),
        en,
        "device.manage.loadFailedWhat",
      ),
    ).toBe("Could not load your devices — the network seems to be down.");
  });

  it("认不出的失败只说那半句，不带原文与中文 msg", () => {
    const text = loadErrorText(
      new ApiError(30001, "参数不对", 500),
      en,
      "device.manage.loadFailedWhat",
    );
    expect(text).toBe("Could not load your devices.");
  });
});
