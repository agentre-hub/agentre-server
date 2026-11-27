import { Fragment, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import { ServerUnreachable } from "@/components/ServerUnreachable";
import { useMe } from "@/hooks/use-me";

/**
 * 受保护页的闸门（规格 2026-11-25 决策 A3）：
 *
 * - 有身份（本地的或刚确认的）就放行，不等核对；核对失败的「网络不稳定」细条归外壳画。
 * - 只有 401（`signedOut`，本地此时已清空）才去登录页，并带上原地址。
 * - 没有身份又取不到：整屏「连不上服务器」，取到即进入。
 *
 * 子树按账号 id 挂：身份换成另一个账号时整棵重挂，上一个账号留在组件状态里的东西
 * 跟着一起丢掉。
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const loc = useLocation();
  const { me, status, attempt, inFlight, retry } = useMe();
  if (status === "signedOut") {
    const next = encodeURIComponent(loc.pathname + loc.search);
    window.location.replace(`/login?next=${next}`);
    return null;
  }
  if (me) return <Fragment key={me.user_id}>{children}</Fragment>;
  if (status === "unreachable") {
    return (
      <ServerUnreachable
        attempt={attempt}
        inFlight={inFlight}
        onRetry={retry}
      />
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center px-4 text-muted-foreground">
      {t("common.loading")}
    </div>
  );
}
