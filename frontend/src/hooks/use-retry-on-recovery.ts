import { useEffect, useRef } from "react";

import { ApiError } from "@/lib/api";
import { subscribeRecovery } from "@/lib/recoverySignal";

/**
 * 同一份读两次自动重试之间至少隔这么久。
 *
 * 恢复信号常常扎堆：回到前台那一下 `visibilitychange`、`pageshow` 与 `online` 几乎同时
 * 到，紧接着通道重连又报一次。隔开它们才是「一次恢复一次重试」；而上一次重试多半还在
 * 路上（失败态要等它答完才落下），再发一遍只是同一个请求打两次。
 */
export const RecoveryRetryGapMs = 2_000;

/**
 * 读失败之后，网络恢复 / 回前台 / 执行端通道重连时自动重试一次（规格 2026-11-25 K3）。
 *
 * `failure` 是这份读此刻的失败态：空值（null / undefined / false）= 没有失败，信号来了
 * 什么都不做。401 不重试——那是登出，由 api 层的全局处理清空并去登录页，再问一遍只会
 * 再撞一次 401。重试又失败的，失败态与手动「重试」照旧留着，下一次信号才再试：不打转。
 *
 * 最新的失败态与重试经 ref 交给信号回调（每次渲染后更新），订阅只挂一次。
 */
export function useRetryOnRecovery(failure: unknown, retry: () => void): void {
  const latest = useRef({ failure, retry });
  useEffect(() => {
    latest.current = { failure, retry };
  });
  const lastRetryAt = useRef<number | null>(null);

  useEffect(
    () =>
      subscribeRecovery(() => {
        const { failure: now, retry: run } = latest.current;
        if (!now) return;
        if (now instanceof ApiError && now.status === 401) return;
        const at = Date.now();
        if (
          lastRetryAt.current !== null &&
          at - lastRetryAt.current < RecoveryRetryGapMs
        ) {
          return;
        }
        lastRetryAt.current = at;
        run();
      }),
    [],
  );
}
