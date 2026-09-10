/**
 * 通行密钥在**这个浏览器、这个源**上能不能用；不能的话是哪一种不能。
 *
 * 分两种是因为补救办法相反：`unsupported` 要换浏览器，`insecure-origin` 要把站点
 * 换成 https —— 后者换几个浏览器都一样。此前两处调用点各写一句
 * `"PublicKeyCredential" in window`，只答得出「不能」，于是账号页对着一个完全支持
 * 通行密钥的浏览器说「这个浏览器不支持，换用较新的 Chrome、Safari 或 Edge」。
 *
 * `PublicKeyCredential` 与 `navigator.credentials` 在规范里都带 `[SecureContext]`：
 * 非安全上下文里它们不是「存在但报错」，而是整个不存在，于是特性探测把「源信不过」
 * 误读成「浏览器太老」。本站有时用 http 提供（如 `http://coding.local:8443`），
 * 那正是非安全上下文。同源同浏览器的对照实测：
 *   `http://<lan-ip>:7391/`  → isSecureContext=false，PublicKeyCredential 不存在
 *   `http://127.0.0.1:7391/` → isSecureContext=true，PublicKeyCredential 存在
 *
 * 仍按决策 17 只做特性探测，不猜浏览器版本。
 */
export type PasskeySupport = "available" | "insecure-origin" | "unsupported";

export function passkeySupport(): PasskeySupport {
  if (typeof window === "undefined") return "unsupported";
  // API 在场就说明这个源已经够格了 —— 这一条比 isSecureContext 说什么更硬。
  // 判真值而不是 `in`：键在、值是 undefined 的构造器谁也调不动（两处调用点此前
  // 一处用 `in`、一处用真值，统一到严的那一边）。
  if (window.PublicKeyCredential) return "available";
  // 只在它**明说** false 时才指认源。老浏览器和 jsdom 上它可能压根不存在，
  // 拿不准时保持旧口径，不去凭空指控部署方式。
  return window.isSecureContext === false ? "insecure-origin" : "unsupported";
}
