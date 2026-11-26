import { useEffect, useRef } from "react";

import { ApiError } from "@/lib/api";
import { subscribeRecovery } from "@/lib/recoverySignal";

/**
 * 读失败之后，网络恢复 / 回前台 / 执行端通道重连时自动重试一次（规格 2026-11-25 K3）。
 *
 * `failure` 是这份读此刻的失败态：空值（null / undefined / false）= 没有失败，信号来了
 * 什么都不做。401 不重试——那是登出，由 api 层的全局处理清空并去登录页，再问一遍只会
 * 再撞一次 401。重试又失败的，失败态与手动「重试」照旧留着，下一次信号才再试：不打转。
 *
 * 一次重试**答完之前**不再发：恢复信号常常扎堆（回前台那一下 `visibilitychange`、
 * `pageshow` 与 `online` 几乎同时到，紧接着通道重连又报一次），那时上一次重试多半还在
 * 路上，再发一遍只是同一个请求打两次。「答完」= 失败态清掉、或换成了新的一次失败。
 * 不按时间隔开：回前台那一下网络常常还没回来，重试当场就失败，紧接着到的 `online` 才是
 * 真能成的那一下，不能被吞掉。
 *
 * 最新的失败态与重试经 ref 交给信号回调（每次渲染后更新），订阅只挂一次。
 */
export function useRetryOnRecovery(failure: unknown, retry: () => void): void {
  const latest = useRef({ failure, retry });
  /** 在等的那次重试发出时的失败态；没有在等的为 null。 */
  const awaiting = useRef<{ failure: unknown } | null>(null);
  useEffect(() => {
    latest.current = { failure, retry };
    if (
      awaiting.current &&
      (!failure || failure !== awaiting.current.failure)
    ) {
      awaiting.current = null;
    }
  });

  useEffect(
    () =>
      subscribeRecovery(() => {
        const { failure: now, retry: run } = latest.current;
        if (!now) return;
        if (now instanceof ApiError && now.status === 401) return;
        if (awaiting.current) return;
        awaiting.current = { failure: now };
        run();
      }),
    [],
  );
}
