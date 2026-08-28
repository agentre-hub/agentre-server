/**
 * 「挑一个 Agent 开新对话」的分组与排序，改走共享包的 `groupAgentsForPicking`。
 *
 * 这条规则桌面端也有一份（`command-palette/sources/new-chat-source.tsx` 的
 * `flattenAgents`：按 chattable 分两组、上次选过的冒泡到最前、不可对话的留下但
 * 不可点）。判据与顺序是同一条，呈现不是——那边冒泡进同一组，这边单列一组带
 * 标题——所以进包的只有判据，标题与容器留在两端各自。
 *
 * 顺带修掉一个本地那份没处理的：`readRecentAgents` 只过滤非字符串、**不去重**
 * （去重在 `rememberAgent` 的写入端，而它自己的注释写明「存的东西是上一版本的
 * 自己写的」）。于是 localStorage 里留着重复 id 时，同一个 Agent 会在「最近用过」
 * 里渲染两次，还会撞 React key。
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "@/i18n";
import { AgentPickList } from "@/components/session/newconv/AgentPickList";
import type { NewConvAgent } from "@/components/session/newconv/types";

function agent(
  sync_id: string,
  has_available_target: boolean,
  name = sync_id,
): NewConvAgent {
  return {
    sync_id,
    name,
    has_available_target,
    exec_targets: has_available_target
      ? [
          {
            rank: 1,
            availability: "available",
            current: true,
            device_name: "m1",
          },
        ]
      : [{ rank: 1, availability: "offline", device_name: "m1" }],
  };
}

const AGENTS = [
  agent("a", true),
  agent("b", true),
  agent("c", false),
  agent("d", true),
];

describe("AgentPickList 的分组", () => {
  it("Given recentIds 里同一个 id 记了两次, When 渲染, Then 它只出现一次", () => {
    // localStorage 里的那份是历史遗留，可能带重复。渲染两次不只是难看：
    // 同一个 key 的两个 <li> 会让 React 认错行。
    render(
      <AgentPickList
        agents={AGENTS}
        recentIds={["a", "a"]}
        onPick={() => {}}
      />,
    );

    expect(screen.getAllByTestId("agent-pick-a")).toHaveLength(1);
  });

  it("Given 最近用过的, When 渲染, Then 它单列一组、且不在「可以开」里重复出现", () => {
    render(
      <AgentPickList agents={AGENTS} recentIds={["d"]} onPick={() => {}} />,
    );

    expect(screen.getByTestId("agent-group-recent")).toBeTruthy();
    expect(screen.getAllByTestId("agent-pick-d")).toHaveLength(1);
  });

  it("Given 现在开不了的, When 渲染, Then 它留在列表里但不可点", () => {
    // 藏起来会让人以为 Agent 丢了；可点则是把死路留到点完之后才说。
    render(<AgentPickList agents={AGENTS} recentIds={[]} onPick={() => {}} />);

    const unavailable = screen.getByTestId("agent-pick-c");
    expect(unavailable.hasAttribute("disabled")).toBe(true);
    const group = screen.getByTestId("agent-group-unavailable");
    expect(group).toBeTruthy();
  });

  it("Given 最近用过但现在开不了的, When 渲染, Then 它落回「现在开不了」而不是排在最前", () => {
    // 把一个点不动的 Agent 摆在最显眼的第一组，等于把死路放在最前面。
    render(
      <AgentPickList agents={AGENTS} recentIds={["c"]} onPick={() => {}} />,
    );

    expect(screen.queryByTestId("agent-group-recent")).toBeNull();
    const group = screen
      .getByTestId("agent-group-unavailable")
      .closest("section") as HTMLElement;
    expect(within(group).getByTestId("agent-pick-c")).toBeTruthy();
  });
});
