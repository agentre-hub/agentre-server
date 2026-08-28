import { useState } from "react";

import { useAliveEffect } from "@/hooks/use-api-query";

type SessionComposerModule =
  typeof import("@/components/session/SessionComposer");

/**
 * 按需加载输入框那一 chunk。
 *
 * 输入框背后是 TipTap，整块不小，而它有两个入口：会话详情、以及「还没发第一句」
 * 的草稿。两处走同一只 hook，不是各自 `import()` 一遍 —— 同一份模块被两个动态
 * import 引用会被打成两个 chunk。
 *
 * 存的是**模块**而不是组件本身：组件从 hook 里出来会被
 * `react-hooks/static-components` 拦下（它看不出这个身份一旦加载就不再变），
 * 而 `<mod.default>` 是成员访问，规则不会误判。
 */
export function useSessionComposerModule(): SessionComposerModule | null {
  const [mod, setMod] = useState<SessionComposerModule | null>(null);
  useAliveEffect((alive) => {
    void import("@/components/session/SessionComposer").then((m) => {
      if (alive()) setMod(m);
    });
  }, []);
  return mod;
}
