import { describe, expect, it } from "vitest";

import {
  buildOrgModels,
  filterRowsByBackend,
  parsePromptJSON,
  parseToolsJSON,
  stringifyPromptJSON,
} from "@/pages/org/adapter";
import type {
  OrgAgentItem,
  OrgChartResponse,
  OrgDepartmentItem,
} from "@/pages/org/types";

/**
 * 共享包 `buildOrgIndex` / `OrgAgentRow` / `OrgPlacementField` 等呈现件全部按
 * **数字 id**（0 = 无）设计（`agentre-ui/src/org/types.ts`）：那是桌面端 Wails 行的
 * 真实数据库自增 id。server 这一侧的组织行只有账号级同步标识 `sync_id`（字符串）——
 * 两者从结构上就不兼容,这里是唯一的桥。
 *
 * 桥必须满足：同一份响应快照里，id 与 sync_id 互为唯一映射；`""` 与 `0` 同义
 * （对应「不属于任何部门 / 没有上级」）；两份不同的响应各自映射，互不污染。
 */
function dept(partial: Partial<OrgDepartmentItem>): OrgDepartmentItem {
  return {
    sync_id: "dept-1",
    name: "Dept",
    sort_order: 0,
    ...partial,
  };
}

function agent(partial: Partial<OrgAgentItem>): OrgAgentItem {
  return {
    sync_id: "agent-1",
    name: "Agent",
    sort_order: 0,
    exec_targets: [],
    ...partial,
  };
}

describe("buildOrgModels", () => {
  it("Given a chart response, When built, Then every agent/department gets a stable positive numeric id and the reverse map recovers the original sync_id", () => {
    const chart: OrgChartResponse = {
      departments: [dept({ sync_id: "dept-a", name: "A" })],
      agents: [
        agent({
          sync_id: "agent-a",
          name: "Alice",
          department_sync_id: "dept-a",
        }),
      ],
    };
    const built = buildOrgModels(chart);

    const deptModel = built.departments[0];
    const agentModel = built.agents[0];
    expect(deptModel.id).toBeGreaterThan(0);
    expect(agentModel.id).toBeGreaterThan(0);
    expect(agentModel.departmentId).toBe(deptModel.id);
    expect(built.maps.deptSyncOf(deptModel.id)).toBe("dept-a");
    expect(built.maps.agentSyncOf(agentModel.id)).toBe("agent-a");
  });

  it("Given an empty department_sync_id / parent_agent_sync_id, When built, Then it maps to 0 (root / no manager) not a real id", () => {
    const chart: OrgChartResponse = {
      departments: [],
      agents: [
        agent({
          sync_id: "agent-a",
          department_sync_id: "",
          parent_agent_sync_id: "",
        }),
      ],
    };
    const built = buildOrgModels(chart);
    expect(built.agents[0].departmentId).toBe(0);
    expect(built.agents[0].parentAgentId).toBe(0);
    expect(built.maps.deptSyncOf(0)).toBe("");
    expect(built.maps.agentSyncOf(0)).toBe("");
  });

  it("Given a department with no agents, When built, Then it still appears in the model (empty departments are never dropped by the adapter)", () => {
    const chart: OrgChartResponse = {
      departments: [dept({ sync_id: "dept-empty", name: "Empty" })],
      agents: [],
    };
    const built = buildOrgModels(chart);
    expect(built.departments).toHaveLength(1);
    expect(built.departments[0].memberCount).toBe(0);
  });

  it("Given two agents in the same department, When built, Then the department's memberCount reflects both", () => {
    const chart: OrgChartResponse = {
      departments: [dept({ sync_id: "dept-a" })],
      agents: [
        agent({ sync_id: "agent-a", department_sync_id: "dept-a" }),
        agent({ sync_id: "agent-b", department_sync_id: "dept-a" }),
      ],
    };
    const built = buildOrgModels(chart);
    expect(built.departments[0].memberCount).toBe(2);
  });

  it("Given two independently built snapshots, When the same sync_id appears in both, Then their numeric ids need not match (each snapshot owns its own mapping)", () => {
    const chartA: OrgChartResponse = {
      departments: [],
      agents: [agent({ sync_id: "x" }), agent({ sync_id: "agent-a" })],
    };
    const chartB: OrgChartResponse = {
      departments: [],
      agents: [agent({ sync_id: "agent-a" })],
    };
    const builtA = buildOrgModels(chartA);
    const builtB = buildOrgModels(chartB);
    // 两份快照各自独立：不要求跨快照 id 稳定，只要求快照内部自洽（上面几条已覆盖）。
    expect(builtA.maps.agentSyncOf(builtA.agents[1].id)).toBe("agent-a");
    expect(builtB.maps.agentSyncOf(builtB.agents[0].id)).toBe("agent-a");
  });

  it("Given raw items, When looked up by sync_id, Then the raw OrgAgentItem/OrgDepartmentItem (with exec_targets) is recoverable for form submission", () => {
    const chart: OrgChartResponse = {
      departments: [dept({ sync_id: "dept-a" })],
      agents: [
        agent({
          sync_id: "agent-a",
          exec_targets: [
            {
              sync_id: "et-1",
              rank: 1,
              is_local_reference: false,
              availability: "available",
              current: true,
            },
          ],
        }),
      ],
    };
    const built = buildOrgModels(chart);
    expect(built.agentBySync.get("agent-a")?.exec_targets).toHaveLength(1);
    expect(built.departmentBySync.get("dept-a")?.sync_id).toBe("dept-a");
  });
});

/**
 * 索引行尾那两维（共享包 `OrgAgentModel` 的 `backend` / `noExecTarget`）都是**宿主
 * 算的**：包只画，不判定。这一组钉住算法本身，页面那一层（org-page.test.tsx）钉的是
 * 画出来的样子。
 */
describe("buildOrgModels：行尾徽标读第一档，「无目标」只在真的没有时才说", () => {
  function targets(
    ...items: Array<{ name: string; availability: string; current: boolean }>
  ) {
    return items.map((it, index) => ({
      sync_id: `et-${index + 1}`,
      rank: index + 1,
      backend_sync_id: `backend-${index + 1}`,
      backend_name: it.name,
      backend_type: "claude_code",
      is_local_reference: false,
      availability: it.availability as "available" | "offline",
      current: it.current,
    }));
  }

  it("Given the current tier is not the first, When built, Then the badge still reads the first tier (aligned with the desktop AgentItem.backend)", () => {
    const built = buildOrgModels({
      departments: [],
      agents: [
        agent({
          exec_targets: targets(
            { name: "Rank one", availability: "offline", current: false },
            { name: "Rank two", availability: "available", current: true },
          ),
        }),
      ],
    });

    expect(built.agents[0].backend).toEqual({ name: "Rank one" });
    expect(built.agents[0].noExecTarget).toBe(false);
  });

  it("Given no tier is available at all, When built, Then the badge is still drawn — nothing available is not the same as nothing configured", () => {
    const built = buildOrgModels({
      departments: [],
      agents: [
        agent({
          exec_targets: targets({
            name: "Rank one",
            availability: "offline",
            current: false,
          }),
        }),
      ],
    });

    expect(built.agents[0].backend).toEqual({ name: "Rank one" });
    expect(built.agents[0].noExecTarget).toBe(false);
  });

  it("Given an empty exec_targets list, When built, Then noExecTarget is true and no badge is fed", () => {
    const built = buildOrgModels({
      departments: [],
      agents: [agent({ exec_targets: [] })],
    });

    expect(built.agents[0].noExecTarget).toBe(true);
    expect(built.agents[0].backend).toBeUndefined();
  });

  it("Given the key is missing from the payload entirely, When built, Then noExecTarget is not claimed — absent is not empty", () => {
    // 契约里 exec_targets 是必填，但载荷是网络来的：键缺席只说明这一份响应没提到
    // 它（旧服务端 / 被裁过的载荷），与「这个 Agent 一档都没有」是两件事，而后者的
    // 后果是「它起不了会话」。所以这里刻意绕过类型断言构造缺键的那一份。
    const withoutKey = { sync_id: "agent-1", name: "Agent", sort_order: 0 };
    const built = buildOrgModels({
      departments: [],
      agents: [withoutKey as unknown as OrgAgentItem],
    });

    expect(built.agents[0].noExecTarget).toBe(false);
    expect(built.agents[0].backend).toBeUndefined();
  });
});

describe("filterRowsByBackend", () => {
  it("Given no backend filter (empty string), When filtering, Then every row passes through unchanged", () => {
    const chart: OrgChartResponse = {
      departments: [],
      agents: [agent({ sync_id: "agent-a" })],
    };
    const built = buildOrgModels(chart);
    const rows = [{ agent: built.agents[0] }] as never;
    expect(
      filterRowsByBackend(rows, "", built.agentBySync, built.maps),
    ).toHaveLength(1);
  });

  it("Given a backend sync id, When an agent has an exec target pointing at it, Then its row passes", () => {
    const chart: OrgChartResponse = {
      departments: [],
      agents: [
        agent({
          sync_id: "agent-a",
          exec_targets: [
            {
              sync_id: "et-1",
              rank: 1,
              backend_sync_id: "backend-1",
              is_local_reference: false,
              availability: "available",
              current: true,
            },
          ],
        }),
      ],
    };
    const built = buildOrgModels(chart);
    const rows = [{ agent: built.agents[0] }] as never;
    expect(
      filterRowsByBackend(rows, "backend-1", built.agentBySync, built.maps),
    ).toHaveLength(1);
    expect(
      filterRowsByBackend(rows, "backend-2", built.agentBySync, built.maps),
    ).toHaveLength(0);
  });
});

describe("prompt JSON round-trip", () => {
  it("Given the desktop's string[] prompt_json shape, When parsed, Then it joins into editable multi-line text, and stringifying it back reproduces an equivalent array", () => {
    const json = JSON.stringify(["line one", "line two"]);
    expect(parsePromptJSON(json)).toBe("line one\nline two");
    expect(JSON.parse(stringifyPromptJSON("line one\nline two"))).toEqual([
      "line one",
      "line two",
    ]);
  });

  it("Given an empty/undefined prompt_json, When parsed, Then it yields empty text without throwing", () => {
    expect(parsePromptJSON(undefined)).toBe("");
    expect(parsePromptJSON("")).toBe("");
    expect(parsePromptJSON("not json")).toBe("");
  });

  it("Given blank lines in the edited text, When stringified, Then blank lines are dropped (matching desktop's own filter)", () => {
    expect(JSON.parse(stringifyPromptJSON("a\n\nb\n"))).toEqual(["a", "b"]);
  });
});

describe("tools JSON round-trip", () => {
  it("Given the desktop's {key,enabled}[] tools_json shape, When parsed, Then it yields an OrgAgentTool[] usable by the shared OrgToolList", () => {
    const json = JSON.stringify([{ key: "org", enabled: true }]);
    expect(parseToolsJSON(json)).toEqual([{ key: "org", enabled: true }]);
  });

  it("Given empty/malformed tools_json, When parsed, Then it yields an empty list rather than throwing", () => {
    expect(parseToolsJSON(undefined)).toEqual([]);
    expect(parseToolsJSON("{not json")).toEqual([]);
  });
});
