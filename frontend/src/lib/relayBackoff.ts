/**
 * 重试的退让间隔：指数、封顶、半幅抖动。
 *
 * 中继这条线上现在有两处重试，两处都常驻在登录期间：连不上的那条 socket
 * （`RelayConnection`），以及握手被拒的那条通道（`RelayClient`）。固定间隔的重试等于
 * 对着一个够不着（或正不健康）的依赖每秒拨一次，直到标签页关掉。
 *
 * 抖动是**必需的**而不是修饰：所有标签页（以及所有装着这个前端的机器）看到的是同一次
 * 服务端故障，没有抖动它们会整整齐齐地同时重拨，把退让的意义抵消掉。取半幅，与 daemon
 * 侧 relaytransport.HubLink.backoff 同一形状。
 *
 * 排期本身归 `RedialTimer`：那边管「已经排着了就别再排一次」，这里只算这一次等多久。
 */
export interface BackoffOptions {
  /** 第一次重试的等待。 */
  baseMs: number;
  /** 退让的封顶。 */
  capMs: number;
  /** [0,1) 的抖动源，测试注入定值。 */
  random?: () => number;
}

/** 连着失败了 `failures` 次之后，这一次该等多久。`failures` 从 0 起。 */
export function backoffDelay(
  failures: number,
  { baseMs, capMs, random }: BackoffOptions,
): number {
  const jitter = random ? random() : Math.random();
  const ceiling = Math.min(baseMs * 2 ** failures, capMs);
  return Math.round(ceiling * (0.5 + Math.min(Math.max(jitter, 0), 1) / 2));
}
