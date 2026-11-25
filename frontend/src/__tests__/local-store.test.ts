/**
 * 本地存储（规格 2026-11-25 决策 A1、A2、A6）：
 *   - 按账号隔离：同一个 kind / key，换一个账号读不到上一个账号的；
 *   - 清空覆盖全部业务数据（各账号的记录、本地身份、CSRF 副本、内存名单），
 *     界面偏好（主题、语言、侧栏、最近 Agent）留着；
 *   - 格式版本不符整体丢弃；
 *   - 存储不可用（没有 IndexedDB、打开就抛、打开不应答）时静默退回「什么都没存」。
 *
 * IndexedDB 用 fake-indexeddb 的内存实现，每条用例一份新的工厂——等于每条都从一台
 * 从没打开过控制台的浏览器起。
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, setCsrfToken } from "@/lib/api";
import { deviceRoster } from "@/lib/devices";
import {
  accountStore,
  bindAccount,
  LOCAL_DB_NAME,
  readLocalIdentity,
  wipeBusinessData,
  writeLocalIdentity,
} from "@/lib/localStore";
import { NAV_COLLAPSED_KEY, writeNavCollapsed } from "@/lib/navCollapsed";
import { RECENT_AGENTS_KEY, rememberAgent } from "@/lib/recentAgents";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const g = globalThis as Record<string, unknown>;

function installIndexedDB(factory: unknown = new IDBFactory()) {
  g.indexedDB = factory;
  g.IDBKeyRange = IDBKeyRange;
}

beforeEach(() => {
  installIndexedDB();
  bindAccount(null);
  mockedApi.mockReset();
});

function snapshot(storage: Storage): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    out[key] = storage.getItem(key);
  }
  return out;
}

afterEach(() => {
  delete g.indexedDB;
  delete g.IDBKeyRange;
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

describe("accountStore", () => {
  it("按 kind 存取、列出与删除，只列这一类", async () => {
    bindAccount(7);
    await accountStore.put("list", "all|none|", { rows: [1, 2] });
    await accountStore.put("list", "mine|none|", { rows: [3] });
    await accountStore.put("draft", "conv-1", "你好");

    expect(await accountStore.get("list", "all|none|")).toEqual({
      rows: [1, 2],
    });
    const listed = await accountStore.list("list");
    expect(listed.map((e) => e.key).sort()).toEqual([
      "all|none|",
      "mine|none|",
    ]);

    await accountStore.delete("list", "all|none|");
    expect(await accountStore.get("list", "all|none|")).toBeUndefined();
    expect(await accountStore.list("list")).toEqual([
      { key: "mine|none|", value: { rows: [3] } },
    ]);
    expect(await accountStore.get("draft", "conv-1")).toBe("你好");
  });

  it("按账号隔离：换了账号读不到、列不出上一个账号的", async () => {
    bindAccount(1);
    await accountStore.put("draft", "conv-1", "一号的草稿");

    bindAccount(2);
    expect(await accountStore.get("draft", "conv-1")).toBeUndefined();
    expect(await accountStore.list("draft")).toEqual([]);
    await accountStore.put("draft", "conv-1", "二号的草稿");

    bindAccount(1);
    expect(await accountStore.get("draft", "conv-1")).toBe("一号的草稿");
  });

  it("还不知道是谁时一律不读不写", async () => {
    await accountStore.put("draft", "conv-1", "无主");
    expect(await accountStore.get("draft", "conv-1")).toBeUndefined();

    bindAccount(1);
    expect(await accountStore.list("draft")).toEqual([]);
  });
});

describe("local identity", () => {
  it("写下的身份下次打开能读回来", async () => {
    expect(await readLocalIdentity()).toBeUndefined();
    await writeLocalIdentity({ user_id: 3, email: "a@b.c" });
    expect(await readLocalIdentity()).toEqual({ user_id: 3, email: "a@b.c" });
  });
});

describe("wipeBusinessData", () => {
  it("清空各账号的业务数据、本地身份与 CSRF 副本，界面偏好留着", async () => {
    bindAccount(1);
    await accountStore.put("list", "k", "一号");
    bindAccount(2);
    await accountStore.put("list", "k", "二号");
    await writeLocalIdentity({ user_id: 2 });
    setCsrfToken("csrf-of-2");

    // 界面偏好：最近 Agent、侧栏、主题、语言（后两个是共享包与 i18next 自己的键）。
    rememberAgent("agent-1");
    writeNavCollapsed(true);
    localStorage.setItem("theme", "dark");
    localStorage.setItem("i18nextLng", "zh-CN");
    const prefsBefore = snapshot(localStorage);

    await wipeBusinessData();

    expect(sessionStorage.getItem("csrf")).toBeNull();
    expect(await readLocalIdentity()).toBeUndefined();
    for (const account of [1, 2]) {
      bindAccount(account);
      expect(await accountStore.get("list", "k")).toBeUndefined();
    }
    expect(snapshot(localStorage)).toEqual(prefsBefore);
    expect(localStorage.getItem(RECENT_AGENTS_KEY)).toContain("agent-1");
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe("1");
  });

  it("清空后不再替任何账号写：在飞的请求晚到也落不进去", async () => {
    bindAccount(1);
    await wipeBusinessData();
    await accountStore.put("list", "k", "晚到的一号数据");

    bindAccount(1);
    expect(await accountStore.get("list", "k")).toBeUndefined();
  });

  it("内存里共享的名单也作废：下一次要重新去取", async () => {
    mockedApi.mockResolvedValue({ devices: [] });
    await deviceRoster.get();
    expect(mockedApi).toHaveBeenCalledTimes(1);

    await wipeBusinessData();
    await deviceRoster.get();
    expect(mockedApi).toHaveBeenCalledTimes(2);
  });
});

describe("存储不可用时静默退回", () => {
  async function expectNoOp() {
    bindAccount(1);
    await expect(accountStore.put("draft", "k", "v")).resolves.toBeUndefined();
    await expect(accountStore.get("draft", "k")).resolves.toBeUndefined();
    await expect(accountStore.list("draft")).resolves.toEqual([]);
    await expect(accountStore.delete("draft", "k")).resolves.toBeUndefined();
    await expect(writeLocalIdentity({ user_id: 1 })).resolves.toBeUndefined();
    await expect(readLocalIdentity()).resolves.toBeUndefined();
    setCsrfToken("t");
    await expect(wipeBusinessData()).resolves.toBeUndefined();
    // 存储不可用也照样清 CSRF 副本：它不住在 IndexedDB 里。
    expect(sessionStorage.getItem("csrf")).toBeNull();
  }

  it("没有 IndexedDB（无痕 / 被禁用）", async () => {
    delete g.indexedDB;
    await expectNoOp();
  });

  it("一打开就抛（SecurityError 之类）", async () => {
    installIndexedDB({
      open: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    await expectNoOp();
  });

  it("打开一直不应答（旧 iOS 的首开卡死）：等一会儿就当不可用，不把启动卡住", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    installIndexedDB({ open: () => ({}) });
    bindAccount(1);

    const read = readLocalIdentity();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(read).resolves.toBeUndefined();
    await expect(accountStore.get("draft", "k")).resolves.toBeUndefined();
  });
});

describe("格式版本", () => {
  it("库是别的格式版本写的（例如回滚到旧前端）就整库丢弃，重新开始", async () => {
    const factory = installIndexedDBWithForeignVersion();
    installIndexedDB(await factory);

    bindAccount(1);
    expect(await accountStore.get("draft", "k")).toBeUndefined();
    expect(await readLocalIdentity()).toBeUndefined();
    await accountStore.put("draft", "k", "新格式");
    expect(await accountStore.get("draft", "k")).toBe("新格式");
  });
});

/** 一份已经被「更高版本的格式」占住的库，里面有它自己的数据。 */
async function installIndexedDBWithForeignVersion(): Promise<IDBFactory> {
  const factory = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const req = factory.open(LOCAL_DB_NAME, 9_999);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("whatever").put("旧数据", "k");
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
  return factory;
}
