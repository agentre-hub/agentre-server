import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { SessionCleanupPanel } from "@/components/settings/SessionCleanupPanel";
import i18n from "@/i18n";
import { api } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const mockedApi = vi.mocked(api);

function route(over: Record<string, unknown> = {}) {
  mockedApi.mockImplementation(async (path: string) => {
    if (path in over) {
      const v = over[path];
      if (v instanceof Error) throw v;
      return v as never;
    }
    switch (path) {
      case "/v1/workspace/agents":
        return { agents: [{ sync_id: "a1", name: "Claude Code" }] } as never;
      case "/v1/workspace/projects":
        return { projects: [{ sync_id: "p1", name: "agentre" }] } as never;
      case "/v1/saved-sessions/cleanup/preview":
        return {
          count: 2,
          retained: 0,
          machines: [
            { fingerprint: "fp2", name: "old-box", online: false, count: 2 },
          ],
          conversation_ids: ["c1", "c2"],
        } as never;
      case "/v1/saved-sessions/cleanup":
        return {
          deleted: 2,
          retained: 0,
          failed: [],
          pending: [{ fingerprint: "fp2", name: "old-box", count: 2 }],
        } as never;
    }
    throw new Error("unexpected " + path);
  });
}

describe("SessionCleanupPanel", () => {
  beforeEach(async () => {
    mockedApi.mockReset();
    vi.mocked(toast.success).mockReset();
    await i18n.changeLanguage("zh-CN");
  });

  it("用控制台已有的 agent / 项目端点填筛选项，进来就按默认条件预览", async () => {
    route();
    render(<SessionCleanupPanel />);
    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/saved-sessions/cleanup/preview",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(mockedApi).toHaveBeenCalledWith("/v1/workspace/agents");
    expect(mockedApi).toHaveBeenCalledWith("/v1/workspace/projects");
    expect(
      await screen.findByRole("button", { name: /清理 2 个对话/ }),
    ).toBeTruthy();
  });

  it("确认执行后：只送预览那批 id，toast 报删除数与离线机器待办", async () => {
    route();
    render(<SessionCleanupPanel />);
    const clean = await screen.findByRole("button", { name: /清理 2 个对话/ });
    await waitFor(() =>
      expect((clean as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(clean);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /删除 2 个/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const exec = mockedApi.mock.calls.find(
      (c) => c[0] === "/v1/saved-sessions/cleanup",
    )!;
    expect(JSON.parse(exec[1]!.body as string)).toEqual({
      conversation_ids: ["c1", "c2"],
    });
    const message = String(vi.mocked(toast.success).mock.calls[0][0]);
    expect(message).toContain("已删除 2 个对话");
    expect(message).toContain("old-box");
  });

  it("agent / 项目列表取不到时仍渲染（只剩「全部」）", async () => {
    route({
      "/v1/workspace/agents": new Error("boom"),
      "/v1/workspace/projects": new Error("boom"),
    });
    render(<SessionCleanupPanel />);
    expect(
      await screen.findByRole("button", { name: /清理 2 个对话/ }),
    ).toBeTruthy();
  });
});
