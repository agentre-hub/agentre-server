/**
 * 随机标识：中继身份、Pi 的这一代身份、插话的 queuedId、失败气泡的行标识都用它。
 *
 * **不能直接调 `crypto.randomUUID`。** 它在规范里带 `[SecureContext]`，只在安全上下文
 * （https 或 localhost）里存在；本站是用 http 部署的（如 `http://coding.local:8443`），
 * 那里 `crypto.randomUUID` 是 undefined，调用直接抛 TypeError。2026-08-30 它就抛在
 * 派发逻辑里，被草稿页当成兜底错误、对着一台连得上的机器说「连不上 coding，请重试」。
 *
 * `crypto.getRandomValues` 没有这层门槛，http 上照常可用，所以退到它：拿的是同样
 * 128 位的密码学随机，只是不排成 UUID 的形状 —— 这几处要的本来就只是「不重样」。
 *
 * 这一条由 eslint 的 `no-restricted-syntax` 守着（见 eslint-rules/secure-context.js），
 * 豁免只有这个文件。
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
