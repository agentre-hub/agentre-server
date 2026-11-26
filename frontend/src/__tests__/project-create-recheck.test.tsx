/**
 * 新建项目超时（规格 2026-11-25 F5）：不自动重读，错误行是「网络超时，可能已经建好了」+
 * 「刷新看看」；按钮重读，认出就打开它（onCreated），没认出放开再提交；不露英文原文。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import i18n from "@/i18n";
import { api, ApiTimeoutError } from "@/lib/api";
import { createProjectCreatePorts } from "@/lib/projectPorts";
import { createProjectFsPort } from "@/lib/projectFsPort";
import { projectRoster } from "@/lib/projects";
import { ProjectDialogs } from "@/pages/chat/ProjectDialogs";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
const mockedApi = vi.mocked(api);

const wire = (id: string, name: string) => ({
  sync_id: id,
  name,
  parent_sync_id: "",
});
let server: ReturnType<typeof wire>[];
let posts = 0;
const created = vi.fn();

beforeEach(async () => {
  await i18n.changeLanguage("en");
  projectRoster.invalidate();
  server = [wire("old-x", "X")];
  posts = 0;
  created.mockReset();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      throw new ApiTimeoutError(path, 15000);
    }
    if (path === "/v1/workspace/projects") return { projects: server };
    if (path === "/v1/devices") return { devices: [] };
    throw new Error(`unexpected ${path}`);
  });
});

async function submitTimedOut() {
  await projectRoster.get();
  const ports = createProjectCreatePorts(createProjectFsPort());
  render(
    <MemoryRouter>
      <ProjectDialogs
        create={{
          parent: null,
          parentOptions: [],
          ports,
          onTimeoutRecheck: ports.recheckCreate,
          close: () => {},
          onCreated: created,
        }}
        settings={{
          project: null,
          parentOptions: [],
          ports: {} as never,
          close: () => {},
          onChanged: () => {},
        }}
        deletion={{
          project: null,
          childCount: 0,
          offlineMachines: [],
          ports: {} as never,
          close: () => {},
          onDeleted: () => {},
        }}
      />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
  const name = await screen.findByPlaceholderText(/name/i);
  fireEvent.change(name, { target: { value: "X" } });
  fireEvent.click(screen.getByTestId("project-create-submit"));
  return screen.findByTestId("project-create-timeout");
}

describe("新建项目超时", () => {
  it("一行提示 + 「刷新看看」，不露英文原文，不自动重读", async () => {
    const reads = () =>
      mockedApi.mock.calls.filter(
        ([p, i]) => p === "/v1/workspace/projects" && !i?.method,
      ).length;
    const line = await submitTimedOut();
    expect(line.textContent).not.toMatch(/timed out after|\/v1\//i);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
    expect(created).not.toHaveBeenCalled();
    expect(reads()).toBe(1); // 只有提交前那次基线
  });

  it("刷新看看：服务端其实建好了，就打开它", async () => {
    await submitTimedOut();
    server.push(wire("made-x", "X"));
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(created).toHaveBeenCalledWith("made-x"));
    expect(posts).toBe(1);
  });

  it("刷新看看：没找到，说一句并允许再提交", async () => {
    await submitTimedOut();
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("project-create-timeout")).toBeNull(),
    );
    expect(created).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).not.toMatch(/timed out/i);
    fireEvent.click(screen.getByTestId("project-create-submit"));
    await waitFor(() => expect(posts).toBe(2));
  });
});
