import { describe, expect, it } from "vitest";

import {
  mirrorRowToSummary,
  type MirrorSessionItem,
} from "@/components/session/sessionMirror";

const base: MirrorSessionItem = {
  conversation_id: "42",
  peer_fingerprint: "fp-origin",
  device_fingerprint: "fp-host",
  title: "t",
};

describe("mirrorRowToSummary CLI 模型选择", () => {
  it("把镜像行的 cli_model_mode / cli_model 映射到摘要的 cliModelMode / cliModel", () => {
    const s = mirrorRowToSummary({
      ...base,
      cli_model_mode: "fixed",
      cli_model: "claude-opus-4-7",
    });
    expect(s.cliModelMode).toBe("fixed");
    expect(s.cliModel).toBe("claude-opus-4-7");
  });

  it("服务端 omitempty 省掉时保持未设（跟随 Agent 绑定）", () => {
    const s = mirrorRowToSummary(base);
    expect(s.cliModelMode ?? "").toBe("");
    expect(s.cliModel ?? "").toBe("");
  });
});
