import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { BoardExecTargetPill } from "@/pages/issues/ExecTargetPill";
import { BoardModelPill } from "@/pages/issues/ModelPill";

/**
 * 审计第 13 项：看板任务页的机器、模型两颗 pill 跟随态原来都写「跟随 Agent 绑定」，
 * 一模一样，只能靠 aria-label 区分。改成各带字段名与图标：
 * 机器 =「Server 图标 · 机器（灰）· 跟随 Agent」，模型 =「Cpu 图标 · 模型 · 跟随 Agent」。
 */
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("看板任务的两颗 pill：跟随态分得清", () => {
  it("机器 pill：Server 图标 + 灰色字段名「机器」+「跟随 Agent」", () => {
    render(
      <BoardExecTargetPill
        className=""
        backends={[]}
        backendsLoaded
        value=""
        onChange={vi.fn()}
      />,
    );
    const pill = screen.getByTestId("board-exec-target-pill");
    expect(pill.textContent).toBe("机器跟随 Agent");
    expect(pill.querySelector("svg.lucide-server")).not.toBeNull();
    const field = [...pill.querySelectorAll("span")].find(
      (s) => s.textContent === "机器",
    );
    expect(field?.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("模型 pill：Cpu 图标 +「模型 · 跟随 Agent」", () => {
    render(
      <BoardModelPill
        className=""
        backendType=""
        catalog={[]}
        target={{ providerKey: "", modelKey: "" }}
        onChange={vi.fn()}
      />,
    );
    const pill = screen.getByTestId("board-model-pill");
    expect(pill.textContent).toContain("模型 · 跟随 Agent");
    expect(pill.textContent).not.toContain("跟随 Agent 绑定");
    expect(pill.querySelector("svg.lucide-cpu")).not.toBeNull();
  });
});
