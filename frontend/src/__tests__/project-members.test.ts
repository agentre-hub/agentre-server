/**
 * 「这个项目里有哪些 Agent」——直接成员与继承自父项目的成员。
 *
 * 继承在**浏览器**这一侧算：项目树整份都下发了（/v1/workspace/projects 带
 * parent_sync_id），服务端只如实回「直接加入了哪些项目」。同一条规则实现两遍，
 * 两处一旦分叉就没人说得清哪个对。
 */
import { describe, expect, it } from "vitest";

import { membersOfProject } from "@/components/session/newconv/projectMembers";
import type {
  NewConvAgent,
  NewConvProject,
} from "@/components/session/newconv/types";

const projects: NewConvProject[] = [
  { sync_id: "root", name: "agentre-server" },
  { sync_id: "fe", name: "frontend", parent_sync_id: "root" },
  { sync_id: "deep", name: "components", parent_sync_id: "fe" },
  { sync_id: "other", name: "agentre" },
];

function agent(id: string, projectIds?: string[]): NewConvAgent {
  return {
    sync_id: id,
    name: id,
    has_available_target: true,
    exec_targets: [],
    ...(projectIds ? { project_sync_ids: projectIds } : {}),
  };
}

const agents = [
  agent("a-root", ["root"]),
  agent("a-fe", ["fe"]),
  agent("a-deep", ["deep"]),
  agent("a-other", ["other"]),
  agent("a-none"),
  agent("a-both", ["root", "fe"]),
];

describe("membersOfProject", () => {
  it("直接成员 = 把这个项目写在自己名下的那些", () => {
    const { direct } = membersOfProject("fe", projects, agents);
    expect(direct.map((a) => a.sync_id)).toEqual(["a-fe", "a-both"]);
  });

  it("继承 = 祖先项目的直接成员，逐级往上走而不是只看父一级", () => {
    const { inherited } = membersOfProject("deep", projects, agents);
    // deep 的父是 fe、祖父是 root：两级的成员都继承得到。
    expect(inherited.map((a) => a.sync_id)).toEqual([
      "a-fe",
      "a-both",
      "a-root",
    ]);
  });

  it("同时是直接成员与祖先成员时只算直接，不在两组里各出现一次", () => {
    const { direct, inherited } = membersOfProject("fe", projects, agents);
    expect(direct.map((a) => a.sync_id)).toContain("a-both");
    expect(inherited.map((a) => a.sync_id)).not.toContain("a-both");
  });

  it("根项目没有可继承的东西", () => {
    const { direct, inherited } = membersOfProject("root", projects, agents);
    expect(direct.map((a) => a.sync_id)).toEqual(["a-root", "a-both"]);
    expect(inherited).toEqual([]);
  });

  it("不属于任何项目的 Agent 哪个项目里都不出现", () => {
    for (const id of ["root", "fe", "deep", "other"]) {
      const { direct, inherited } = membersOfProject(id, projects, agents);
      const all = [...direct, ...inherited].map((a) => a.sync_id);
      expect(all).not.toContain("a-none");
    }
  });

  it("兄弟项目的成员不串味", () => {
    const { direct, inherited } = membersOfProject("other", projects, agents);
    expect(direct.map((a) => a.sync_id)).toEqual(["a-other"]);
    expect(inherited).toEqual([]);
  });

  // 项目树是别处（桌面端）建的，环理论上不该出现——但真出现时要的是「列不全」，
  // 不是把浏览器挂死在一个 while 里。
  it("父子成环时不死循环", () => {
    const cyclic: NewConvProject[] = [
      { sync_id: "x", name: "x", parent_sync_id: "y" },
      { sync_id: "y", name: "y", parent_sync_id: "x" },
    ];
    const { inherited } = membersOfProject("x", cyclic, [agent("a-y", ["y"])]);
    expect(inherited.map((a) => a.sync_id)).toEqual(["a-y"]);
  });

  it("项目不存在时两组都空，而不是抛", () => {
    const { direct, inherited } = membersOfProject("gone", projects, agents);
    expect(direct).toEqual([]);
    expect(inherited).toEqual([]);
  });
});
