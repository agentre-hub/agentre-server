import { useEffect, useState } from "react";

/**
 * 没有网络时，屏上的内容新鲜到什么时刻；在线时为 null。
 *
 * 两种来路：
 *
 *  - 打开之后断网（`navigator.onLine` 落成 false 的那一刻）：断开之前列表一直随账号
 *    通道实时更新，所以「断开的时刻」就是已载入内容新鲜到的时刻；
 *  - 完全离线打开（规格 2026-11-25「完全离线打开」）：外壳与列表都从本机来，屏上那
 *    一份停在它当初取回的时刻——由调用方以 `freshAt` 交进来（本机存储那一份的时间）。
 *
 * `freshAt` 给了就以它为准：摆着的是还没被刷新过的本地数据时，断网的那一刻说明不了
 * 它有多新。
 */
export function useOfflineSince(freshAt: number | null = null): number | null {
  // 打开时就没有网络：记下这一刻，作为没有 freshAt 时的兜底。
  const [since, setSince] = useState<number | null>(() =>
    typeof navigator !== "undefined" && navigator.onLine === false
      ? Date.now()
      : null,
  );
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
  if (since === null) return null;
  return freshAt ?? since;
}
