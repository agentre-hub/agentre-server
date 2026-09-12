/**
 * 项目组头上的动作 —— 本站这一侧的**装配**（规格 2026-08-22 C 段）。
 *
 * 动作本身（条目全集、顺序、能力开关、＋ 的成员浮层、未配置角标）住在共享包里，
 * 在那边测过 18 例。这里只留本站装配才证得了的两件事：
 *
 *   1. 显形类与组头外壳挂的组名**配得上对** —— 两件都在包里，但把它们摆到一起的是
 *      这一层，配不上对就是宽屏下 ＋/⋮ 永远隐身，而两边各自的测试都不会红。
 *   2. 本站一条可选项都不声明，中间那一组是空的，不留下一道空分隔线。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectGroupHeader,
  ProjectHeaderActions,
  ProjectHeaderContextMenu,
  type ProjectHeaderActionsProps,
} from "@agentre-hub/agentre-ui";

const MEMBERS = [
  { id: "agent-a", name: "后端小助手", color: "agent-3" },
  { id: "agent-b", name: "前端小助手", color: "agent-7" },
];

function handlers(
  over: Partial<ProjectHeaderActionsProps> = {},
): ProjectHeaderActionsProps {
  return {
    projectId: "proj-1",
    projectName: "agentre-server",
    unconfigured: false,
    // 本站手里已经有成员，回一个已决议的 promise。
    loadMembers: vi.fn(async () => MEMBERS),
    capabilities: { terminal: false, merge: false },
    onNewChat: vi.fn(),
    onOpenSettings: vi.fn(),
    onNewSubproject: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
}

/** 与 SessionIndex 的装配同形：actions 由共享包外壳摆在折叠按钮外。 */
function renderAssembled(over: Partial<ProjectHeaderActionsProps> = {}) {
  const h = handlers(over);
  render(
    <ProjectHeaderContextMenu {...h}>
      <ProjectGroupHeader
        testId="group-header"
        className="mb-1"
        expanded
        onToggle={() => {}}
        attentionCount={0}
        attentionTone={null}
        actions={<ProjectHeaderActions {...h} />}
        project={{ name: h.projectName, color: "agent-1" }}
        depth={0}
      />
    </ProjectHeaderContextMenu>,
  );
  return h;
}

describe("本站的组头装配", () => {
  /**
   * 回归（2026-08-22）：组头换进共享包后，外壳挂的组名是 `group/group-header`，而
   * ＋/⋮ 的显形一度还写着旧本地组头的 `group-hover/header` —— 名字对不上，宽屏下
   * hover 永远显不了形。守卫方式是**配对**而不是钉字符串：affordance 里的组名必须
   * 在祖先链上真的有一枚同名 group 标记，组头再换外壳也不会静默断开。
   */
  it("＋/⋮ 的显形挂在祖先链上真实存在的组名上——配不上对就永远隐身", () => {
    renderAssembled();
    for (const id of ["project-add-proj-1", "project-menu-proj-1"]) {
      const el = screen.getByTestId(id);
      const match = el.className.match(/sm:group-hover\/([\w-]+):opacity-100/);
      expect(
        match,
        `${id} 应带 sm:group-hover/<组名>:opacity-100`,
      ).not.toBeNull();
      const marker = `group/${match?.[1]}`;
      let node = el.parentElement;
      let paired = false;
      while (node) {
        if (node.classList.contains(marker)) {
          paired = true;
          break;
        }
        node = node.parentElement;
      }
      expect(
        paired,
        `${id} 的显形挂在 ${marker} 上，但祖先链上没有这枚标记`,
      ).toBe(true);
    }
  });

  /**
   * 本站三条可选项一条都不声明（没有终端、没有合并、没有导入本地会话），中间那一组
   * 因此是空的 —— 空组不能留下一道分隔线。「成员…」「机器与路径…」已经并回
   * 「项目设置…」（2026-08-27，弹窗一屏放得下），所以这里只剩两组三条。
   */
  it("本站不声明任何可选项，菜单只剩两组三条，且不留空组的分隔线", async () => {
    renderAssembled();
    fireEvent.pointerDown(screen.getByTestId("project-menu-proj-1"), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByRole("menu");
    const ids = Array.from(
      menu.querySelectorAll("[data-testid^='project-menu-item-']"),
    ).map((n) => n.getAttribute("data-testid"));
    expect(ids).toEqual([
      "project-menu-item-settings",
      "project-menu-item-new-subproject",
      "project-menu-item-delete",
    ]);
    // 中间那一组是空的：分隔线只该有一道（删除前面那一道），不该在它两侧各来一道。
    expect(menu.querySelectorAll("[role='separator']")).toHaveLength(1);
  });

  it("点组头里的 ＋ 不把这一组收起来 —— 它嵌在那颗收放按钮里", async () => {
    const onToggle = vi.fn();
    const h = handlers();
    render(
      <button type="button" onClick={onToggle}>
        {h.projectName}
        <ProjectHeaderActions {...h} />
      </button>,
    );
    fireEvent.click(screen.getByTestId("project-add-proj-1"));
    await screen.findByTestId("project-member-option-agent-a");
    fireEvent.click(screen.getByTestId("project-member-option-agent-a"));
    expect(h.onNewChat).toHaveBeenCalledWith("proj-1", "agent-a");
    expect(onToggle).not.toHaveBeenCalled();
  });
});
