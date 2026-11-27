import { abandonMe } from "@/hooks/use-me";
import { api } from "@/lib/api";
import { wipeBusinessData } from "@/lib/localStore";

/**
 * 登出并落地登录页。用户菜单的「登出」与授权确认屏的「换个账号」是同一件事，
 * 只差登录完回到哪儿（`next`）。
 *
 * 本机不留这个账号的任何业务数据（规格 2026-11-25 决策 A2）：登出请求一发出去就清空
 * 本地，等两件都落定再跳——跳转会打断还没提交的清空。顺序不能反：清空会抹掉 CSRF
 * 副本，而 `api()` 是在发出请求的那一刻（同步地）把 token 放进请求头的。
 *
 * 无论端点调用成败都落地登录页：会话大概率已经失效，留在受保护页面上假装还登录着
 * 才是真正的假象。失败被吞掉，避免留下未处理的 rejection。
 */
export function signOut(next?: string): void {
  abandonMe();
  const landing = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  const logout = api("/v1/auth/logout", { method: "POST" }).catch(() => {});
  void Promise.all([logout, wipeBusinessData()]).finally(() => {
    window.location.assign(landing);
  });
}
