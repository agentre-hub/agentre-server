/**
 * 发件箱（规格 2026-11-25 决策 C2、C3）：排着队的那一条与没发出去的那些，跟着对话存在
 * 本机，离开对话、重载、杀 App 之后回来仍在。
 *
 * 存在 `accountStore`（kind = `outbox`），每条对话一条记录，键就是对话号：按账号隔离，
 * 登出 / 401 / 换账号时随业务数据一起清掉；存储不可用时每个操作都静默成空操作，页面
 * 退回今天的内存行为。内容**原样**存（不改动用户发送的任何内容）：字与图就是输入框交出
 * 来的那份，IndexedDB 的结构化克隆保证读回逐字节一致。
 *
 * 一条记录里三样：
 *   - `queued`：排着队等连接的那一条（每条对话只排一条，新来的把旧的挤成失败）。
 *   - `handedOff`：已经交给中继、结果还没回来的那几条（C3）。**写出请求之前**先记进来；
 *     拿到结果再撤掉。App 在两者之间被杀，下次打开时它们落成「可能已送达」，永不自动
 *     再发（不变量「不会把一条消息发两次」）。
 *   - `failed`：失败气泡（`FailedSend`），保留「重发 / 复制 / 丢弃」。
 *
 * 两个标签页对着同一条对话：每个读-改-写都在 Web Locks 的同名锁里做（没有该 API 时退回
 * 本页内串行），所以「认领排队那一条」是一次比较并交换——只有一个认领得到，只有它发。
 * 正在发的那一条由发送方持有一把专属的锁直到结果落库；另一个实例打开时据此分辨
 * 「发送方还活着」与「发送方被杀了」，前者不动，后者才落「可能已送达」。
 */
import { useState } from "react";

import type { ChatComposerSubmit } from "@agentre-hub/agentre-ui";

import type { FailedSend } from "@/components/session/SendFailureBubble";
import { useAliveEffect } from "@/hooks/use-alive-effect";
import { accountStore } from "@/lib/localStore";
import { RequestTimeoutMs } from "@/lib/relayClient";
import type { PendingSend } from "@/pages/chat/phoneRows";

const KIND = "outbox";

/** 发件箱里的一条消息：输入框交出来的那份，加一个本机的身份。 */
export interface OutboxMessage extends ChatComposerSubmit {
  id: string;
  /**
   * 交给中继的那一刻（只有「已交出」的带）。恢复成「可能已送达」时随之带进失败，
   * 转录里看得见它了据此收起（规格 2026-11-25 K4）。
   */
  handedOffAt?: number;
}

export interface OutboxEntry {
  queued?: OutboxMessage;
  handedOff: OutboxMessage[];
  failed: FailedSend[];
}

function normalize(value: Partial<OutboxEntry> | undefined): OutboxEntry {
  return {
    ...(value?.queued ? { queued: value.queued } : {}),
    handedOff: value?.handedOff ?? [],
    failed: value?.failed ?? [],
  };
}

function isEmptyEntry(entry: OutboxEntry): boolean {
  return (
    !entry.queued && entry.handedOff.length === 0 && entry.failed.length === 0
  );
}

function upsertFailure(entry: OutboxEntry, failure: FailedSend): void {
  const at = entry.failed.findIndex((f) => f.id === failure.id);
  if (at >= 0) entry.failed[at] = failure;
  else entry.failed.push(failure);
}

function removeFailure(entry: OutboxEntry, id: string): void {
  entry.failed = entry.failed.filter((f) => f.id !== id);
}

// ── 串行化与发送方存活 ─────────────────────────────────────────────────────

function lockManager(): LockManager | undefined {
  try {
    return typeof navigator === "undefined" ? undefined : navigator.locks;
  } catch {
    return undefined;
  }
}

/** 没有 Web Locks 时的本页内串行（每条对话一串）。 */
const chains = new Map<string, Promise<unknown>>();

function exclusive<T>(
  conversationId: string,
  body: () => Promise<T>,
): Promise<T> {
  const locks = lockManager();
  if (locks) {
    return locks.request(
      `agentre-outbox:${conversationId}`,
      body,
    ) as Promise<T>;
  }
  const prev = chains.get(conversationId) ?? Promise.resolve();
  const run = prev.then(body, body);
  chains.set(
    conversationId,
    run.catch(() => {}),
  );
  return run;
}

const sendLockName = (conversationId: string, id: string) =>
  `agentre-outbox-send:${conversationId}:${id}`;

/** 没有 Web Locks 时，本页里正在发的那几条。 */
const inFlight = new Set<string>();

/**
 * 发送方在交出时拿到这把锁，结果落库之后放掉（返回的就是放锁）。标签页被杀时浏览器
 * 替它放掉——别的实例据此知道它不会再回来了。
 */
function holdSendLock(conversationId: string, id: string): Promise<() => void> {
  const name = sendLockName(conversationId, id);
  const locks = lockManager();
  if (!locks) {
    inFlight.add(name);
    return Promise.resolve(() => inFlight.delete(name));
  }
  return new Promise((granted) => {
    void locks.request(
      name,
      () => new Promise<void>((release) => granted(() => release())),
    );
  });
}

async function senderAlive(
  conversationId: string,
  id: string,
): Promise<boolean> {
  const name = sendLockName(conversationId, id);
  const locks = lockManager();
  if (!locks) return inFlight.has(name);
  return (await locks.request(
    name,
    { ifAvailable: true },
    (lock) => lock === null,
  )) as boolean;
}

/**
 * 在库里**确认见过**的排队消息（写入后读回过、或从库里恢复出来的）。认领时只有它们
 * 要求库里那一条还在：库里没了 = 别的实例已经认领走。没确认见过的（存储不可用）只活
 * 在这一页的内存里，没人抢得走。
 */
const persistedQueued = new Set<string>();

/**
 * 同理，在库里确认见过的失败（从库里恢复出来、或写入后读回过的）。从失败气泡上重发时
 * 只有它们要求库里那一条还在：库里没了 = 已经有人（别的标签页、或这一页连点的上一下）
 * 拿它去重发了，这一下不发（不变量「不会把一条消息发两次」）。
 */
const persistedFailures = new Set<string>();

// ── 同页通知 ───────────────────────────────────────────────────────────────

const listeners = new Map<string, Set<(entry: OutboxEntry) => void>>();

/** 这条对话的发件箱每写一次，把写完的样子告诉本页的订阅者。返回退订。 */
export function subscribeOutbox(
  conversationId: string,
  fn: (entry: OutboxEntry) => void,
): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(conversationId);
  };
}

function toFailure(
  message: OutboxMessage,
  kind: FailedSend["kind"],
): FailedSend {
  return {
    id: message.id,
    text: message.text,
    images: message.images,
    kind,
    ...(kind === "transport" && message.handedOffAt
      ? { handedOffAt: message.handedOffAt }
      : {}),
  };
}

/** 本机发件箱。所有方法都不会拒绝（存储不可用时静默）。 */
export const outboxStore = {
  async get(conversationId: string): Promise<OutboxEntry | undefined> {
    const value = await accountStore.get<OutboxEntry>(KIND, conversationId);
    return value ? normalize(value) : undefined;
  },

  async list(): Promise<Map<string, OutboxEntry>> {
    const all = await accountStore.list<OutboxEntry>(KIND);
    return new Map(all.map((r) => [r.key, normalize(r.value)]));
  },

  /** 一次串行的读-改-写：`fn` 就地改它拿到的那份，写回（空了就删），通知本页。 */
  update<T>(
    conversationId: string,
    fn: (entry: OutboxEntry) => T | Promise<T>,
  ): Promise<T> {
    return exclusive(conversationId, async () => {
      const entry = normalize(
        await accountStore.get<OutboxEntry>(KIND, conversationId),
      );
      const result = await fn(entry);
      if (isEmptyEntry(entry)) await accountStore.delete(KIND, conversationId);
      else await accountStore.put(KIND, conversationId, entry);
      if (entry.failed.length > 0) {
        const back = await accountStore.get<OutboxEntry>(KIND, conversationId);
        for (const f of back?.failed ?? []) persistedFailures.add(f.id);
      }
      for (const listener of [...(listeners.get(conversationId) ?? [])]) {
        listener(entry);
      }
      return result;
    });
  },

  /**
   * 打开一条对话时读出它的发件箱。发送方已经不在了的「已交出」落成「可能已送达」
   * （transport）——它确实离开了手机，所以永不自动再发；发送方还活着（别的实例正在发）
   * 的原样留着。
   */
  restore(
    conversationId: string,
  ): Promise<{ queued?: OutboxMessage; failed: FailedSend[] }> {
    return this.update(conversationId, async (entry) => {
      const alive: OutboxMessage[] = [];
      for (const message of entry.handedOff) {
        if (await senderAlive(conversationId, message.id)) alive.push(message);
        else upsertFailure(entry, toFailure(message, "transport"));
      }
      entry.handedOff = alive;
      if (entry.queued) persistedQueued.add(entry.queued.id);
      return { queued: entry.queued, failed: [...entry.failed] };
    });
  },

  /** 排一条。原来排着的那条挤成「还没发出去」的失败；从失败气泡上重发的撤掉那条气泡。 */
  async queue(
    conversationId: string,
    message: OutboxMessage,
    replacing?: string,
  ): Promise<void> {
    await this.update(conversationId, (entry) => {
      if (replacing) removeFailure(entry, replacing);
      if (entry.queued && entry.queued.id !== message.id) {
        upsertFailure(entry, toFailure(entry.queued, "notSent"));
      }
      entry.queued = message;
    });
    if ((await this.get(conversationId))?.queued?.id === message.id) {
      persistedQueued.add(message.id);
    }
  },

  /** 撤销排着的那一条（只撤这一条：库里已经换成别的就不动）。 */
  async unqueue(conversationId: string, id: string): Promise<void> {
    await this.update(conversationId, (entry) => {
      if (entry.queued?.id === id) delete entry.queued;
    });
  },

  /** 排着的那条再也发不出去了（它从没离开手机）：换成一条失败。 */
  async failQueued(conversationId: string, failure: FailedSend): Promise<void> {
    await this.update(conversationId, (entry) => {
      if (entry.queued?.id === failure.id) delete entry.queued;
      upsertFailure(entry, failure);
    });
  },

  /**
   * 交出：写出请求之前记下「已交出」（C3）。
   *
   * `claimQueued` = 这一条就是排着的那条：比较并交换，库里那条还是它才认领得到；确认
   * 见过而库里已经没有了 = 别的实例认领走了，返回 false，调用方不发。`replacing` =
   * 从失败气泡上重发，那条失败此刻改记为已交出；同样是比较并交换——确认见过的失败
   * 在库里已经没有了，就是别处已经拿它重发了，不发。
   *
   * 两样都要在拿发送锁**之前**判掉：重发用的是那条失败的身份，抢输的一方若照样去等
   * 发送锁，它是攥着发件箱锁在等，而赢的一方结果回来时要这把发件箱锁才能落库、放锁
   * ——两边互相等死。
   *
   * 认领成功时交回放锁的函数（结果落库之后调），否则 null。发送锁在同一次读-改-写里
   * 拿：别的实例只能在这把发件箱锁里看见「已交出」，那时发送锁必定已经被持有。
   */
  async handOff(
    conversationId: string,
    message: OutboxMessage,
    opts: { claimQueued?: string; replacing?: string } = {},
  ): Promise<(() => void) | null> {
    let release = null as (() => void) | null;
    await this.update(conversationId, async (entry) => {
      const { claimQueued, replacing } = opts;
      if (claimQueued) {
        if (entry.queued?.id === claimQueued) delete entry.queued;
        else if (persistedQueued.has(claimQueued)) return;
      }
      if (
        replacing &&
        !entry.failed.some((f) => f.id === replacing) &&
        persistedFailures.has(replacing)
      ) {
        return;
      }
      release = await holdSendLock(conversationId, message.id);
      if (replacing) removeFailure(entry, replacing);
      entry.handedOff = [
        ...entry.handedOff.filter((m) => m.id !== message.id),
        message,
      ];
    });
    return release;
  },

  /** 结果回来了：撤掉「已交出」；没成的话换成那一条失败（同一个身份）。 */
  async settle(
    conversationId: string,
    id: string,
    failure?: FailedSend,
  ): Promise<void> {
    await this.update(conversationId, (entry) => {
      entry.handedOff = entry.handedOff.filter((m) => m.id !== id);
      if (failure) upsertFailure(entry, failure);
      else removeFailure(entry, id);
    });
  },

  async putFailure(conversationId: string, failure: FailedSend): Promise<void> {
    await this.update(conversationId, (entry) => upsertFailure(entry, failure));
  },

  async dropFailure(conversationId: string, id: string): Promise<void> {
    await this.update(conversationId, (entry) => removeFailure(entry, id));
  },
};

/**
 * 手机首页：每条有待发送消息的对话 → 它的正文（挂载时读一次）。排着队的那条优先；
 * 没有排队、只有没发出去（失败）的，取最近那条失败——它同样还没到对端手里，等着用户
 * 回去重发（规格 2026-11-25 C2）。
 */
export function useOutboxMap(): Map<string, PendingSend> {
  const [pending, setPending] = useState<Map<string, PendingSend>>(
    () => new Map(),
  );
  useAliveEffect((alive) => {
    void outboxStore.list().then((all) => {
      if (!alive()) return;
      const next = new Map<string, PendingSend>();
      for (const [conversationId, entry] of all) {
        const waiting = entry.queued ?? entry.failed.at(-1);
        if (waiting) next.set(conversationId, { text: waiting.text });
      }
      setPending(next);
    });
  }, []);
  return pending;
}

/**
 * 一条消息过线的大致字节数：正文的 UTF-8 长度加上每张图的 dataUrl 长度（base64，
 * 一个字符一个字节）。等应答的上限与是否显示上传进度都按它算。
 */
export function payloadBytes(message: ChatComposerSubmit): number {
  let bytes = new TextEncoder().encode(message.text).byteLength;
  for (const image of message.images ?? []) bytes += image.dataUrl.length;
  return bytes;
}

/**
 * 按最慢还算能用的上行（约 32 KiB/s，弱 3G）估一帧要传多久，加在 RequestTimeoutMs 上
 * （C4）：一次正在进行的大图上传不该被一刀切的 30 秒判成超时。
 */
const SlowestUploadBytesPerMs = 32.768;

export function requestTimeoutFor(bytes: number): number {
  return RequestTimeoutMs + Math.ceil(bytes / SlowestUploadBytesPerMs);
}
