import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { api, ApiTimeoutError } from "@/lib/api";
import { createProject, projectRoster } from "@/lib/projects";
import { createProjectCreatePorts } from "@/lib/projectPorts";
import { createProjectFsPort } from "@/lib/projectFsPort";
import { useProjectManagement } from "@/pages/chat/useProjectManagement";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
const mockedApi = vi.mocked(api);

const wire = (id: string, name: string, parent = "") => ({
  sync_id: id,
  name,
  parent_sync_id: parent,
});

let server: ReturnType<typeof wire>[];
let readsFail = false;
let postCount = 0;

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  projectRoster.invalidate();
  server = [wire("old-x", "X")];
  readsFail = false;
  postCount = 0;
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      postCount += 1;
      throw new ApiTimeoutError(path, 15000);
    }
    if (path === "/v1/workspace/projects") {
      if (readsFail) throw new TypeError("Failed to fetch");
      return { projects: server };
    }
    throw new Error(`unexpected ${path}`);
  });
});

const listReads = () =>
  mockedApi.mock.calls.filter(
    ([p, init]) => p === "/v1/workspace/projects" && !init?.method,
  ).length;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("新建项目超时（F5、W13）", () => {
  it("POST 等「提交前」基线答完才发：基线读不与 POST 并发（并发的读可能晚于落库）", async () => {
    const order: string[] = [];
    let answer: (v: unknown) => void = () => {};
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      order.push(init?.method ?? "GET");
      if (init?.method === "POST") throw new ApiTimeoutError(path, 15000);
      return new Promise((resolve) => (answer = resolve));
    });
    const ports = createProjectCreatePorts(createProjectFsPort());
    const pending = ports.create({ name: "X" } as never);
    await flush();
    expect(order).toEqual(["GET"]);
    answer({ projects: server });
    await pending;
    expect(order).toEqual(["GET", "POST"]);
  });

  it("打开弹窗时就取基线（prepareCreate）：提交时共用那一次，不另发读", async () => {
    const ports = createProjectCreatePorts(createProjectFsPort());
    ports.prepareCreate();
    expect(listReads()).toBe(1);
    await ports.create({ name: "X" } as never);
    expect(listReads()).toBe(1);
    expect(postCount).toBe(1);
  });

  it("超时后不自动重读：只抛出超时，读留给「刷新看看」", async () => {
    await projectRoster.get(); // 提交前名单里只有 old-x
    server.push(wire("made-x", "X"));
    const before = listReads();
    await expect(createProject({ name: "X" })).rejects.toThrow(/timed out/);
    expect(listReads()).toBe(before);
    expect(postCount).toBe(1);
  });

  it("端口失败带超时标记（包据此换成「刷新看看」），不自带中文也不自动认", async () => {
    await projectRoster.get();
    const ports = createProjectCreatePorts(createProjectFsPort());
    const out = await ports.create({ name: "X" } as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // 包认超时的规则：消息里有 timed out（它自己说那句中文，这段不上屏）。
    expect(out.failure.message).toMatch(/timed?[ -]?out/i);
  });

  it("刷新看看：认出新的同名项目就返回它的标识，旧的同名不会被认错", async () => {
    await projectRoster.get();
    const ports = createProjectCreatePorts(createProjectFsPort());
    await ports.create({ name: "X" } as never);
    // 还没建好：只有旧的同名项目。
    expect(await ports.recheckCreate({ name: "X" } as never)).toBeNull();
    server.push(wire("made-x", "X"));
    expect(await ports.recheckCreate({ name: "X" } as never)).toBe("made-x");
    expect(postCount).toBe(1);
  });

  it("刷新看看读失败：不当作没建（抛出，包按「没找到」处理但不会替用户再发 POST）", async () => {
    await projectRoster.get();
    const ports = createProjectCreatePorts(createProjectFsPort());
    await ports.create({ name: "X" } as never);
    readsFail = true;
    await expect(ports.recheckCreate({ name: "X" } as never)).rejects.toThrow();
    expect(postCount).toBe(1);
  });

  it("刷新看看在有基线时也必须真去读：读失败就拒绝，不放开再提交", async () => {
    await projectRoster.get();
    const ports = createProjectCreatePorts(createProjectFsPort());
    await ports.create({ name: "X" } as never);
    readsFail = true;
    const before = listReads();
    await expect(ports.recheckCreate({ name: "X" } as never)).rejects.toThrow();
    expect(listReads()).toBe(before + 1);
  });

  describe("提交前的基线没取到（那次读失败）", () => {
    async function timedOutWithoutBaseline() {
      readsFail = true; // 提交前那次读失败：没有基线
      const ports = createProjectCreatePorts(createProjectFsPort());
      await ports.create({ name: "X", parentId: "p1" } as never);
      expect(postCount).toBe(1);
      readsFail = false;
      return ports;
    }

    it("刷新看看必须现读一次，不能不发请求就说「没找到」", async () => {
      const ports = await timedOutWithoutBaseline();
      const before = listReads();
      await ports.recheckCreate({ name: "X", parentId: "p1" } as never);
      expect(listReads()).toBe(before + 1);
    });

    it("现读失败：拒绝（包说「刷新没成功」、不放开再提交）", async () => {
      const ports = await timedOutWithoutBaseline();
      readsFail = true;
      await expect(
        ports.recheckCreate({ name: "X", parentId: "p1" } as never),
      ).rejects.toThrow();
    });

    it("现读里有同名同上级的项目：算找到，返回它的标识", async () => {
      const ports = await timedOutWithoutBaseline();
      server.push(wire("made-x", "X", "p1"));
      await expect(
        ports.recheckCreate({ name: "X", parentId: "p1" } as never),
      ).resolves.toBe("made-x");
    });

    it("现读成功但没有同名同上级的（同名不同上级不算）：才是没找到", async () => {
      const ports = await timedOutWithoutBaseline();
      server.push(wire("other-x", "X", "p2"));
      await expect(
        ports.recheckCreate({ name: "X", parentId: "p1" } as never),
      ).resolves.toBeNull();
      expect(postCount).toBe(1);
    });
  });
});

describe("新建弹窗的每个入口都在打开时取基线", () => {
  function mount() {
    return renderHook(() =>
      useProjectManagement({
        projects: [
          {
            syncId: "p1",
            name: "P",
            icon: "",
            color: "",
            description: "",
            parentSyncId: "",
            sortOrder: 0,
            configured: true,
            members: [],
          },
        ],
        agents: [],
        newConvProjects: [],
        reloadProjects: () => {},
        onNewChat: () => {},
      }),
    );
  }

  it("「新建项目」（顶层）", () => {
    const { result } = mount();
    expect(listReads()).toBe(0);
    act(() => result.current.openCreate());
    expect(listReads()).toBe(1);
  });

  it("组头的「新建子项目」", () => {
    const { result } = mount();
    act(() => result.current.handlers("p1")!.onNewSubproject("p1"));
    expect(listReads()).toBe(1);
  });
});
