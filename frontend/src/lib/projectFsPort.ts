/**
 * 本站这一侧的 `ProjectFsPort`（规格 2026-08-22 D 段，决策 7 / 11）。
 *
 * 包里的目录选择器不认识中继，也不认识 wails —— 它只认 `ProjectFsPort`。这份 adapter
 * 把「浏览器 → `/v1/relay/client` → 那台机器的 `remotefs.*`」那条通路裹成那个契约。
 *
 * **一台机器一条连接，用完一起收**：每次 `listDir` 都新建一条中继既浪费又抖动
 * （每次都要重握手、重取 ticket），而选择器开着的时候用户会来回换目录。所以按
 * fingerprint 缓存，`dispose()` 时全部 close。
 *
 * **连不上时让 promise 挂着**：`connect()` 没决议之前不回任何东西 —— 界面靠「请求在
 * 飞」画加载态，先回一个 `disconnected` 就变成每次打开都先说一句「连接断了」。真的
 * 连不上（connect 抛了）才交 `disconnected`，且**不把那台机器钉死**：下一次调用重新
 * 起一条，否则一次瞬时失败会让这台机器在这一屏里永远打不开。
 */
import type {
  ListDirOutcome,
  MkdirOutcome,
  ProjectFsPort,
} from "@agentre-hub/agentre-ui";

import type { RelayClient } from "@/lib/relayClient";
import { acquireRelayClient, type RelayLease } from "@/lib/relayClientPool";
import { machineTarget } from "@/lib/relayTarget";
import {
  classifyRemoteFsError,
  listDir as rpcListDir,
  mkdir as rpcMkdir,
  type RemoteFsEntry,
} from "@/lib/remotefs";

export interface DisposableProjectFsPort extends ProjectFsPort {
  /** 收掉所有连接。选择器关掉时调用，否则 ws 会一直挂着。 */
  dispose(): void;
}

/**
 * `.git` 这一条既是「**当前这个目录**是 git 仓库」的判据，又不该自己出现在列表里。
 *
 * 判的是当前目录而不是逐个子目录：子目录里有什么，这一次请求根本没读。
 */
function toResult(raw: {
  path: string;
  entries: RemoteFsEntry[];
  truncated: boolean;
}) {
  return {
    path: raw.path,
    truncated: raw.truncated,
    isGitRepo: raw.entries.some((e) => e.isDir && e.name === ".git"),
    // 文件留着：包会画成可见不可选 —— 那是「这个目录是不是我要的那个」的上下文。
    entries: raw.entries
      .filter((e) => e.name !== ".git")
      .map((e) => ({ name: e.name, isDir: e.isDir, symlink: e.symlink })),
  };
}

/** 连接这一步自己失败了 —— 与「那台机器答了一个错误码」是两回事。 */
class RelayUnreachable extends Error {}

/**
 * 连不上是 `disconnected`，不是 `unknown`。
 *
 * `classifyRemoteFsError` 认的是远端 RPC 错误码，而握手失败根本没走到 RPC —— 它抛的
 * 是一个裸 Error，落到 `unknown` 那一档就变成「读不到这个目录。ws refused」，用户看不
 * 出该去开那台机器。**哪一步失败的只有这里知道**，所以在这里分。
 */
function failureOf(err: unknown) {
  if (err instanceof RelayUnreachable) {
    return { kind: "disconnected" as const, message: err.message };
  }
  return classifyRemoteFsError(err);
}

export function createProjectFsPort(): DisposableProjectFsPort {
  const leases = new Map<string, Promise<RelayLease>>();
  /**
   * 本 port 手里那几份租约，**同步**记着。
   *
   * `dispose()` 不能只靠 `promise.then(release)`：那是一个微任务，调用方一收手这一拍
   * 租约还在手里；更糟的是 dispose 之后才决议的那一份会漏在外面永远没人还。
   */
  const held = new Set<RelayLease>();
  /**
   * 第几代。`dispose()` 只是**翻页**，不是一道不可逆的闸。
   *
   * React 18 的 StrictMode 在开发下把 effect 跑两遍（mount → cleanup → mount），
   * 而 `useMemo` 交出来的还是同一个 port —— 把「已经收手」记成一个 boolean，
   * `make dev` 下目录选择器就永远说「连接断了」。用代数记：翻页之后新的请求照常
   * 开工，只有**上一代**那些迟到决议的租约会自己还掉。
   */
  let generation = 0;

  function connected(fingerprint: string): Promise<RelayClient> {
    return leaseFor(fingerprint).then((lease) => lease.client);
  }

  function leaseFor(fingerprint: string): Promise<RelayLease> {
    const existing = leases.get(fingerprint);
    if (existing) return existing;
    const era = generation;
    const pending = (async () => {
      let lease: RelayLease;
      try {
        lease = await acquireRelayClient(machineTarget(fingerprint));
      } catch (e) {
        // 握手失败在这里翻成 RelayUnreachable：failureOf 靠它把「那台机器连不上」
        // 与「远端 RPC 报错」分开说。
        throw new RelayUnreachable(String(e));
      }
      // 已经翻页了：这一份是上一代迟到的，当场还掉，别留在外面。
      if (era !== generation) {
        lease.release();
        throw new RelayUnreachable("relay: superseded");
      }
      held.add(lease);
      return lease;
    })();
    // 连失败就把这条从缓存里摘掉：留着的话那台机器在这一屏里永远打不开，
    // 而用户手里的「重试」按钮会变成一颗每次都复读同一句失败的按钮。
    pending.catch(() => leases.delete(fingerprint));
    leases.set(fingerprint, pending);
    return pending;
  }

  return {
    async listDir(machineId, path): Promise<ListDirOutcome> {
      try {
        const client = await connected(machineId);
        return { ok: true, result: toResult(await rpcListDir(client, path)) };
      } catch (err) {
        return { ok: false, failure: failureOf(err) };
      }
    },

    async mkdir(machineId, parent, name): Promise<MkdirOutcome> {
      try {
        const client = await connected(machineId);
        await rpcMkdir(client, parent, name);
        return { ok: true, result: undefined };
      } catch (err) {
        return { ok: false, failure: failureOf(err) };
      }
    },

    dispose() {
      generation += 1;
      // 还回去，不是关掉：这几条连接归池子，详情页可能正靠着同一条收事件。
      for (const lease of held) lease.release();
      held.clear();
      leases.clear();
    },
  };
}
