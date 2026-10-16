/**
 * 无边框改版：新建对话的各个面板与选择列表不画结构线，选中 / 可点的行落在填充上。
 * 几何（68px 头带等）由 new-conversation.test.tsx 继续断言。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";
import { fetchDispatchPlan, type DispatchPlan } from "@/lib/dispatch";
import {
  AgentPickList,
  AgentPickSkeleton,
} from "@/components/session/newconv/AgentPickList";
import { DraftSession } from "@/components/session/newconv/DraftSession";
import { NewConversationPane } from "@/components/session/newconv/NewConversationPane";
import { NewConversationSheet } from "@/components/session/newconv/NewConversationSheet";
import { ProjectAgentPane } from "@/components/session/newconv/ProjectAgentPane";
import type {
  NewConvAgent,
  NewConvProject,
} from "@/components/session/newconv/types";
import { edgeClasses } from "./helpers/edge-classes";

/**
 * 元素自身及后代里自涂的旧表面（bg-background / bg-card）。这些面板都是对话页
 * 详情那一格，脚下就是壳给的内容页（bg-sheet）：再涂一层 background / card，浅色
 * 下是 #fafafa 上叠 #ffffff 的一道色带，深色下整格换成另一种灰，与选中会话时的
 * 详情（不自涂）不是同一张纸。
 */
function selfPaintedSurfaces(root: Element): string[] {
  return [root, ...Array.from(root.querySelectorAll("*"))].flatMap((el) =>
    Array.from(el.classList).filter((c) =>
      /^(?:[\w-]+:)*bg-(?:background|card)$/.test(c),
    ),
  );
}

vi.mock("@/lib/dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dispatch")>();
  return {
    ...actual,
    fetchDispatchPlan: vi.fn(),
    dispatchNewConversation: vi.fn(),
  };
});
const mockFetchPlan = vi.mocked(fetchDispatchPlan);

const runnable: NewConvAgent = {
  sync_id: "a-1",
  name: "Reviewer",
  project_sync_ids: ["p-1"],
  has_available_target: true,
  exec_targets: [
    { rank: 1, availability: "available", current: true, device_name: "box" },
  ],
};
const blocked: NewConvAgent = {
  sync_id: "a-2",
  name: "Docs",
  project_sync_ids: ["p-1"],
  has_available_target: false,
  exec_targets: [{ rank: 1, availability: "offline", device_name: "mac" }],
};
const projects: NewConvProject[] = [{ sync_id: "p-1", name: "frontend" }];

const planOk: DispatchPlan = {
  agent_sync_id: "a-1",
  tiers: [
    {
      rank: 1,
      backend_sync_id: "b-a",
      device_id: 1,
      device_name: "box",
      backend_type: "claudecode",
      kind: "agentred",
      availability: "available",
      current: true,
    },
    {
      rank: 2,
      backend_sync_id: "b-b",
      device_id: 2,
      device_name: "mac",
      backend_type: "codex",
      kind: "agentred",
      availability: "available",
      current: false,
    },
  ],
  chosen: {
    device_fingerprint: "fp",
    device_id: 1,
    device_name: "box",
    backend_type: "claudecode",
    kind: "agentred",
  },
  projects: [{ sync_id: "p-1", name: "frontend", configured: true }],
};
const planNone: DispatchPlan = {
  agent_sync_id: "a-2",
  tiers: [
    { rank: 1, availability: "offline", device_name: "mac", current: false },
  ],
  chosen: null,
  projects: [],
};

function wrap(ui: React.ReactNode) {
  return render(
    <MemoryRouter>
      <ThemeProvider>{ui}</ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockFetchPlan.mockReset();
});

describe("新建对话：选择列表无边线，行落在填充上", () => {
  it("Agent 选择列表（含骨架）没有结构线，可选行是字段填充、跑不了的行不变", () => {
    const { container } = wrap(
      <>
        <AgentPickList
          agents={[runnable, blocked]}
          recentIds={[]}
          onPick={() => {}}
        />
        <AgentPickSkeleton columns={2} />
      </>,
    );
    expect(edgeClasses(container)).toEqual([]);
    const row = screen.getByTestId("agent-pick-a-1");
    expect(row.className).toContain("bg-field-fill");
    expect(row.className).toContain("hover:bg-field-fill-hover");
    expect(screen.getByTestId("agent-pick-a-2").className).toContain(
      "cursor-not-allowed",
    );
  });

  it("新建对话面板没有结构线", () => {
    const { container } = wrap(
      <NewConversationPane
        agents={[runnable, blocked]}
        recentIds={[]}
        onPick={vi.fn()}
        onFromProject={vi.fn()}
      />,
    );
    expect(edgeClasses(container)).toEqual([]);
  });

  it("移动端抽屉没有结构线", () => {
    wrap(
      <NewConversationSheet
        open
        onOpenChange={vi.fn()}
        agents={[runnable, blocked]}
        recentIds={[]}
        onPick={vi.fn()}
        onFromProject={vi.fn()}
      />,
    );
    expect(edgeClasses(screen.getByTestId("new-conversation-sheet"))).toEqual(
      [],
    );
  });

  it("从项目里挑：整屏没有结构线，Agent 行是填充", () => {
    const { container } = wrap(
      <ProjectAgentPane
        projects={projects}
        agents={[runnable, blocked]}
        onPick={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(edgeClasses(container)).toEqual([]);
    expect(screen.getByTestId("project-agent-a-1").className).toContain(
      "bg-field-fill",
    );
  });

  it("从项目里挑：窄屏横排的项目 chip 是填充，没有结构线", () => {
    const { container } = wrap(
      <ProjectAgentPane
        projects={projects}
        agents={[runnable]}
        stacked
        onPick={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(edgeClasses(container)).toEqual([]);
  });

  it("从项目里挑：项目树加载中的骨架没有结构线", () => {
    const { container } = wrap(
      <ProjectAgentPane
        projects={[]}
        agents={[]}
        projectsSettled={false}
        onPick={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(edgeClasses(container)).toEqual([]);
  });
});

describe("新建对话：草稿会话无结构线", () => {
  it("草稿的头、输入区与「在哪台机器上跑」弹层没有结构线", async () => {
    mockFetchPlan.mockResolvedValue(planOk);
    wrap(
      <DraftSession
        agent={runnable}
        agents={[runnable]}
        projects={projects}
        onStarted={vi.fn()}
      />,
    );
    const chip = await screen.findByTestId("draft-exec-target-chip");
    fireEvent.click(chip);
    await waitFor(() => expect(document.body.textContent).toContain("mac"));
    expect(edgeClasses(document.body)).toEqual([]);
  });

  it("一档都跑不了的提示是填充块，不再描边", async () => {
    mockFetchPlan.mockResolvedValue(planNone);
    wrap(
      <DraftSession
        agent={blocked}
        agents={[blocked]}
        projects={projects}
        onStarted={vi.fn()}
      />,
    );
    const box = await screen.findByTestId("draft-all-unavailable");
    expect(edgeClasses(box)).toEqual([]);
    expect(edgeClasses(document.body)).toEqual([]);
    expect(box.className).toContain("bg-destructive-soft");
  });
});

describe("新建对话：各面板直接落在内容页上，不自涂底色", () => {
  it("挑 Agent 的面板：根、页头与「从项目里挑」那一行都不涂 background / card", () => {
    wrap(
      <NewConversationPane
        agents={[runnable, blocked]}
        recentIds={[]}
        onPick={vi.fn()}
        onFromProject={vi.fn()}
      />,
    );
    expect(
      selfPaintedSurfaces(screen.getByTestId("new-conversation-pane")),
    ).toEqual([]);
  });

  it("从项目里挑：根、页头、项目列与选中项目那条带都不涂 background / card", () => {
    wrap(
      <ProjectAgentPane
        projects={projects}
        agents={[runnable, blocked]}
        onPick={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(
      selfPaintedSurfaces(screen.getByTestId("project-agent-pane")),
    ).toEqual([]);
  });

  it("草稿：根、顶带与输入区都不涂 background / card——与落地后的详情同一张纸", async () => {
    mockFetchPlan.mockResolvedValue(planOk);
    wrap(
      <DraftSession
        agent={runnable}
        agents={[runnable]}
        projects={projects}
        onStarted={vi.fn()}
      />,
    );
    await screen.findByTestId("draft-exec-target-chip");
    expect(selfPaintedSurfaces(screen.getByTestId("draft-session"))).toEqual(
      [],
    );
  });
});
