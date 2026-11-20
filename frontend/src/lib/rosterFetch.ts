/**
 * 账号名单的共享取数（规格 2026-11-20 决策 8）。
 *
 * 设备、Agent、项目名单与「需要你」计数在同一屏上被好几处各自要一遍：外壳要设备数与
 * 角标，对话页要设备 / Agent / 项目，详情要 Agent / 项目，目标设备 hook 又要一次设备。
 * 弱网下每多一个往返就多一段转圈，而它们问的是同一件事。
 *
 * 这里只做两件事，刻意不长成一个查询层：
 *
 *  - **共用在飞请求**：同一时刻的几个调用方拿到的是同一个 Promise；
 *  - **短期复用**：取回来之后 `RosterReuseMs` 内再问，直接给那一份。
 *
 * 作废有三条路，漏任何一条都会把新数据藏在旧的后面：
 *
 *  - 账号信号：`invalidateRosters(种类)` 由 use-account-channel 在分发「该拉了」之前
 *    调用，每份名单只认让它过期的那几类；`null`（建连 / 重连 / 兜底轮询）作废全部；
 *  - 写操作：写名单的那个模块在写完（成功或失败）之后调 `invalidate()`；
 *  - 用户的重试：`invalidateRosters(null)`。
 *
 * 失败不进缓存：下一次调用一定重新取，重试按钮不会被一次失败挡住。
 */

/** 取回来之后复用多久。 */
export const RosterReuseMs = 10_000;

export interface Roster<T> {
  /** 有在飞的就共用，10 秒内取过的就复用，否则发一次新的。 */
  get(): Promise<T>;
  /** 丢掉手上那一份（含在飞的）：之后的 get 一定发新请求。 */
  invalidate(): void;
}

interface Entry<T> {
  promise: Promise<T>;
  /** null = 还在飞。 */
  settledAt: number | null;
}

interface Registered {
  invalidatedBy: ReadonlySet<string>;
  invalidate(): void;
}

const registry = new Set<Registered>();

/**
 * 声明一份共享名单。
 *
 * `invalidatedBy` 是让它过期的账号信号种类（见 `@/lib/accountChannel`）。
 */
export function createRoster<T>(
  load: () => Promise<T>,
  invalidatedBy: readonly string[],
): Roster<T> {
  let entry: Entry<T> | null = null;

  const invalidate = () => {
    entry = null;
  };

  const get = (): Promise<T> => {
    if (
      entry &&
      (entry.settledAt === null || Date.now() - entry.settledAt < RosterReuseMs)
    ) {
      return entry.promise;
    }
    const mine = { settledAt: null } as Entry<T>;
    // 回来时只认自己还是不是手上那一份：在飞时被作废的那次，结果照常交给当初的
    // 调用方，但不能把作废之后才发出的那一份顶掉。
    mine.promise = load().then(
      (value) => {
        if (entry === mine) mine.settledAt = Date.now();
        return value;
      },
      (err: unknown) => {
        if (entry === mine) entry = null;
        throw err;
      },
    );
    entry = mine;
    return mine.promise;
  };

  registry.add({ invalidatedBy: new Set(invalidatedBy), invalidate });
  return { get, invalidate };
}

/**
 * 按一条账号信号作废。`null` 是「你可能已经落后了」（建连、重连、兜底轮询、用户的
 * 重试），作废全部——与 use-account-channel 喊醒所有订阅者是同一条判据。
 */
export function invalidateRosters(signalType: string | null): void {
  for (const roster of registry) {
    if (signalType === null || roster.invalidatedBy.has(signalType)) {
      roster.invalidate();
    }
  }
}
