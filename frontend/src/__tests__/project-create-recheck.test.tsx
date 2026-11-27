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
let readsFail = false;
const created = vi.fn();

beforeEach(async () => {
  await i18n.changeLanguage("en");
  projectRoster.invalidate();
  server = [wire("old-x", "X")];
  posts = 0;
  readsFail = false;
  created.mockReset();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      throw new ApiTimeoutError(path, 15000);
    }
    if (path === "/v1/workspace/projects") {
      if (readsFail) throw new ApiTimeoutError(path, 15000);
      return { projects: server };
    }
    if (path === "/v1/devices") return { devices: [] };
    throw new Error(`unexpected ${path}`);
  });
});

async function submitTimedOut({ baseline = true } = {}) {
  if (baseline) await projectRoster.get();
  else readsFail = true; // 提交前那次读也超时了：没有基线
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
  const line = await screen.findByTestId("project-create-timeout");
  readsFail = false;
  return line;
}

const reads = () =>
  mockedApi.mock.calls.filter(
    ([p, i]) => p === "/v1/workspace/projects" && !i?.method,
  ).length;

describe("新建项目超时", () => {
  it("一行提示 + 「刷新看看」，不露英文原文，不自动重读", async () => {
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

  describe("提交前的基线没取到", () => {
    it("刷新看看现读一次，服务端其实建好了就打开它", async () => {
      await submitTimedOut({ baseline: false });
      server.push(wire("made-x", "X"));
      const before = reads();
      fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
      await waitFor(() => expect(created).toHaveBeenCalledWith("made-x"));
      expect(reads()).toBe(before + 1);
      expect(posts).toBe(1);
    });

    it("刷新看看那次读也失败：说没刷新成，再点创建不会再发 POST", async () => {
      await submitTimedOut({ baseline: false });
      readsFail = true;
      fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
      await waitFor(() =>
        expect(
          screen.getByTestId("project-create-timeout").textContent,
        ).toMatch(/couldn't refresh/i),
      );
      expect(screen.queryByText(/not found yet/i)).toBeNull();
      fireEvent.click(screen.getByTestId("project-create-submit"));
      await waitFor(() => expect(reads()).toBeGreaterThan(2));
      expect(posts).toBe(1);
    });
  });
});
