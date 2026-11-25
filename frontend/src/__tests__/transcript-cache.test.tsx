/**
 * 对话内容的本地缓存（规格 2026-11-25 决策 A1 的对话部分）：最近打开的 30 条对话各存
 * 最近一页，按「最近打开」淘汰；按账号隔离、清空即无；存储不可用时静默退回「没存」。
 *
 * IndexedDB 用 fake-indexeddb 的内存实现，每条用例一份新的工厂。
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accountStore, bindAccount, wipeBusinessData } from "@/lib/localStore";
import {
  TRANSCRIPT_CACHE_KIND,
  TRANSCRIPT_CACHE_LIMIT,
  transcriptCache,
  type CachedTranscriptPage,
} from "@/lib/transcriptCache";

const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  g.indexedDB = new IDBFactory();
  g.IDBKeyRange = IDBKeyRange;
  bindAccount(1);
});

afterEach(() => {
  bindAccount(null);
  delete g.indexedDB;
  delete g.IDBKeyRange;
});

function page(seq: number): CachedTranscriptPage {
  return {
    events: [
      {
        conversationId: "c",
        seq,
        event: { kind: "user_message", text: `第 ${seq} 句` },
        sessionId: 1,
        createtime: 0,
      } as never,
    ],
    lastSeq: seq,
    oldestSeq: seq,
    hasBefore: false,
  };
}

describe("transcriptCache", () => {
  it("存进去的那一页原样读回来，kind 是 transcript", async () => {
    const entry = {
      ...page(3),
      row: { conversation_id: "c1", title: "重构登录页" } as never,
      agent: { sync_id: "ag-1", name: "前端 Agent" },
    };
    await transcriptCache.open("c1", entry, 1000);

    const got = await transcriptCache.get("c1");
    expect(got).toMatchObject({ ...entry, openedAt: 1000 });
    expect(
      (await accountStore.list(TRANSCRIPT_CACHE_KIND)).map((r) => r.key),
    ).toEqual(["c1"]);
  });

  it("第 31 条打开时淘汰最久没打开的那一条；重新打开过的那条往前排", async () => {
    expect(TRANSCRIPT_CACHE_LIMIT).toBe(30);
    for (let i = 0; i < 30; i++) {
      await transcriptCache.open(`c${i}`, page(i + 1), 1000 + i);
    }
    // c0 最老；重开一次它就成了最新的，下一个该走的是 c1。
    await transcriptCache.open("c0", page(1), 5000);
    await transcriptCache.open("c30", page(31), 6000);

    const keys = (await accountStore.list(TRANSCRIPT_CACHE_KIND)).map(
      (r) => r.key,
    );
    expect(keys).toHaveLength(30);
    expect(keys).toContain("c0");
    expect(keys).toContain("c30");
    expect(keys).not.toContain("c1");
    expect(await transcriptCache.get("c1")).toBeUndefined();
  });

  it("同一次打开期间的更新不改「打开时刻」、也不淘汰别的", async () => {
    await transcriptCache.open("a", page(1), 1000);
    await transcriptCache.update("a", page(9));
    const got = await transcriptCache.get("a");
    expect(got?.openedAt).toBe(1000);
    expect(got?.lastSeq).toBe(9);
  });

  it("forget 删掉那一条；清空业务数据后什么都读不到", async () => {
    await transcriptCache.open("a", page(1), 1000);
    await transcriptCache.open("b", page(2), 1001);
    await transcriptCache.forget("a");
    expect(await transcriptCache.get("a")).toBeUndefined();
    await wipeBusinessData();
    bindAccount(1);
    expect(await transcriptCache.get("b")).toBeUndefined();
  });

  it("按账号隔离：换一个账号读不到上一个账号的", async () => {
    await transcriptCache.open("a", page(1), 1000);
    bindAccount(2);
    expect(await transcriptCache.get("a")).toBeUndefined();
  });

  it("存储不可用：读到 undefined，写静默丢掉，不抛错", async () => {
    delete g.indexedDB;
    await expect(
      transcriptCache.open("a", page(1), 1000),
    ).resolves.toBeUndefined();
    await expect(transcriptCache.get("a")).resolves.toBeUndefined();
  });
});
