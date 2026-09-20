import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import { api } from "@/lib/api";
import * as accountChannel from "@/lib/accountChannel";
import i18n from "@/i18n";
import Org from "@/pages/Org";
import type { OrgChartResponse } from "@/pages/org/types";

/**
 * 任务 S6（规格 2026-09-17「backend config sync」，served requirement:
 * 「组织页切换一个工具开关只改该工具，其它工具项（含 web 不认识的）原样保留」）。
 *
 * OrgAgentDetail.toggleTool 此前按 ORG_TOOL_KEYS（固定 3 个已知 key）重建
 * tools_json，桌面端写进去的、web 不认识的 key 在下一次保存时就被丢了。回归覆盖：
 * 存量 tools_json 带一个未知 key 时，切一个已知开关必须原样保留那个未知条目
 * （连同它的额外字段与次序），只改被点的那一项；已知但缺席的 key 被点时按「追加」
 * 处理，不去补全其余已知 key。
 */
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn() };
});

const mockedApi = vi.mocked(api);
const mockedStartChannel = vi.mocked(accountChannel.startAccountChannel);

const chart: OrgChartResponse = {
  departments: [],
  agents: [
    {
      sync_id: "agent-alice",
      name: "Alice",
      sort_order: 0,
      tools_json: JSON.stringify([
        { key: "org", enabled: true },
        // 桌面端设过、这一版 web 不认得的 key：额外字段与紧跟其后的次序都要原样
        // 活下来，不能被丢或挪位。
        { key: "desktop-secret", enabled: true, note: "desktop-only" },
      ]),
      exec_targets: [],
    },
  ],
};

function mockOrgApi() {
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/workspace/org" && (!init || init.method === undefined))
      return chart;
    if (path === "/v1/workspace/org/backends") return { backends: [] };
    if (path === "/v1/workspace/org/agents/update" && init?.method === "POST")
      return { sync_id: "agent-alice", version: 2 };
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderOrgAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ThemeProvider>
        <Routes>
          <Route path="/org/:kind?/:syncId?" element={<Org />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockedStartChannel.mockReset();
  mockedStartChannel.mockReturnValue({ stop: vi.fn() });
  mockOrgApi();
});

/** update 请求体里的 tools_json，解析成数组；没发出这个请求就直接失败。 */
function sentToolsJson(): unknown[] {
  const call = mockedApi.mock.calls.find(
    ([path, init]) =>
      path === "/v1/workspace/org/agents/update" &&
      (init as RequestInit | undefined)?.method === "POST",
  );
  if (!call) throw new Error("agents/update was not called");
  const body = JSON.parse((call[1] as RequestInit).body as string) as {
    tools_json?: string;
  };
  if (!body.tools_json) throw new Error("tools_json missing from body");
  return JSON.parse(body.tools_json) as unknown[];
}

describe("OrgAgentDetail.toggleTool 保留未知与未改动的工具项", () => {
  it("切一个已知开关时，未知 key 原样保留（含额外字段与次序）", async () => {
    renderOrgAt("/org/agent/agent-alice");

    const revokeOrg = await screen.findByRole("button", {
      name: "Revoke Org Structure",
    });
    fireEvent.click(revokeOrg);

    expect(sentToolsJson()).toEqual([
      { key: "org", enabled: false },
      { key: "desktop-secret", enabled: true, note: "desktop-only" },
    ]);
  });

  it("切一个存量里缺席的已知开关时，追加而不是补全其余已知 key", async () => {
    renderOrgAt("/org/agent/agent-alice");

    const grantSubagent = await screen.findByRole("button", {
      name: "Grant Call Sub-agent",
    });
    fireEvent.click(grantSubagent);

    expect(sentToolsJson()).toEqual([
      { key: "org", enabled: true },
      { key: "desktop-secret", enabled: true, note: "desktop-only" },
      { key: "subagent", enabled: true },
    ]);
  });
});
