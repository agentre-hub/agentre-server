import { describe, expect, it } from "vitest";

import {
  createSyncIdRegistry,
  isFiltering,
  matchedTotal,
  projectCountOf,
  scopeShowsGlyphs,
  toBoardColumns,
  toBoardQueryString,
  timeRangeToEpoch,
  toIssueFields,
  toTaskFormValue,
} from "@/lib/boardWire";
import type { IssueBoardResponse } from "@/lib/issues";
import { EMPTY_BOARD_QUERY } from "@agentre-hub/agentre-ui";

/**
 * 看板宿主那一半的**纯翻译层**（规格 2026-08-27「`agentre-server` 端」）。
 *
 * 共享包说的是数字 id（桌面端的本地自增主键），账号这一侧说的是同步标识。两者之间
 * 的换算与六个筛选条件翻成 query string 全在这里 —— 没有一行 React、没有一次
 * fetch，所以「30 天算成哪一刻」「哪一列有几张卡」这类判断测得到。
 */
const registry = () => createSyncIdRegistry();

describe("sync id registry", () => {
  it("gives one stable number per sync id, and answers back with the sync id", () => {
    const ids = registry();
    const first = ids.idOf("iss-1");

    expect(ids.idOf("iss-1")).toBe(first);
    expect(ids.idOf("iss-2")).not.toBe(first);
    expect(ids.syncIdOf(first)).toBe("iss-1");
  });

  it("keeps 0 for 「没有」: an empty sync id is not an object", () => {
    const ids = registry();

    expect(ids.idOf("")).toBe(0);
    expect(ids.syncIdOf(0)).toBe("");
    expect(ids.syncIdOf(9999)).toBe("");
  });
});

describe("board query string", () => {
  const nowMs = Date.parse("2026-08-27T12:00:00Z");

  it("carries the project subtree scope as scope + project_sync_id", () => {
    const ids = registry();
    const projectId = ids.idOf("proj-web");
    const params = new URLSearchParams(
      toBoardQueryString(
        { ...EMPTY_BOARD_QUERY, scope: { kind: "project", projectId } },
        nowMs,
        ids,
      ),
    );

    expect(params.get("scope")).toBe("project");
    expect(params.get("project_sync_id")).toBe("proj-web");
  });

  // 「今天」与自定义两档此前一次都没被调用过：把「今天」算成当下这一刻（而不是
  // 当天零点），或者把自定义区间的两端调换，整套用例照样绿。
  it("turns 「今天」 into that day's midnight and leaves the upper end open", () => {
    const nowMs = new Date("2026-08-27T15:42:11").getTime();
    const midnight = new Date("2026-08-27T00:00:00").getTime();

    expect(timeRangeToEpoch({ preset: "today" }, nowMs)).toEqual({
      from: midnight,
      to: 0,
    });
  });

  it("passes a custom range through unchanged, and reads a missing end as 不限", () => {
    const from = new Date("2026-08-01T00:00:00").getTime();
    const to = new Date("2026-08-28T00:00:00").getTime() - 1;

    expect(timeRangeToEpoch({ preset: "custom", from, to }, 0)).toEqual({
      from,
      to,
    });
    expect(timeRangeToEpoch({ preset: "custom", from }, 0)).toEqual({
      from,
      to: 0,
    });
    expect(timeRangeToEpoch({ preset: "any" }, 0)).toEqual({ from: 0, to: 0 });
  });

  it("sends 「全部满足」 as label_match_all with the label sync ids", () => {
    const ids = registry();
    const bug = ids.idOf("lab-bug");
    const docs = ids.idOf("lab-docs");
    const params = new URLSearchParams(
      toBoardQueryString(
        {
          ...EMPTY_BOARD_QUERY,
          labelIds: [bug, docs],
          labelMatch: "all",
        },
        nowMs,
        ids,
      ),
    );

    expect(params.getAll("label_sync_ids")).toEqual(["lab-bug", "lab-docs"]);
    expect(params.get("label_match_all")).toBe("true");
  });

  it("turns the last-7-days preset into an epoch lower bound and leaves the upper end open", () => {
    const params = new URLSearchParams(
      toBoardQueryString(
        { ...EMPTY_BOARD_QUERY, updated: { preset: "7d" } },
        nowMs,
        registry(),
      ),
    );

    expect(Number(params.get("updated_from"))).toBe(nowMs - 7 * 86_400_000);
    expect(params.get("updated_to")).toBeNull();
  });

  it("keeps 「已完成保留多久」 as days, and drops it entirely for 全部", () => {
    const kept = new URLSearchParams(
      toBoardQueryString(
        { ...EMPTY_BOARD_QUERY, doneRetention: "90d" },
        nowMs,
        registry(),
      ),
    );
    const all = new URLSearchParams(
      toBoardQueryString(
        { ...EMPTY_BOARD_QUERY, doneRetention: "all" },
        nowMs,
        registry(),
      ),
    );

    expect(kept.get("done_within_days")).toBe("90");
    expect(all.get("done_within_days")).toBeNull();
  });

  it("asks for no ordering: the board's order is the one people dragged", () => {
    const params = new URLSearchParams(
      toBoardQueryString(EMPTY_BOARD_QUERY, nowMs, registry()),
    );

    // 决策 10「不给看板加排序」：没有第二种次序可选，也就没有一个要说的参数。
    expect(params.has("sort")).toBe(false);
  });
});

describe("filtering verdict", () => {
  it("does not call a bare project scope 「筛选中」: totals already follow the scope", () => {
    expect(
      isFiltering({
        ...EMPTY_BOARD_QUERY,
        scope: { kind: "project", projectId: 1 },
      }),
    ).toBe(false);
  });

  it("calls a keyword 「筛选中」", () => {
    expect(isFiltering({ ...EMPTY_BOARD_QUERY, keyword: "login" })).toBe(true);
  });
});

const response: IssueBoardResponse = {
  issues: [
    {
      sync_id: "iss-2",
      title: "Second",
      description: "",
      stage: "todo",
      position: 2,
      project_sync_id: "proj-web",
      closed_at: 0,
      created_at: 1,
      updated_at: 5,
      labels: [],
    },
    {
      sync_id: "iss-1",
      title: "First",
      description: "why",
      stage: "todo",
      position: 1,
      project_sync_id: "",
      agent_sync_id: "agent-a",
      agent_backend_sync_id: "backend-1",
      llm_provider_key: "p",
      llm_model_key: "m",
      closed_at: 0,
      created_at: 1,
      updated_at: 6,
      labels: [
        { sync_id: "lab-bug", name: "bug", tone: "red", usage_count: 0 },
      ],
    },
  ],
  labels: [{ sync_id: "lab-bug", name: "bug", tone: "red", usage_count: 3 }],
  stage_counts: { todo: 2, doing: 0, review: 0, done: 0 },
  stage_totals: { todo: 7, doing: 1, review: 0, done: 4 },
  project_counts: [
    { project_sync_id: "proj-web", count: 3 },
    { project_sync_id: "", count: 2 },
  ],
};

describe("response → view model", () => {
  it("lays the cards out in position order inside their own column, and keeps the four columns", () => {
    const columns = toBoardColumns(response, registry(), () => null);

    expect(columns.todo?.cards.map((card) => card.title)).toEqual([
      "First",
      "Second",
    ]);
    expect(Object.keys(columns).sort()).toEqual([
      "doing",
      "done",
      "review",
      "todo",
    ]);
  });

  it("hands the description down so a keyword hit inside it can be quoted on the card", () => {
    const columns = toBoardColumns(response, registry(), () => null);
    const first = columns.todo?.cards[0];

    expect(first?.hasDescription).toBe(true);
    expect(first?.description).toBe("why");
  });

  it("keeps 「命中 / 全部」 apart: totals ignore the filters, counts do not", () => {
    const columns = toBoardColumns(response, registry(), () => null);

    expect(columns.todo?.matched).toBe(2);
    expect(columns.todo?.total).toBe(7);
    expect(columns.done?.total).toBe(4);
    expect(matchedTotal(response.stage_counts)).toBe(2);
  });

  it("reads the subtree count per project, and 未归属 off the empty sync id", () => {
    const ids = registry();

    expect(projectCountOf(response.project_counts, "proj-web")).toBe(3);
    expect(projectCountOf(response.project_counts, "")).toBe(2);
    // 计数里没有的项目读作 0，而不是 undefined：选择器右侧那一栏画的就是这个数。
    expect(projectCountOf(response.project_counts, "proj-nowhere")).toBe(0);
    void ids;
  });

  it("spreads one task back onto the form, execution assignment included", () => {
    const ids = registry();
    const value = toTaskFormValue(response.issues[1], ids);

    expect(value.title).toBe("First");
    expect(value.description).toBe("why");
    // 未归属在表单里说的是 null，不是 0。
    expect(value.projectId).toBeNull();
    expect(ids.syncIdOf(value.assigneeAgentId ?? 0)).toBe("agent-a");
    expect(ids.syncIdOf(value.agentBackendId ?? 0)).toBe("backend-1");
    expect(value.llmProviderKey).toBe("p");
    expect(value.llmModelKey).toBe("m");
    expect(value.labelIds.map((id) => ids.syncIdOf(id))).toEqual(["lab-bug"]);
  });

  it("writes the form back as sync ids, and 未归属 as an explicit empty string", () => {
    const ids = registry();
    const fields = toIssueFields(
      {
        title: " Fix ",
        description: "d",
        stage: "doing",
        projectId: null,
        labelIds: [ids.idOf("lab-bug")],
        assigneeAgentId: ids.idOf("agent-a"),
        agentBackendId: null,
        llmProviderKey: "p",
        llmModelKey: "",
      },
      ids,
    );

    expect(fields).toEqual({
      title: "Fix",
      description: "d",
      stage: "doing",
      project_sync_id: "",
      agent_sync_id: "agent-a",
      agent_backend_sync_id: "",
      llm_provider_key: "p",
      llm_model_key: "",
      label_sync_ids: ["lab-bug"],
    });
  });
});

describe("project glyphs on cards", () => {
  const projects = [
    { id: 1, depth: 0 },
    { id: 2, depth: 1 },
    { id: 3, depth: 0 },
  ];

  it("draws them for 全部项目 and for a parent with children, not for a leaf or 未归属", () => {
    expect(scopeShowsGlyphs({ kind: "all" }, projects)).toBe(true);
    expect(scopeShowsGlyphs({ kind: "unassigned" }, projects)).toBe(false);
    expect(scopeShowsGlyphs({ kind: "project", projectId: 1 }, projects)).toBe(
      true,
    );
    expect(scopeShowsGlyphs({ kind: "project", projectId: 3 }, projects)).toBe(
      false,
    );
  });
});
