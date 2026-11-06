import { describe, expect, it } from "vitest";

import { buildOrgIdMaps } from "./adapter";
import { orgNeedsSetupReasons } from "./needsSetup";
import type { OrgAgentItem, OrgExecTargetItem } from "./types";

const t = (key: string) => `t:${key}`;

function target(over: Partial<OrgExecTargetItem>): OrgExecTargetItem {
  return {
    sync_id: "et",
    rank: 1,
    device_unspecified: false,
    availability: "available",
    current: false,
    ...over,
  };
}

function agent(
  sync_id: string,
  exec_targets: OrgExecTargetItem[],
): OrgAgentItem {
  return { sync_id, name: sync_id, sort_order: 0, exec_targets };
}

describe("orgNeedsSetupReasons", () => {
  const agents = [
    agent("ok", [target({ current: true })]),
    agent("off", [target({ availability: "offline", device_name: "Mac" })]),
    agent("none", []),
    agent("mixed", [
      target({ availability: "unpaired" }),
      target({ sync_id: "et2", rank: 2 }),
    ]),
  ];
  const maps = buildOrgIdMaps([], agents);

  it("只收没有可用执行目标的 Agent，键是数字 id，原因复用既有文案键", () => {
    const reasons = orgNeedsSetupReasons(agents, maps, t);
    expect([...reasons.keys()].sort()).toEqual(
      [maps.agentIdOf("off"), maps.agentIdOf("none")].sort(),
    );
    expect(reasons.get(maps.agentIdOf("off"))).toBe("Mac · t:overview.offline");
    expect(reasons.get(maps.agentIdOf("none"))).toBe(
      "t:overview.noAvailableTarget",
    );
  });

  it("全部可聊时是空 Map", () => {
    expect(orgNeedsSetupReasons([agents[0]], maps, t).size).toBe(0);
  });
});
