import { api } from "@/lib/api";

/**
 * 登出并落地登录页。用户菜单的「登出」与授权确认屏的「换个账号」是同一件事，
 * 只差登录完回到哪儿（`next`）。
 *
 * 无论端点调用成败都落地登录页：会话大概率已经失效，留在受保护页面上假装还登录着
 * 才是真正的假象。catch 吞掉失败，避免留下未处理的 rejection。
 */
export function signOut(next?: string): void {
  const landing = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  void api("/v1/auth/logout", { method: "POST" })
    .catch(() => {})
    .finally(() => {
      window.location.assign(landing);
    });
}
