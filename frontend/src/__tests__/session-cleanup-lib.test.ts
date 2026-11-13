import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { api } from "@/lib/api";
import { executeCleanup, previewCleanup } from "@/lib/sessionCleanup";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
const mockedApi = vi.mocked(api);

const NOW = new Date(2026, 10, 13, 12).getTime();
const DAY = 86_400_000;

function body(call: number) {
  return JSON.parse(mockedApi.mock.calls[call][1]!.body as string);
}

describe("previewCleanup", () => {
  beforeEach(() => {
    mockedApi.mockReset();
    mockedApi.mockResolvedValue({
      count: 2,
      retained: 1,
      machines: [
        { fingerprint: "fp1", name: "build-box", online: true, count: 2 },
        { fingerprint: "fp2", name: "old", online: false, count: 1 },
      ],
      conversation_ids: ["c1", "c2"],
    });
  });

  it("时间档换成截止毫秒，all 的 agent/project 送空串", async () => {
    const view = await previewCleanup(
      { before: "30d", agentId: "all", projectId: "all" },
      NOW,
    );
    expect(mockedApi.mock.calls[0][0]).toBe(
      "/v1/saved-sessions/cleanup/preview",
    );
    expect(mockedApi.mock.calls[0][1]!.method).toBe("POST");
    expect(body(0)).toEqual({
      before_ms: NOW - 30 * DAY,
      agent_sync_id: "",
      project_sync_id: "",
    });
    expect(view.cutoffDate).toBe(NOW - 30 * DAY);
  });

  it("all 时间档 before_ms=0、cutoffDate=null；具体 agent/project 原样送", async () => {
    const view = await previewCleanup(
      { before: "all", agentId: "a1", projectId: "p1" },
      NOW,
    );
    expect(body(0)).toEqual({
      before_ms: 0,
      agent_sync_id: "a1",
      project_sync_id: "p1",
    });
    expect(view.cutoffDate).toBeNull();
  });

  it("90d / 180d 的偏移", async () => {
    await previewCleanup(
      { before: "90d", agentId: "all", projectId: "all" },
      NOW,
    );
    await previewCleanup(
      { before: "180d", agentId: "all", projectId: "all" },
      NOW,
    );
    expect(body(0).before_ms).toBe(NOW - 90 * DAY);
    expect(body(1).before_ms).toBe(NOW - 180 * DAY);
  });

  it("响应映射成视图：只列涉及的机器（带 online），ids 来自 conversation_ids", async () => {
    const view = await previewCleanup(
      { before: "90d", agentId: "all", projectId: "all" },
      NOW,
    );
    expect(view.count).toBe(2);
    expect(view.retained).toBe(1);
    expect(view.ids).toEqual(["c1", "c2"]);
    expect(view.copies).toEqual([
      { kind: "machine", label: "build-box", online: true, count: 2 },
      { kind: "machine", label: "old", online: false, count: 1 },
    ]);
  });

  it("缺席的 machines / conversation_ids 当空", async () => {
    mockedApi.mockResolvedValue({ count: 0, retained: 0 });
    const view = await previewCleanup(
      { before: "90d", agentId: "all", projectId: "all" },
      NOW,
    );
    expect(view.ids).toEqual([]);
    expect(view.copies).toEqual([]);
  });
});

describe("executeCleanup", () => {
  beforeEach(async () => {
    mockedApi.mockReset();
    await i18n.changeLanguage("zh-CN");
  });

  it("送 conversation_ids，映射 deleted / pending / failed（原因本地化，不露原码）", async () => {
    mockedApi.mockResolvedValue({
      deleted: 2,
      retained: 0,
      failed: [
        { conversation_id: "c1", reason: "machine_protocol_violation" },
        { conversation_id: "c2", reason: "delete_failed" },
        { conversation_id: "c3", reason: "something_new" },
      ],
      pending: [{ fingerprint: "fp2", name: "old", count: 3 }],
    });
    const view = await executeCleanup(["c1", "c2", "c3"]);
    expect(mockedApi.mock.calls[0][0]).toBe("/v1/saved-sessions/cleanup");
    expect(mockedApi.mock.calls[0][1]!.method).toBe("POST");
    expect(body(0)).toEqual({ conversation_ids: ["c1", "c2", "c3"] });
    expect(view.deleted).toBe(2);
    expect(view.pending).toEqual([{ label: "old", count: 3 }]);
    expect(view.failed.map((f) => f.id)).toEqual(["c1", "c2", "c3"]);
    for (const f of view.failed) {
      expect(f.reason).not.toMatch(
        /machine_protocol_violation|delete_failed|something_new/,
      );
      expect(f.reason).toMatch(/[一-鿿]/);
    }
  });

  it("缺席的 failed / pending 当空", async () => {
    mockedApi.mockResolvedValue({ deleted: 1, retained: 0 });
    const view = await executeCleanup(["c1"]);
    expect(view).toEqual({ deleted: 1, failed: [], pending: [] });
  });

  // 服务端一次最多收 5000 条（binding max=5000），预览却不设上限：分批送，结果合并，
  // 同一台机器的待删跨批次累加。
  it("超过单批上限：分批送、每批不超过服务端上限，结果合并", async () => {
    const ids = Array.from({ length: 6001 }, (_, i) => `c${i}`);
    mockedApi.mockImplementation(async (_path, init) => {
      const sent = JSON.parse(init!.body as string).conversation_ids;
      return {
        deleted: sent.length,
        retained: 0,
        pending: [{ fingerprint: "fp2", name: "old", count: 1 }],
      };
    });
    const view = await executeCleanup(ids);
    const sent = mockedApi.mock.calls.map(
      (_, i) => body(i).conversation_ids as string[],
    );
    expect(sent.length).toBeGreaterThan(1);
    for (const batch of sent) expect(batch.length).toBeLessThanOrEqual(5000);
    expect(sent.flat()).toEqual(ids);
    expect(view.deleted).toBe(6001);
    expect(view.pending).toEqual([{ label: "old", count: sent.length }]);
  });

  it("后面某一批整个失败：已删的照报，没送成的那些列为失败可重试", async () => {
    const ids = Array.from({ length: 6001 }, (_, i) => `c${i}`);
    let call = 0;
    mockedApi.mockImplementation(async (_path, init) => {
      call++;
      if (call > 1) throw new Error("net");
      const sent = JSON.parse(init!.body as string).conversation_ids;
      return { deleted: sent.length, retained: 0 };
    });
    const view = await executeCleanup(ids);
    const firstBatch = body(0).conversation_ids as string[];
    expect(view.deleted).toBe(firstBatch.length);
    expect(view.failed.map((f) => f.id)).toEqual(ids.slice(firstBatch.length));
    expect(view.failed[0].reason).toMatch(/[一-鿿]/);
  });

  it("第一批就失败：整个报错，交给确认框的重试", async () => {
    mockedApi.mockRejectedValue(new Error("net"));
    await expect(executeCleanup(["c1"])).rejects.toThrow("net");
  });
});
