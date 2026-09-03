import { useState } from "react";

import { useAliveEffect } from "@/hooks/use-api-query";
import { api } from "@/lib/api";

/**
 * 「最新发布版本是多少」——问的是**服务端自己**的只读端点，不直连上游
 * （决策 12：控制台常部署在内网，浏览器未必连得到 GitHub；出口收在一处）。
 *
 * 空串表示「不知道」：拉取失败、被配置关闭、还没拉到过，以及这一次请求本身失败
 * ——四种情形在界面上是同一个后果，一律不出判断、不编版本（决策 19）。这也是这里
 * 把失败吞掉、不往上抛 loading/error 的原因：设备页不该因为问不到 latest 而报错，
 * 它只是少一枚徽标。
 */
export function useLatestRelease(): string {
  const [latest, setLatest] = useState("");

  useAliveEffect((alive) => {
    api<{ known: boolean; version?: string }>("/v1/release/latest")
      .then((res) => {
        if (!alive()) return;
        setLatest(res.known ? (res.version ?? "") : "");
      })
      .catch(() => {
        // 拿不到就是拿不到。
      });
  }, []);

  return latest;
}
