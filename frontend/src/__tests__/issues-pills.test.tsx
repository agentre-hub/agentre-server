import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBackDismiss } from "@/hooks/use-back-dismiss";

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
      { wrapper: MemoryRouter },
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
      { wrapper: MemoryRouter },
    );
    const pill = screen.getByTestId("board-model-pill");
    expect(pill.textContent).toContain("模型 · 跟随 Agent");
    expect(pill.textContent).not.toContain("跟随 Agent 绑定");
    expect(pill.querySelector("svg.lucide-cpu")).not.toBeNull();
  });
});

/**
 * 任务整屏页上的两颗 pill 在手机上开出的是浮层（规格 2026-11-25 D1）：系统返回先关
 * 选择器，任务页（它自己也压着一条记号）仍开着；再返回才关任务页。
 */
describe("任务页上的选择器：系统返回先关选择器（D1）", () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  /** 任务整屏页那一层：开着、压着自己的记号。 */
  function TaskPage({ children }: { children: ReactNode }) {
    const navigate = useNavigate();
    const { pathname, state } = useLocation();
    useBackDismiss(true, () => {});
    return (
      <>
        <span data-testid="path">{pathname}</span>
        <span data-testid="layer">
          {String(
            (state as Record<string, unknown> | null)?.agentreBackDismiss ?? 0,
          )}
        </span>
        <button onClick={() => void navigate(-1)}>system-back</button>
        {children}
      </>
    );
  }
  const renderOnPage = (pill: ReactNode) =>
    render(
      <MemoryRouter initialEntries={["/prev", "/issues"]} initialIndex={1}>
        <TaskPage>{pill}</TaskPage>
      </MemoryRouter>,
    );
  const back = () => fireEvent.click(screen.getByText("system-back"));
  const layer = () => screen.getByTestId("layer").textContent;

  it("机器选择：返回只关弹层，任务页那一层还在", async () => {
    renderOnPage(
      <BoardExecTargetPill
        className=""
        backends={[]}
        backendsLoaded
        value=""
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(layer()).toBe("1"));
    fireEvent.click(screen.getByTestId("board-exec-target-pill"));
    await screen.findByTestId("board-exec-target-row-follow");
    await waitFor(() => expect(layer()).toBe("2"));
    back();
    await waitFor(() =>
      expect(screen.queryByTestId("board-exec-target-row-follow")).toBeNull(),
    );
    expect(layer()).toBe("1");
    expect(screen.getByTestId("path").textContent).toBe("/issues");
  });

  it("模型选择：返回只关弹层，任务页那一层还在", async () => {
    renderOnPage(
      <BoardModelPill
        className=""
        backendType=""
        catalog={[]}
        target={{ providerKey: "", modelKey: "" }}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(layer()).toBe("1"));
    const pill = screen.getByTestId("board-model-pill");
    fireEvent.click(pill);
    await waitFor(() =>
      expect(pill.getAttribute("aria-expanded")).toBe("true"),
    );
    await waitFor(() => expect(layer()).toBe("2"));
    back();
    await waitFor(() =>
      expect(pill.getAttribute("aria-expanded")).toBe("false"),
    );
    expect(layer()).toBe("1");
  });
});
