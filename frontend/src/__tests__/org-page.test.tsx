import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { agentColorOrder } from "@agentre-hub/agentre-ui";

import { api, ApiError } from "@/lib/api";
import * as accountChannel from "@/lib/accountChannel";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import Org from "@/pages/Org";
import type { OrgChartResponse } from "@/pages/org/types";

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

/**
 * server 组织面（任务 9，规格 2026-08-18「server 端的组织管理面」）：与桌面端
 * 同形的索引 + 详情，只是外壳换成 server 自己的 SideNav；浏览器仅凭自身就能建改删
 * 部门 / Agent / 执行目标，后端只能挑、不能新建也不能编辑。
 */
const chart: OrgChartResponse = {
  departments: [
    { sync_id: "dept-eng", name: "Engineering", sort_order: 0 },
    { sync_id: "dept-empty", name: "Empty Dept", sort_order: 1 },
  ],
  agents: [
    {
      sync_id: "agent-ceo",
      name: "CEO Agent",
      system_badge: "DEFAULT",
      sort_order: 0,
      exec_targets: [],
    },
    {
      sync_id: "agent-alice",
      name: "Alice",
      department_sync_id: "dept-eng",
      avatar_color: "agent-3",
      sort_order: 0,
      prompt_json: JSON.stringify(["You are Alice"]),
      tools_json: JSON.stringify([{ key: "org", enabled: true }]),
      exec_targets: [
        {
          sync_id: "et-1",
          rank: 1,
          backend_sync_id: "backend-1",
          backend_name: "Claude Code",
          backend_type: "claude_code",
          is_local_reference: false,
          availability: "available",
          current: true,
          skills_json: JSON.stringify([{ id: "skill-1", enabled: true }]),
        },
      ],
    },
  ],
};

const backends = [
  {
    sync_id: "backend-1",
    name: "Claude Code",
    backend_type: "claude_code",
    is_local_reference: false,
    availability: "available" as const,
  },
  {
    sync_id: "backend-2",
    name: "Codex",
    backend_type: "codex",
    is_local_reference: false,
    availability: "offline" as const,
  },
];

function mockOrgApi() {
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/workspace/org" && (!init || init.method === undefined))
      return chart;
    if (path === "/v1/workspace/org/backends") return { backends };
    if (init?.method === "POST") {
      return { sync_id: "new-sync-id", version: 1 };
    }
    throw new Error(`unexpected request: ${path}`);
  });
}

/** Alice 那一行的选择按钮：CEO 与 Alice 都有 org-row-select-*，按名字定位到具体那一行。 */
async function selectAlice() {
  const nameNode = await screen.findByText("Alice");
  const row = nameNode.closest('[data-slot="org-index-row"]') as HTMLElement;
  fireEvent.click(within(row).getByTestId(/^org-row-select-/));
}

/**
 * 选中哪一行写在地址里（Org.tsx：路由是选中态的真源，移动端下钻靠它让返回键有用），
 * 所以这里必须把那条路由摆上——只渲染 `<Org />` 的话 `useParams` 永远是空，任何
 * 「点一行然后看详情」的用例都选不中。路由形状与 App.tsx 逐字一致（可选段，一条）。
 */
function renderOrg() {
  return render(
    <MemoryRouter initialEntries={["/org"]}>
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

describe("组织索引：与桌面端同形（共享组件搭成）", () => {
  it("空部门照常摆组头，即使一个 Agent 都没有（决策 13）", async () => {
    renderOrg();
    await screen.findByText("Empty Dept");
    const header = screen
      .getByText("Empty Dept")
      .closest('[data-slot="org-group-header"]');
    expect(header).toBeTruthy();
  });

  // 决策 12「筛选不常驻占位」：顶栏只有搜索框与**一个**筛选入口，两维筛选都收在
  // 它里面。规格明确否决了「常驻两个下拉」，两端同形，这里与桌面端同一条判据。
  it("顶栏只有搜索框与一个筛选入口：两维不各占一个常驻下拉", async () => {
    renderOrg();
    await screen.findByText("Alice");

    expect(screen.getByTestId("org-filter-entry")).toBeTruthy();
    expect(screen.queryByTestId("org-filter-backend")).toBeNull();
    expect(screen.queryByTestId("org-filter-reportsTo")).toBeNull();

    fireEvent.keyDown(screen.getByTestId("org-filter-entry"), {
      key: "Enter",
    });
    expect(await screen.findByText("Filter by backend")).toBeTruthy();
    expect(screen.getByText("Filter by reports-to")).toBeTruthy();
  });

  it("行是共享包的 OrgAgentRow（data-slot 能证明不是宿主自己重造的一份）", async () => {
    renderOrg();
    const aliceText = await screen.findByText("Alice");
    const row = aliceText.closest('[data-slot="org-index-row"]');
    expect(row).toBeTruthy();
    expect(row?.getAttribute("data-agent-id")).toBeTruthy();
  });

  it("系统 Agent 置顶，不挂在任何部门组头下", async () => {
    renderOrg();
    await screen.findByText("CEO Agent");
    const ceoRow = screen
      .getByText("CEO Agent")
      .closest('[data-slot="org-index-row"]');
    expect(ceoRow).toBeTruthy();
  });

  // 层级线索（桌面端 243ead0e）：索引里唯一的层级是「部门套部门」，部门里的行必须
  // 缩在自己的组头下一级 —— 与组头同级的话两者挤在同一条左缘，读不出归属。缩进量
  // 与竖线都在共享包里，宿主要负责的只有「传对 indent」这一件，所以钉在这里。
  it("部门里的行缩在组头下一级，不属于任何部门的行不缩", async () => {
    renderOrg();
    await screen.findByText("Alice");

    const aliceRow = screen
      .getByText("Alice")
      .closest('[data-slot="org-index-row"]');
    expect(aliceRow?.getAttribute("data-indent")).toBe("1");

    const ceoRow = screen
      .getByText("CEO Agent")
      .closest('[data-slot="org-index-row"]');
    expect(ceoRow?.getAttribute("data-indent")).toBe("0");
  });
});

/**
 * 索引收敛（规格 2026-08-18「组织索引收敛」+ 共享包 commit 9e015b13）：行尾那枚
 * 机器名徽标、「无目标」、组头的收放与右侧动作，全部由宿主喂进共享包的呈现件。
 */
describe("索引收敛：行尾徽标、收放、一行工具条、组头动作", () => {
  /** 某个部门名对应的组头元素。 */
  async function groupHeaderOf(name: string) {
    const label = await screen.findByText(name);
    return label.closest('[data-slot="org-group-header"]') as HTMLElement;
  }

  it("行尾画出第一档执行目标的机器名（与桌面端 AgentItem.backend 同一档）", async () => {
    renderOrg();
    const aliceRow = (await screen.findByText("Alice")).closest(
      '[data-slot="org-index-row"]',
    ) as HTMLElement;
    expect(within(aliceRow).getByText("Claude Code")).toBeTruthy();
  });

  it("一档执行目标都没有的 Agent，行尾是「无目标」而不是空白", async () => {
    renderOrg();
    const ceoRow = (await screen.findByText("CEO Agent")).closest(
      '[data-slot="org-index-row"]',
    ) as HTMLElement;
    // 文案来自共享包自己的 namespace（org.index.noExecTarget = "No target"）。
    expect(within(ceoRow).getByText("No target")).toBeTruthy();
  });

  it("组头能收放，收起后这个组的行不渲染", async () => {
    renderOrg();
    const header = await groupHeaderOf("Engineering");
    expect(screen.getByText("Alice")).toBeTruthy();

    const toggle = within(header).getByTestId(/^org-group-toggle-/);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);

    expect(screen.queryByText("Alice")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("工具条收成一行：搜索框与筛选入口同排，且不再有常驻的「新建部门」", async () => {
    renderOrg();
    await screen.findByText("Alice");

    const toolbar = screen.getByTestId("org-index-toolbar");
    // 未筛选时只有那一行（命中后才会多出一行 chips，见 org-index-chips）。
    expect(toolbar.children.length).toBe(1);
    const row = toolbar.children[0] as HTMLElement;
    expect(within(row).getByLabelText("Search agents")).toBeTruthy();
    expect(within(row).getByTestId("org-filter-entry")).toBeTruthy();

    expect(
      within(toolbar).queryByRole("button", { name: "New department" }),
    ).toBeNull();
  });

  it("组头的 ＋ 建的 Agent 直接落在这个部门里", async () => {
    renderOrg();
    const header = await groupHeaderOf("Engineering");

    fireEvent.click(within(header).getByTestId(/^org-group-add-agent-/));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/agents",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mockedApi.mock.calls.find(
      (c) => c[0] === "/v1/workspace/org/agents",
    )!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      name: "Bob",
      department_sync_id: "dept-eng",
    });
  });

  it("新建对话框里的部门也是 Select，改一下就跟着改所属", async () => {
    renderOrg();
    const header = await groupHeaderOf("Engineering");

    fireEvent.click(within(header).getByTestId(/^org-group-add-agent-/));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Bob" },
    });
    // 原生 <select> 在这一步就露馅：option 一直摆在 DOM 里，点了也不改值。
    fireEvent.click(screen.getByRole("combobox", { name: "Department" }));
    fireEvent.click(await screen.findByRole("option", { name: "Empty Dept" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/agents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Bob",
            department_sync_id: "dept-empty",
          }),
        }),
      ),
    );
  });

  it("组头的 ⋮ 建的部门挂在这个部门下（parent_sync_id 指向它）", async () => {
    renderOrg();
    const header = await groupHeaderOf("Engineering");

    fireEvent.keyDown(within(header).getByTestId(/^org-group-more-/), {
      key: "Enter",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "New department" }),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Platform" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/departments",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mockedApi.mock.calls.find(
      (c) => c[0] === "/v1/workspace/org/departments",
    )!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      name: "Platform",
      parent_sync_id: "dept-eng",
    });
  });
});

describe("部门详情：图标与强调色是挑出来的，不是打出来的", () => {
  /** 选中「Engineering」这个部门，返回详情列。 */
  async function openEngineering() {
    renderOrg();
    const label = await screen.findByText("Engineering");
    const header = label.closest(
      '[data-slot="org-group-header"]',
    ) as HTMLElement;
    fireEvent.click(within(header).getByTestId(/^org-group-select-/));
    return screen.getByTestId("org-detail-col");
  }

  it("上级部门是共享包那颗 Select，挑一个只提交 parent_sync_id", async () => {
    const col = await openEngineering();

    // 原生 <select> 在这一步就露馅：option 一直摆在 DOM 里，点了也不改值。
    fireEvent.click(
      within(col).getByRole("combobox", { name: "Parent department" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Empty Dept" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/departments/update",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            sync_id: "dept-eng",
            parent_sync_id: "dept-empty",
          }),
        }),
      ),
    );
  });

  it("负责人同样是 Select，挑一个只提交 lead_agent_sync_id", async () => {
    const col = await openEngineering();

    fireEvent.click(within(col).getByRole("combobox", { name: "Lead" }));
    fireEvent.click(await screen.findByRole("option", { name: "Alice" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/departments/update",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            sync_id: "dept-eng",
            lead_agent_sync_id: "agent-alice",
          }),
        }),
      ),
    );
  });

  it("图标不再是自由文本框，而是一组可挑的图标", async () => {
    const col = await openEngineering();
    expect(within(col).queryByLabelText("Icon key")).toBeNull();
    expect(within(col).getByRole("radiogroup", { name: "Icon" })).toBeTruthy();
  });

  it("挑一个图标只提交 icon 这一个键", async () => {
    const col = await openEngineering();
    const group = within(col).getByRole("radiogroup", { name: "Icon" });
    fireEvent.click(within(group).getByRole("radio", { name: "Launch" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/departments/update",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ sync_id: "dept-eng", icon: "rocket" }),
        }),
      ),
    );
  });

  it("强调色不再是自由文本框，而是与 Agent 同一套色板", async () => {
    const col = await openEngineering();
    expect(within(col).queryByLabelText("Accent color key")).toBeNull();
    const group = within(col).getByRole("radiogroup", {
      name: "Accent color",
    });
    // 与 Agent 头像色板同一套（桌面端 org-detail-department.tsx 用的就是
    // safeAgentColor + agentColorClassNames），所以格数与共享包的 agentColorOrder 一致。
    expect(within(group).getAllByRole("radio").length).toBe(
      agentColorOrder.length,
    );
  });

  it("挑一个强调色只提交 accent_color 这一个键", async () => {
    const col = await openEngineering();
    const group = within(col).getByRole("radiogroup", {
      name: "Accent color",
    });
    fireEvent.click(within(group).getAllByRole("radio")[2]);

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/departments/update",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            sync_id: "dept-eng",
            accent_color: agentColorOrder[2],
          }),
        }),
      ),
    );
  });
});

describe("浏览器仅凭自身建改删部门 / Agent / 执行目标", () => {
  it("新建部门：只经浏览器发一个 POST，不需要桌面端在线", async () => {
    renderOrg();
    await screen.findByText("Empty Dept");

    // 入口不再在索引工具条上（决策 12：顶栏只有搜索框与筛选入口）。没选中任何一行
    // 时详情区的空态里就有这一个，它建的是**顶层**部门（不带 parent_sync_id）。
    fireEvent.click(
      within(screen.getByTestId("org-detail-col")).getByRole("button", {
        name: "New department",
      }),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "QA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/departments",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "QA" }),
        }),
      ),
    );
  });

  it("编辑 Agent 名称：只提交改动的那一个字段，不带上其余未涉及的键", async () => {
    renderOrg();
    await selectAlice();

    const nameInput = await screen.findByLabelText("Name", {
      selector: "input",
    });
    expect((nameInput as HTMLInputElement).value).toBe("Alice");
    fireEvent.change(nameInput, { target: { value: "Alice 2" } });
    fireEvent.blur(nameInput);

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/agents/update",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mockedApi.mock.calls.find(
      (c) => c[0] === "/v1/workspace/org/agents/update",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ sync_id: "agent-alice", name: "Alice 2" });
  });

  it("增加一档执行目标：只能从已有后端里挑，写的是 backend_sync_id 引用", async () => {
    renderOrg();
    await selectAlice();
    await screen.findByLabelText("Name", { selector: "input" });

    fireEvent.keyDown(
      screen.getByRole("button", { name: "Add execution target" }),
      {
        key: "Enter",
      },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /Codex/i }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/exec-targets",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mockedApi.mock.calls.find(
      (c) => c[0] === "/v1/workspace/org/exec-targets",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({
      agent_sync_id: "agent-alice",
      backend_sync_id: "backend-2",
    });
  });

  it("移除一档执行目标", async () => {
    renderOrg();
    await selectAlice();

    // 「移除」按钮是共享包 OrgExecTargetRow 自带的（文案来自包自己的 agentreUi
    // 命名空间，见 packages/agentre-ui/src/i18n/locales/en.json 的
    // org.agent.execTargets.remove = "Remove"），宿主不重造一个。
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/exec-targets/delete",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ sync_id: "et-1" }),
        }),
      ),
    );
  });
});

// 规格「详情」的两条逐档规则，与桌面端同一条判据：
// 「不支持技能的一档不给展开入口，而不是展开后给一句空话」，以及
// 「离线的一档仍可展开：已授权的技能列得出来也移除得掉，只是加不了新的」。
describe("执行目标一档一行：展开入口与离线档的可为", () => {
  function mockTwoTierChart() {
    const twoTier: OrgChartResponse = {
      ...chart,
      agents: chart.agents.map((a) =>
        a.sync_id === "agent-alice"
          ? {
              ...a,
              exec_targets: [
                {
                  sync_id: "et-builtin",
                  rank: 1,
                  backend_sync_id: "backend-3",
                  backend_name: "Built-in",
                  backend_type: "builtin",
                  is_local_reference: false,
                  availability: "available",
                  current: true,
                },
                {
                  sync_id: "et-offline",
                  rank: 2,
                  backend_sync_id: "backend-2",
                  backend_name: "Codex",
                  backend_type: "codex",
                  is_local_reference: false,
                  availability: "offline",
                  current: false,
                  skills_json: JSON.stringify([
                    { id: "skill-1", enabled: true },
                  ]),
                },
                {
                  sync_id: "et-piagent",
                  rank: 3,
                  backend_sync_id: "backend-4",
                  backend_name: "Pi Agent",
                  backend_type: "piagent",
                  is_local_reference: false,
                  availability: "available",
                  current: false,
                },
              ],
            }
          : a,
      ),
    };
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/workspace/org" && (!init || init.method === undefined))
        return twoTier;
      if (path === "/v1/workspace/org/backends") return { backends };
      if (init?.method === "POST") return { sync_id: "new", version: 1 };
      throw new Error(`unexpected request: ${path}`);
    });
  }

  it("不支持技能的一档不给展开入口", async () => {
    mockTwoTierChart();
    renderOrg();
    await selectAlice();

    const builtinRow = await screen.findByTestId("exec-target-row-0");
    expect(
      within(builtinRow).queryByRole("button", { name: /Skills/i }),
    ).toBeNull();
    // 支持的那一档照常有
    const codexRow = screen.getByTestId("exec-target-row-1");
    expect(
      within(codexRow).getByRole("button", { name: /Skills/i }),
    ).toBeTruthy();
  });

  // 「不支持技能」的判据是 runtime 声不声明 CapSkills，不是「是不是 builtin」。
  // 桌面端问的是 Go 侧的能力矩阵（GetBackendCapabilities），浏览器这一侧本轮没有
  // 这个端点，只能钉一张表 —— 那张表必须是**声明了的那三种**的白名单：
  // claudecode / codex / remote 声明，builtin / openclaw / piagent / fake 都没有
  // （agentre 的 internal/pkg/agentruntime/runtimes/*/runtime.go）。写成「排除 builtin」
  // 的黑名单，piagent 与 openclaw 就会拿到一个展开入口，展开后正是规格不要的那句空话。
  it("不支持技能的判据是能力矩阵而不是「非 builtin」：piagent 一档同样没有展开入口", async () => {
    mockTwoTierChart();
    renderOrg();
    await selectAlice();

    const piagentRow = await screen.findByTestId("exec-target-row-2");
    expect(within(piagentRow).getByText(/Pi Agent/)).toBeTruthy();
    expect(
      within(piagentRow).queryByRole("button", { name: /Skills/i }),
    ).toBeNull();
  });

  it("离线的一档仍可展开：已授权的技能移除得掉，但加不了新的", async () => {
    mockTwoTierChart();
    renderOrg();
    await selectAlice();

    const codexRow = await screen.findByTestId("exec-target-row-1");
    fireEvent.click(within(codexRow).getByRole("button", { name: /Skills/i }));

    expect(within(codexRow).getByText("skill-1")).toBeTruthy();
    expect(
      within(codexRow).getByRole("button", { name: "Revoke skill-1" }),
    ).not.toHaveProperty("disabled", true);
    // 手打 skill id 已经换成目录：离线时不拨号、没有 Grant 入口，只给一句离线说明。
    expect(
      within(codexRow).queryByRole("button", { name: "Grant" }),
    ).toBeNull();
    expect(within(codexRow).queryByLabelText("Skill id")).toBeNull();
    expect(within(codexRow).getByText(/machine is offline/i)).toBeTruthy();
  });
});

describe("后端可被选用但不可新建也不可编辑（R19）", () => {
  it("整个页面没有任何新建/编辑后端的入口", async () => {
    renderOrg();
    await selectAlice();
    await screen.findByLabelText("Name", { selector: "input" });
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Add execution target" }),
      {
        key: "Enter",
      },
    );
    await screen.findByRole("menuitem", { name: /Codex/i });

    expect(screen.queryByRole("button", { name: /new backend/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add backend/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /create backend/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /edit backend/i })).toBeNull();
    expect(screen.queryByText(/cli_path/i)).toBeNull();
    expect(screen.queryByText(/env_json/i)).toBeNull();
  });
});

describe("通道整个关掉时组织面仍然正确（规格「账号级实时通道」头条验收）", () => {
  it("startAccountChannel 抛出也不妨碍索引照常渲染与可操作", async () => {
    mockedStartChannel.mockImplementation(() => {
      throw new Error("channel unavailable");
    });
    renderOrg();
    await screen.findByText("Alice");
    await screen.findByText("Empty Dept");
  });
});

describe("第 5 个导航项打开这个页面", () => {
  it("页面标题落在 AppShell 的 title 槽", async () => {
    renderOrg();
    await waitFor(() =>
      expect(
        within(screen.getByRole("banner")).getByText("Organization"),
      ).toBeTruthy(),
    );
  });
});

/**
 * 详情主区与 mockup（`.dev-kit/artifacts/2026-08-18-org-index-convergence/mockups/`
 * 的 `01-index-detail` / `06-detail-states` / `09-empty`）的四处偏差，逐条钉住。
 *
 * 头部那条「已保存」不是装饰：这一份表单是 onBlur 静默提交的，改完一个字段
 * 若没有任何反馈，用户无从知道到底落库没有——失败时尤其。
 */
describe("详情头部：谁在编辑、改动落没落库（mockup 的 mhead）", () => {
  /** dept-eng 的负责人改成 Alice：徽标只画真实算得出来的那一维。 */
  function mockLeadChart() {
    const led: OrgChartResponse = {
      ...chart,
      departments: chart.departments.map((d) =>
        d.sync_id === "dept-eng"
          ? { ...d, lead_agent_sync_id: "agent-alice" }
          : d,
      ),
    };
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/workspace/org" && (!init || init.method === undefined))
        return led;
      if (path === "/v1/workspace/org/backends") return { backends };
      if (init?.method === "POST") return { sync_id: "new", version: 1 };
      throw new Error(`unexpected request: ${path}`);
    });
  }

  it("头部带头像、名字与真实角色徽标：是某部门负责人就标「部门长」，并标出所属部门", async () => {
    mockLeadChart();
    renderOrg();
    await selectAlice();

    const header = await screen.findByTestId("org-detail-header");
    expect(within(header).getByText("Alice")).toBeTruthy();
    expect(within(header).getByTestId("org-detail-avatar")).toBeTruthy();
    expect(within(header).getByText("Department lead")).toBeTruthy();
    expect(within(header).getByText("Engineering")).toBeTruthy();
  });

  it("不是负责人就不画「部门长」——徽标只画算得出来的那一维", async () => {
    renderOrg();
    await selectAlice();

    const header = await screen.findByTestId("org-detail-header");
    expect(within(header).queryByText("Department lead")).toBeNull();
  });

  it("onBlur 静默提交要有反馈：保存中 → 已保存 · 刚刚", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/workspace/org" && (!init || init.method === undefined))
        return chart;
      if (path === "/v1/workspace/org/backends") return { backends };
      if (path === "/v1/workspace/org/agents/update") {
        await gate;
        return { sync_id: "agent-alice", version: 2 };
      }
      if (init?.method === "POST") return { sync_id: "new", version: 1 };
      throw new Error(`unexpected request: ${path}`);
    });

    renderOrg();
    await selectAlice();
    const nameInput = await screen.findByLabelText("Name", {
      selector: "input",
    });
    fireEvent.change(nameInput, { target: { value: "Alice 2" } });
    fireEvent.blur(nameInput);

    const status = await screen.findByTestId("org-detail-save-status");
    await waitFor(() => expect(status.textContent).toContain("Saving"));

    release();
    await waitFor(() =>
      expect(
        screen.getByTestId("org-detail-save-status").textContent,
      ).toContain("Saved · just now"),
    );
  });

  it("保存失败就地报出服务端给的真实原因，并给一个重试", async () => {
    let fail = true;
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/workspace/org" && (!init || init.method === undefined))
        return chart;
      if (path === "/v1/workspace/org/backends") return { backends };
      if (path === "/v1/workspace/org/agents/update") {
        if (fail) throw new ApiError(1001, "name already taken", 400);
        return { sync_id: "agent-alice", version: 2 };
      }
      if (init?.method === "POST") return { sync_id: "new", version: 1 };
      throw new Error(`unexpected request: ${path}`);
    });

    renderOrg();
    await selectAlice();
    const nameInput = await screen.findByLabelText("Name", {
      selector: "input",
    });
    fireEvent.change(nameInput, { target: { value: "Alice 2" } });
    fireEvent.blur(nameInput);

    const status = await screen.findByTestId("org-detail-save-status");
    await waitFor(() => expect(status.textContent).toContain("Save failed"));
    expect(screen.getByText("name already taken")).toBeTruthy();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.getByTestId("org-detail-save-status").textContent,
      ).toContain("Saved · just now"),
    );
  });

  it("删除收进 ⋮ 溢出菜单：不再常驻版面，但仍然找得到", async () => {
    renderOrg();
    await selectAlice();
    await screen.findByLabelText("Name", { selector: "input" });

    const header = screen.getByTestId("org-detail-header");
    expect(within(header).queryByRole("button", { name: "Delete" })).toBeNull();

    // Radix 的菜单开在 pointerdown 上，不是 click。
    fireEvent.pointerDown(
      within(header).getByRole("button", { name: "More actions" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/agents/delete",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ sync_id: "agent-alice" }),
        }),
      ),
    );
  });

  it("系统 Agent 禁删：连一个禁用的删除控件都不画", async () => {
    renderOrg();
    const ceo = await screen.findByText("CEO Agent");
    const row = ceo.closest('[data-slot="org-index-row"]') as HTMLElement;
    fireEvent.click(within(row).getByTestId(/^org-row-select-/));

    const header = await screen.findByTestId("org-detail-header");
    expect(within(header).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(
      within(header).queryByRole("button", { name: "More actions" }),
    ).toBeNull();
  });
});

// mockup README 点名的第 3 处：「系统提示词挤在 150px 的框里 —— 它是这一屏最常改
// 的字段。加高到 232px，并给一个『展开编辑』入口」。
describe("系统提示词：字数 + 展开编辑", () => {
  it("区头写出字数，编辑框加高到 232px", async () => {
    renderOrg();
    await selectAlice();

    const textarea = await screen.findByLabelText("System prompt", {
      selector: "textarea",
    });
    expect(textarea.className).toContain("min-h-[232px]");
    // "You are Alice" = 13 字
    expect(screen.getByTestId("org-prompt-count").textContent).toContain("13");
  });

  it("展开编辑：弹层里改完保存，提交的仍然只有 prompt_json 这一个字段", async () => {
    renderOrg();
    await selectAlice();

    fireEvent.click(
      await screen.findByRole("button", { name: "Expand editor" }),
    );
    const dialog = await screen.findByRole("dialog");
    const big = within(dialog).getByLabelText("System prompt", {
      selector: "textarea",
    });
    expect((big as HTMLTextAreaElement).value).toBe("You are Alice");
    fireEvent.change(big, { target: { value: "You are Alice v2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/agents/update",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mockedApi.mock.calls.find(
      (c) => c[0] === "/v1/workspace/org/agents/update",
    )!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      sync_id: "agent-alice",
      prompt_json: JSON.stringify(["You are Alice v2"]),
    });
  });
});

// 服务端的浏览器通道**没有**承载头像图片的字段：读端点 OrgAgentItem 只有
// avatar_color / avatar_icon，写端点 AgentFields 亦然（org.go 注释写明「头像正文也
// 不在」）。/v1/sync/avatars 有，但挂在 device JWT 组上、且组织读端点不带内容哈希，
// 浏览器既传不上去也显示不出来。所以这里不画「上传图片」，改成从图标里挑。
describe("头像：不伪造上传，改成图标选择器", () => {
  it("没有让用户手打字符串的图标 key 输入框", async () => {
    renderOrg();
    await selectAlice();
    await screen.findByLabelText("Name", { selector: "input" });

    expect(
      screen.queryByLabelText("Icon key", { selector: "input" }),
    ).toBeNull();
  });

  it("整页没有「上传图片」这种服务端接不住的动作", async () => {
    renderOrg();
    await selectAlice();
    await screen.findByLabelText("Name", { selector: "input" });

    expect(screen.queryByRole("button", { name: /upload/i })).toBeNull();
    expect(screen.queryByText(/upload/i)).toBeNull();
  });

  it("挑一个图标只提交 avatar_icon 这一个字段", async () => {
    renderOrg();
    await selectAlice();
    await screen.findByLabelText("Name", { selector: "input" });

    fireEvent.click(screen.getByRole("radio", { name: "Terminal" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/agents/update",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mockedApi.mock.calls.find(
      (c) => c[0] === "/v1/workspace/org/agents/update",
    )!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      sync_id: "agent-alice",
      avatar_icon: "terminal",
    });
  });
});

describe("未选中时的详情区是带出路的空态（09-empty ①）", () => {
  it("图标 + 标题 + 正文 + 真实可达的两个动作", async () => {
    renderOrg();
    await screen.findByText("Alice");

    const empty = screen.getByTestId("org-detail-empty");
    expect(within(empty).getByTestId("empty-icon")).toBeTruthy();
    expect(within(empty).getByText("Nothing selected")).toBeTruthy();
    expect(
      within(empty).getByRole("button", { name: "New department" }),
    ).toBeTruthy();
    expect(
      within(empty).getByRole("button", { name: "New agent" }),
    ).toBeTruthy();
  });

  it("空态里的「新建部门」真的开建部门弹层，不是装饰", async () => {
    renderOrg();
    await screen.findByText("Alice");

    const empty = screen.getByTestId("org-detail-empty");
    fireEvent.click(
      within(empty).getByRole("button", { name: "New department" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New department")).toBeTruthy();
  });
});
