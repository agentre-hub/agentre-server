/**
 * 一次重连的排期，单飞。
 *
 * relayClient 与 accountChannel 各自手写过一份同形的东西。两边的**退让策略**不
 * 同（中继是固定间隔，账号通道是指数退让、封顶到一个轮询周期），那部分留在各自
 * 手里；这里只收「排期」本身，因为出错的从来是它：
 *
 *  - 断线时 onerror 与 onclose 常常一起到。不判「已经排着了」就各排一次，同一次
 *    断线会拉起两条连接，其中一条从此没人持有、也没人关，跟着心跳在后台活下去。
 *  - 回调里通常又会排下一次（连不上就接着退让重试）。所以句柄必须**在跑之前**
 *    清空——晚一步，那一次会被自己的单飞判据吞掉，重连就此停摆。
 *
 * 退让的数值不进来：那是「多久重连合适」，是两个调用方各自的判断。
 */
export class RedialTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;

  /** 排一次。已经排着就什么都不做——先排的那一次说了算。 */
  schedule(delayMs: number, run: () => void): void {
    if (this.handle !== null) return;
    this.handle = setTimeout(() => {
      this.handle = null;
      run();
    }, delayMs);
  }

  /** 取消排期。没排过时是安全的空操作。 */
  cancel(): void {
    if (this.handle === null) return;
    clearTimeout(this.handle);
    this.handle = null;
  }

  /** 此刻排着没有。 */
  get pending(): boolean {
    return this.handle !== null;
  }
}
