/**
 * 「这条会话此刻算作用哪个模型、它的上下文窗口多大」。
 *
 * 事件流上这两样都可能一直缺席：模型只挂在终态帧上（轮次跑着的时候没有），而
 * dev 环境的持久帧里 `context_window_updated` / `usage.contextWindow` 一条都没有
 * （agentred 探到了窗口，却 emit 成 wire 上并不存在的 `session_status` kind）。
 * 桌面端不受影响是因为它有四级兜底，根本不看事件流；这两个纯函数是控制台这一侧
 * 的同形兜底。
 */
import type { TranscriptMessage } from "@agentre-hub/agentre-ui";
import { describe, expect, it } from "vitest";

import {
  lastUsedModelId,
  resolveContextWindow,
} from "@/components/session/sessionModel";

function message(role: string, model: string): TranscriptMessage {
  return {
    id: 1,
    sessionId: 1,
    role,
    blocks: [],
    model,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalInputTokens: 0,
    durationMs: 0,
    errorText: "",
    seq: 0,
    createtime: 0,
  };
}

const catalog = [
  {
    providerKey: "zhipu",
    id: 1,
    name: "智谱",
    type: "anthropic",
    enabled: true,
    defaultModel: null,
    models: [
      {
        modelKey: "glm",
        modelId: "glm-5.2",
        enabled: true,
        contextWindow: 200_000,
      },
      {
        modelKey: "sonnet",
        modelId: "claude-sonnet-4",
        enabled: true,
        contextWindow: 1_000_000,
      },
      // 目录里没报窗口的那一档：查得到模型不等于查得到窗口。
      { modelKey: "mystery", modelId: "mystery-1", enabled: true },
    ],
  },
];

describe("lastUsedModelId", () => {
  it("从后往前取第一条报得出模型的助手消息", () => {
    expect(
      lastUsedModelId([
        message("assistant", "claude-sonnet-4"),
        message("user", ""),
        message("assistant", "glm-5.2"),
      ]),
    ).toBe("glm-5.2");
  });

  // 正在跑的那一轮就是这个形状：助手消息已经开了，模型要等终态帧才填进来。
  it("末条助手消息还没有模型时，继续往前找", () => {
    expect(
      lastUsedModelId([
        message("assistant", "glm-5.2"),
        message("user", ""),
        message("assistant", ""),
      ]),
    ).toBe("glm-5.2");
  });

  it("一条都没报过就是空串，不编一个出来", () => {
    expect(lastUsedModelId([message("user", "")])).toBe("");
    expect(lastUsedModelId([])).toBe("");
  });
});

describe("resolveContextWindow", () => {
  it("runtime 报过窗口就用它，目录不参与", () => {
    expect(
      resolveContextWindow({
        runtimeWindow: 123_000,
        catalog,
        lastUsedModelId: "glm-5.2",
        pinnedModelId: "claude-sonnet-4",
      }),
    ).toBe(123_000);
  });

  it("事件流给不出窗口时，按这条会话上一次真的用过的模型查目录", () => {
    expect(
      resolveContextWindow({
        runtimeWindow: 0,
        catalog,
        lastUsedModelId: "glm-5.2",
        pinnedModelId: "claude-sonnet-4",
      }),
    ).toBe(200_000);
  });

  it("一轮都没跑过时，退到这条会话钉着的模型", () => {
    expect(
      resolveContextWindow({
        runtimeWindow: 0,
        catalog,
        lastUsedModelId: "",
        pinnedModelId: "claude-sonnet-4",
      }),
    ).toBe(1_000_000);
  });

  // 用过的那个模型目录里查不到窗口 → 继续退到钉着的那个，而不是就此认输。
  it("用过的模型查不出窗口时接着退到钉着的模型", () => {
    expect(
      resolveContextWindow({
        runtimeWindow: 0,
        catalog,
        lastUsedModelId: "mystery-1",
        pinnedModelId: "claude-sonnet-4",
      }),
    ).toBe(1_000_000);
  });

  it("哪一级都答不出就是 0（整块不摆，不编一个分母）", () => {
    expect(
      resolveContextWindow({
        runtimeWindow: 0,
        catalog,
        lastUsedModelId: "unknown-9",
        pinnedModelId: "",
      }),
    ).toBe(0);
    expect(
      resolveContextWindow({
        runtimeWindow: 0,
        catalog: [],
        lastUsedModelId: "glm-5.2",
        pinnedModelId: "claude-sonnet-4",
      }),
    ).toBe(0);
  });
});
