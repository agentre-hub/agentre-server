import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { api, ApiTimeoutError } from "@/lib/api";
import { createProject, projectRoster } from "@/lib/projects";
import { createProjectCreatePorts } from "@/lib/projectPorts";
import { createProjectFsPort } from "@/lib/projectFsPort";

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

describe("新建项目超时（F5、W13）", () => {
  it("POST 不等任何读：基线与 POST 同时发出", async () => {
    const order: string[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      order.push(init?.method ?? "GET");
      if (init?.method === "POST") throw new ApiTimeoutError(path, 15000);
      return new Promise(() => {}); // 读永不返回
    });
    void createProject({ name: "X" }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain("POST");
  });

  it("超时后不自动重读：只抛出超时，读留给「刷新看看」", async () => {
    await projectRoster.get(); // 提交前名单里只有 old-x
    server.push(wire("made-x", "X"));
    const listReads = () =>
      mockedApi.mock.calls.filter(([p, init]) => !init?.method && p).length;
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
});
