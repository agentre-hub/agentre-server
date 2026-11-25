/**
 * 本机存储（规格 2026-11-25 决策 A1、A2、A6）：让手机上的 App 打开时先画出上次的
 * 内容，再拿服务端的去替换。
 *
 * **只是加速，以服务端为准。** 所以这里从不报错：没有 IndexedDB（无痕）、打开就抛、
 * 打开一直不应答、配额满、读写失败，一律当「什么都没存」——读到 undefined / 空列表，
 * 写静默丢掉，调用方照旧每次联网。
 *
 * 两类东西：
 *
 * - **业务数据**（`accountStore`）：按账号隔离，键是「账号 + kind + key」。kind 是
 *   开放的字符串（列表、名单、转录、草稿、待发送……由各自的模块起名），这里不认识
 *   任何一种。账号由身份模块 `bindAccount` 绑定；没绑定（还不知道是谁、刚清空）时
 *   不读不写，在飞的请求晚到也落不进去。
 * - **本地身份**：上次确认过的 `/v1/auth/me`，它决定启动时能不能不等网络就进入。
 *
 * 登出、任何请求 401、身份换成另一个账号时 `wipeBusinessData()` 全部清掉，连同
 * sessionStorage 里的 CSRF 副本与内存里共享的名单；界面偏好（主题、语言、侧栏、
 * 最近 Agent）住在 localStorage，不归这里，原样留着。
 *
 * 格式版本就是库的版本号：版本不符（升级、或回滚到旧前端）时整库丢弃重建，不做迁移
 * ——丢的只是一份缓存。
 */
import { setCsrfToken } from "@/lib/api";
import { invalidateRosters } from "@/lib/rosterFetch";

export const LOCAL_DB_NAME = "agentre-local";
/** 存的东西改了形状就加一：旧库整个丢掉。 */
const FORMAT_VERSION = 1;
const RECORDS = "records";
const IDENTITY = "identity";
const IDENTITY_KEY = "me";

/**
 * 打开超过这么久没有应答就当不可用：旧版 iOS 有首次打开永远不回调的毛病，本地身份
 * 又挡在启动路径上，等不起。
 */
const OPEN_TIMEOUT_MS = 3_000;

let account: number | null = null;

/** 之后的读写落在哪个账号下；`null` = 不读不写。 */
export function bindAccount(next: number | null): void {
  account = next;
}

/**
 * 每个工厂只开一次连接。按工厂记而不是只记一个：页面里工厂从不变，测试则每条用例
 * 换一个新的。打不开记成 null，这一页不再试。
 */
let opened: { factory: IDBFactory; db: Promise<IDBDatabase | null> } | null =
  null;

function database(): Promise<IDBDatabase | null> {
  let factory: IDBFactory | undefined;
  try {
    factory = globalThis.indexedDB;
  } catch {
    // 有的浏览器在禁用存储时连读这个属性都抛
  }
  if (!factory) return Promise.resolve(null);
  if (opened?.factory !== factory) {
    opened = { factory, db: open(factory) };
  }
  return opened.db;
}

function open(factory: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => settle(null), OPEN_TIMEOUT_MS);
    const attempt = (retryOnVersionError: boolean) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(LOCAL_DB_NAME, FORMAT_VERSION);
      } catch {
        settle(null);
        return;
      }
      req.onupgradeneeded = () => {
        // 新建，或从别的格式升上来：旧的全部丢掉。
        const db = req.result;
        for (const name of Array.from(db.objectStoreNames)) {
          db.deleteObjectStore(name);
        }
        db.createObjectStore(RECORDS, { keyPath: ["account", "kind", "key"] });
        db.createObjectStore(IDENTITY);
      };
      req.onsuccess = () => {
        const db = req.result;
        // 别的标签页要换格式时让开，别把它卡在 blocked 上。
        db.onversionchange = () => {
          db.close();
          if (opened?.factory === factory) opened = null;
        };
        settle(db);
      };
      req.onerror = (event) => {
        // 库是更高的格式版本写的（回滚到了旧前端）：删掉重来一次。
        if (retryOnVersionError && req.error?.name === "VersionError") {
          event.preventDefault();
          let del: IDBOpenDBRequest;
          try {
            del = factory.deleteDatabase(LOCAL_DB_NAME);
          } catch {
            settle(null);
            return;
          }
          del.onsuccess = () => attempt(false);
          del.onerror = () => settle(null);
          return;
        }
        settle(null);
      };
    };
    attempt(true);
  });
}

/** 一次请求，任何失败都折成 `fallback`。 */
async function run<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => IDBRequest | void,
  fallback: T,
): Promise<T> {
  const db = await database();
  if (!db) return fallback;
  return new Promise<T>((resolve) => {
    try {
      const tx = db.transaction(storeNames, mode);
      const req = body(tx);
      tx.oncomplete = () =>
        resolve(req ? ((req.result as T | undefined) ?? fallback) : fallback);
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    } catch {
      resolve(fallback);
    }
  });
}

interface StoredRecord {
  account: number;
  kind: string;
  key: string;
  value: unknown;
}

/** 按账号隔离的业务数据。所有方法都不会拒绝。 */
export const accountStore = {
  async get<T>(kind: string, key: string): Promise<T | undefined> {
    if (account === null) return undefined;
    const rec = await run<StoredRecord | undefined>(
      [RECORDS],
      "readonly",
      (tx) => tx.objectStore(RECORDS).get([account!, kind, key]),
      undefined,
    );
    return rec?.value as T | undefined;
  },

  async put<T>(kind: string, key: string, value: T): Promise<void> {
    if (account === null) return;
    const rec: StoredRecord = { account, kind, key, value };
    await run(
      [RECORDS],
      "readwrite",
      (tx) => {
        tx.objectStore(RECORDS).put(rec);
      },
      undefined,
    );
  },

  async delete(kind: string, key: string): Promise<void> {
    if (account === null) return;
    const id = [account, kind, key];
    await run(
      [RECORDS],
      "readwrite",
      (tx) => {
        tx.objectStore(RECORDS).delete(id);
      },
      undefined,
    );
  },

  async list<T>(kind: string): Promise<Array<{ key: string; value: T }>> {
    if (account === null) return [];
    const owner = account;
    const recs = await run<StoredRecord[]>(
      [RECORDS],
      "readonly",
      // 数组键排在字符串之后，所以 [账号, kind, []] 是这一类里所有字符串 key 的上界。
      (tx) =>
        tx
          .objectStore(RECORDS)
          .getAll(IDBKeyRange.bound([owner, kind], [owner, kind, []])),
      [],
    );
    return recs.map((r) => ({ key: r.key, value: r.value as T }));
  },
};

/** 上次确认过的身份；没有或存储不可用时是 undefined。 */
export function readLocalIdentity<T>(): Promise<T | undefined> {
  return run<T | undefined>(
    [IDENTITY],
    "readonly",
    (tx) => tx.objectStore(IDENTITY).get(IDENTITY_KEY),
    undefined,
  );
}

export async function writeLocalIdentity<T>(value: T): Promise<void> {
  await run(
    [IDENTITY],
    "readwrite",
    (tx) => {
      tx.objectStore(IDENTITY).put(value, IDENTITY_KEY);
    },
    undefined,
  );
}

/**
 * 清空本机的全部业务数据：各账号的记录、本地身份、CSRF 副本、内存里共享的名单。
 * 界面偏好不动。先解绑账号，清空期间与之后晚到的写都落不进去。
 */
export async function wipeBusinessData(): Promise<void> {
  bindAccount(null);
  setCsrfToken(null);
  invalidateRosters(null);
  await run(
    [RECORDS, IDENTITY],
    "readwrite",
    (tx) => {
      tx.objectStore(RECORDS).clear();
      tx.objectStore(IDENTITY).clear();
    },
    undefined,
  );
}
