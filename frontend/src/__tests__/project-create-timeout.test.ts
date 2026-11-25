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

  it("超时后重读，认出新的同名项目就当作建成（返回它的标识），旧的同名不会被认错", async () => {
    await projectRoster.get(); // 提交前名单里只有 old-x
    server.push(wire("made-x", "X"));
    const res = await createProject({ name: "X" });
    expect(res.sync_id).toBe("made-x");
    expect(postCount).toBe(1);
  });

  it("认不出：经端口说一句中文「没找到、可以再提交」，不含英文原文", async () => {
    await projectRoster.get();
    const ports = createProjectCreatePorts(createProjectFsPort());
    const out = await ports.create({ name: "X" } as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.message).toContain("网络超时");
    expect(out.failure.message).toContain("重新提交");
    expect(out.failure.message).not.toMatch(/timed out after/);
  });

  it("重读也失败：说「可能已经建好了」，请先去列表看看", async () => {
    await projectRoster.get();
    readsFail = true;
    const ports = createProjectCreatePorts(createProjectFsPort());
    const out = await ports.create({ name: "X" } as never);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.message).toContain("可能已经建好了");
  });
});
