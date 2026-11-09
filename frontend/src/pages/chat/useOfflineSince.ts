import { useEffect, useState } from "react";

/**
 * 这一页打开之后，网络是从什么时刻断开的（`navigator.onLine` 落成 false 的那一刻）。
 * 在线时为 null。
 *
 * 只认打开之后的那次断开：冷启动时就没有网络走的是现有的离线页（规格 2026-11-05
 * 「首页」页头），这一页根本载不出来。断开之前列表一直随账号通道实时更新，所以
 * 「断开的时刻」就是已载入内容新鲜到的时刻。
 */
export function useOfflineSince(): number | null {
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    const onOffline = () => {
      if (!navigator.onLine) setSince(Date.now());
    };
    const onOnline = () => setSince(null);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);
  return since;
}
